/**
 * broker-main.ts — daemon entry for the xfer broker (goal 014 task 024).
 *
 * Serves the broker's localhost surface that the web-picker page talks to:
 *
 *   - GET /status        → JSON {ok, port, version, clients, startedAt}
 *   - GET anything else  → 404
 *   - WS  /ws            → RFC 6455 (ws-server.ts subset); first frame MUST be
 *                          `hello`, answered with `welcome{broker:{version}}`;
 *                          any frame before hello → error{auth_failed} (nothing
 *                          is actually authenticated — localhost-trust model —
 *                          the branch is kept for protocol compat).
 *   - annotation.submit → validates {prompt, picks, target}, writes the handoff
 *                          doc (os.tmpdir()/pi-xfer-<msg_id>.md, 0600), pushes an
 *                          xfer-notify frame to <xfer-dir>/<target>.sock, then
 *                          acks {handoff_id, doc} or errors (invalid_payload,
 *                          bad_target, target_not_found, delivery_failed).
 *   - targets.list      → targets.result with listTargets(<xfer-dir>).
 *
 * After a successful bind it writes `<xfer-dir>/broker.pid` and
 * `<xfer-dir>/broker.json` {port, pid, startedAt, version} atomically (tmp +
 * rename, mode 0600, same pattern as state.ts) and deletes both on clean exit
 * (SIGTERM/SIGINT). EADDRINUSE consults broker.pid: an alive pid → "already
 * running" on stdout, exit 0; a dead/stale pid → unlink both files, retry the
 * bind once, and exit 1 if that still fails.
 *
 * Zero dependencies: node:* + ./ws-server.js + ./constants.js only. Runs
 * directly (`node broker-main.ts [--port N] [--xfer-dir DIR]`); also exports
 * its pieces for in-process embedding and future unit tests.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ACK_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES, XFER_DIR } from "./constants.js";
import { renderHandoffDoc, type HandoffPick } from "./handoff-doc.js";
import { listTargets } from "./targets.js";
import { encodeAgentName } from "./utils.js";
import { attachWsServer, type WsConnection } from "./ws-server.js";

/** Broker software version (welcome + /status + broker.json). */
export const VERSION = "0.1.0";
/** Protocol revision spoken on the wire (v0, per the mock protocol oracle). */
const PROTOCOL_VERSION = 0;

// Wire frame types (v0) — one place; handlers reference these, never raw literals.
const WIRE_HELLO = "hello";
const WIRE_WELCOME = "welcome";
const WIRE_ERROR = "error";
const WIRE_ACK = "ack";
const WIRE_ANNOTATION_SUBMIT = "annotation.submit";
const WIRE_TARGETS_LIST = "targets.list";
const WIRE_TARGETS_RESULT = "targets.result";
const WIRE_PAGE_REQUEST = "page.request";
const WIRE_PAGE_RESPONSE = "page.response";
const WIRE_XFER_NOTIFY = "xfer-notify";
const WIRE_MSG_ID_PREFIX = "m";
const WIRE_NAMESPACE_LOCAL = "local";
const WIRE_FROM_WEB_PICKER = "web-picker";

// Error codes (mock protocol oracle).
const ERR_AUTH_FAILED = "auth_failed";
const ERR_INVALID_PAYLOAD = "invalid_payload";
const ERR_BAD_TARGET = "bad_target";
const ERR_TARGET_NOT_FOUND = "target_not_found";
const ERR_DELIVERY_FAILED = "delivery_failed";
const ERR_UNSUPPORTED_VERSION = "unsupported_version";

const DEFAULT_PORT = 4719;
const HOST = "127.0.0.1";

/** One open tab: whatever `hello.client.tab` carried (id/url/title). */
export interface TabInfo {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  [key: string]: unknown;
}

/** Raw inbound frame (v0 wire shape: {v, type, id, ...}). */
export interface Frame {
  v?: unknown;
  type?: unknown;
  id?: unknown;
  [key: string]: unknown;
}

export interface BrokerOptions {
  port: number;
  xferDir: string;
}

export interface BrokerHandle {
  server: http.Server;
  /** Actual bound port (resolves ephemeral `port: 0` to the real one). */
  port: number;
  startedAt: string;
  /** Currently welcomed tab connections. */
  conns: ReadonlyMap<WsConnection, TabInfo>;
  close(): Promise<void>;
}

/** CLI/env argument parsing: --port > BROKER_PORT > 4719; --xfer-dir > XFER_DIR > ~/.pi/xfer. */
export function parseArgs(argv: string[]): BrokerOptions {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
  };
  const portRaw = flag("--port") ?? process.env.BROKER_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portRaw, 10);
  const xferDir = flag("--xfer-dir") ?? process.env.XFER_DIR ?? XFER_DIR;
  return { port, xferDir };
}

/** Is `pid` a live process? EPERM (exists, other user) counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** tmp + rename, mode 0600 — the state.ts writeMetadata pattern. */
function writeFileAtomic(filePath: string, content: string): void {
  const temp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function readPidFile(xferDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function unlinkBrokerFiles(xferDir: string): void {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs.unlinkSync(path.join(xferDir, name));
    } catch {
      /* already gone */
    }
  }
}

function writeBrokerFiles(xferDir: string, port: number, startedAt: string): void {
  writeFileAtomic(path.join(xferDir, "broker.pid"), `${process.pid}\n`);
  writeFileAtomic(
    path.join(xferDir, "broker.json"),
    `${JSON.stringify({ port, pid: process.pid, startedAt, version: VERSION }, null, 2)}\n`,
  );
}

// ---------- WS protocol ----------

function frameId(frame: Frame): string | number | null {
  return typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : null;
}

function sendError(connection: WsConnection, frame: Frame, code: string, message: string): void {
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_ERROR, id: frameId(frame), code, message });
}

function tabFromFrame(frame: Frame): TabInfo {
  const client = frame.client;
  const tab = typeof client === "object" && client !== null ? (client as { tab?: unknown }).tab : undefined;
  return typeof tab === "object" && tab !== null ? (tab as TabInfo) : {};
}

/** Stub handlers for frames still owned by later tasks; they log and stay silent on the wire. */
function notImplemented(type: string): (connection: WsConnection, frame: Frame) => void {
  return () => console.log(`[broker] handler not yet implemented: ${type}`);
}

type FrameHandler = (connection: WsConnection, frame: Frame) => void;

/**
 * Dispatch table for post-hello frames, rebuilt per broker instance so handlers
 * are bound to that instance's xfer dir (assigned in startBroker).
 */
let frameHandlers: Record<string, FrameHandler> = {};

/** msg_id scheme mirroring the mock broker: prefix + base36 timestamp + base36 counter. */
let submitSeq = 0;
function nextMsgId(): string {
  return `${WIRE_MSG_ID_PREFIX}${Date.now().toString(36)}${(submitSeq++).toString(36)}`;
}

/**
 * xfer-notify push, modeled on client.ts's house sendNotify (one JSON line,
 * matching ack ≤ ACK_TIMEOUT_MS) but bound to the broker's own xfer dir — the
 * module-level XFER_DIR constant points at ~/.pi/xfer, not the daemon's dir.
 * A missing socket rejects with code target_not_found; any other failure with
 * delivery_failed. The caller owns the handoff doc and keeps it either way.
 */
function pushXferNotify(
  xferDir: string,
  target: string,
  msg: { type: string; msg_id: string; [key: string]: unknown },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const endpoint = path.join(xferDir, `${encodeAgentName(target)}.sock`);
    if (!fs.existsSync(endpoint)) {
      reject(Object.assign(new Error(`peer "${target}" not found`), { code: ERR_TARGET_NOT_FOUND }));
      return;
    }
    const sock = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    let ackTimer: NodeJS.Timeout | null = null;
    const connectTimer = setTimeout(() => finish(new Error("connect timeout")), CONNECT_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (ackTimer) clearTimeout(ackTimer);
      if (error) {
        sock.destroy();
        reject(Object.assign(error, { code: ERR_DELIVERY_FAILED }));
      } else {
        sock.end();
        resolve();
      }
    };

    sock.on("connect", () => {
      clearTimeout(connectTimer);
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ackTimer = setTimeout(() => finish(new Error("ack timeout")), ACK_TIMEOUT_MS);
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf-8") > MAX_FRAME_BYTES) {
        finish(new Error("ack frame too large"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let response: unknown;
        try {
          response = JSON.parse(line);
        } catch {
          finish(new Error("invalid ack"));
          return;
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          finish(new Error("invalid ack"));
          return;
        }
        const ack = response as { type?: unknown; msg_id?: unknown };
        if (ack.type === WIRE_ACK && ack.msg_id === msg.msg_id) {
          finish();
          return;
        }
      }
    });

    sock.on("error", (error) => finish(error));
    sock.on("close", () => {
      if (!settled) finish(new Error("peer closed before ack"));
    });
  });
}

function handleAnnotationSubmit(connection: WsConnection, frame: Frame, xferDir: string): void {
  const id = frameId(frame);
  const prompt = frame.prompt;
  const picks = frame.picks;
  const target =
    typeof frame.target === "object" && frame.target !== null ? (frame.target as Record<string, unknown>) : null;

  // v0 contract: prompt non-empty string, picks array, target.name non-empty string.
  const missing: string[] = [];
  if (typeof prompt !== "string" || prompt.trim() === "") missing.push("prompt");
  if (!Array.isArray(picks)) missing.push("picks");
  const targetName = target?.name;
  if (typeof targetName !== "string" || targetName.trim() === "") missing.push("target.name");
  if (missing.length > 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `missing or invalid: ${missing.join(", ")}`);
    return;
  }

  const namespace = target?.namespace;
  if (namespace !== undefined && namespace !== WIRE_NAMESPACE_LOCAL) {
    sendError(connection, frame, ERR_BAD_TARGET, `namespace "${String(namespace)}" out of scope (v0: local only)`);
    return;
  }

  const msgId = nextMsgId();
  const doc = path.join(os.tmpdir(), `pi-xfer-${msgId}.md`);
  const pageRaw = typeof frame.page === "object" && frame.page !== null ? (frame.page as Record<string, unknown>) : {};
  const page = {
    url: typeof pageRaw.url === "string" ? pageRaw.url : "",
    title: typeof pageRaw.title === "string" ? pageRaw.title : "",
    ts: typeof pageRaw.ts === "number" ? pageRaw.ts : Date.now(),
  };
  let content: string;
  try {
    content = renderHandoffDoc({ msgId, prompt, page, picks: picks as HandoffPick[] });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed picks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    fs.writeFileSync(doc, content, { mode: 0o600 });
  } catch (error) {
    sendError(connection, frame, ERR_DELIVERY_FAILED, `cannot write doc: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log(`[doc] ${doc} (${picks.length} picks → local:${targetName})`);

  void pushXferNotify(xferDir, targetName, {
    type: WIRE_XFER_NOTIFY,
    msg_id: msgId,
    from: WIRE_FROM_WEB_PICKER,
    file: doc,
    summary: prompt.slice(0, 120),
  })
    .then(() => {
      connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id, result: { handoff_id: msgId, doc } });
      console.log(`[xfer] delivered to ${targetName}`);
    })
    .catch((error: unknown) => {
      const code =
        (error as { code?: unknown }).code === ERR_TARGET_NOT_FOUND ? ERR_TARGET_NOT_FOUND : ERR_DELIVERY_FAILED;
      const message = error instanceof Error ? error.message : String(error);
      sendError(connection, frame, code, message);
      console.log(`[xfer] FAILED: ${message} (doc kept at ${doc})`);
    });
}

function handleTargetsList(connection: WsConnection, frame: Frame, xferDir: string): void {
  const targets = listTargets(xferDir);
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_TARGETS_RESULT, id: frameId(frame), targets });
  console.log(`[targets] ${targets.length} live local target(s)`);
}

/** Handlers bound to one broker instance's xfer dir (assigned by startBroker). */
function buildFrameHandlers(xferDir: string): Record<string, FrameHandler> {
  return {
    [WIRE_ANNOTATION_SUBMIT]: (connection, frame) => handleAnnotationSubmit(connection, frame, xferDir),
    [WIRE_TARGETS_LIST]: (connection, frame) => handleTargetsList(connection, frame, xferDir),
    [WIRE_PAGE_REQUEST]: notImplemented(WIRE_PAGE_REQUEST),
    [WIRE_PAGE_RESPONSE]: notImplemented(WIRE_PAGE_RESPONSE),
  };
}

/**
 * One inbound text frame. hello registers the connection and replies welcome;
 * anything before hello → error{auth_failed}; unknown types after hello →
 * error{unsupported_version}.
 */
export function handleFrame(
  connection: WsConnection,
  raw: unknown,
  conns: Map<WsConnection, TabInfo>,
): void {
  if (typeof raw !== "object" || raw === null) return;
  const frame = raw as Frame;

  if (frame.type === WIRE_HELLO) {
    if (conns.has(connection)) return; // already welcomed — ignore duplicates
    const tab = tabFromFrame(frame);
    conns.set(connection, tab);
    connection.send({ v: PROTOCOL_VERSION, type: WIRE_WELCOME, broker: { version: VERSION } });
    console.log(`[ws] hello: tab "${tab.title ?? "?"}" (${tab.url ?? "?"})`);
    return;
  }

  if (!conns.has(connection)) {
    // Nothing to authenticate (localhost-trust; 127.0.0.1 bind only) — the
    // branch is kept for protocol compatibility with the page client.
    sendError(connection, frame, ERR_AUTH_FAILED, "hello first");
    return;
  }

  if (typeof frame.type !== "string") return; // untyped frames are ignored
  const handler = frameHandlers[frame.type];
  if (handler) {
    handler(connection, frame);
    return;
  }
  sendError(connection, frame, ERR_UNSUPPORTED_VERSION, `unknown frame type ${frame.type}`);
}

// ---------- lifecycle ----------

/** Bind + attach WS + write pid/json. Rejects with the raw listen error (EADDRINUSE etc.). */
export async function startBroker(options: BrokerOptions): Promise<BrokerHandle> {
  const conns = new Map<WsConnection, TabInfo>();
  frameHandlers = buildFrameHandlers(options.xferDir);
  const startedAt = new Date().toISOString();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (url.pathname === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, port: boundPort(), version: VERSION, clients: conns.size, startedAt }),
      );
      return;
    }
    response.writeHead(404).end();
  });

  attachWsServer(server, {
    // Connections enter the registry on hello (not on the raw upgrade).
    onConnection: () => {},
    onMessage: (connection, message) => handleFrame(connection, message, conns),
    onClose: (connection) => {
      conns.delete(connection);
      console.log(`[ws] tab disconnected (${conns.size} remaining)`);
    },
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port, HOST, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const port = boundPort();
  fs.mkdirSync(options.xferDir, { recursive: true, mode: 0o700 });
  writeBrokerFiles(options.xferDir, port, startedAt);

  function boundPort(): number {
    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === "string") {
      throw new Error("broker: server not bound to a TCP port");
    }
    return address.port;
  }

  return {
    server,
    port,
    startedAt,
    conns,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const connection of conns.keys()) connection.close(1001);
        server.close(() => resolve());
      });
    },
  };
}

/** CLI entry: parse args, handle EADDRINUSE, install clean-exit handlers. */
export async function main(): Promise<void> {
  const { port, xferDir } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[broker] invalid port: ${port}`);
    process.exit(1);
  }

  let handle: BrokerHandle;
  try {
    handle = await startBroker({ port, xferDir });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      console.error(`[broker] bind failed: ${(error as Error).message}`);
      process.exit(1);
    }
    // Port taken: is it our own broker? broker.pid decides.
    const existingPid = readPidFile(xferDir);
    if (existingPid !== null && pidAlive(existingPid)) {
      console.log("already running");
      process.exit(0);
    }
    // Stale (or missing) pid file: clear it and retry the bind once.
    unlinkBrokerFiles(xferDir);
    try {
      handle = await startBroker({ port, xferDir });
    } catch (retryError) {
      console.error(`[broker] bind failed: ${(retryError as Error).message}`);
      process.exit(1);
    }
  }

  console.log(`[broker] listening on ${HOST}:${handle.port} (pid ${process.pid}, xfer-dir ${xferDir})`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    unlinkBrokerFiles(xferDir);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run as a daemon only when executed directly (not when imported by tests).
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[broker] fatal: ${(error as Error).message}`);
    process.exit(1);
  });
}
