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
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { XFER_DIR } from "./constants.js";
import { attachWsServer, type WsConnection } from "./ws-server.js";

/** Broker software version (welcome + /status + broker.json). */
export const VERSION = "0.1.0";
/** Protocol revision spoken on the wire (v0, per the mock protocol oracle). */
const PROTOCOL_VERSION = 0;
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
  connection.send({ v: PROTOCOL_VERSION, type: "error", id: frameId(frame), code, message });
}

function tabFromFrame(frame: Frame): TabInfo {
  const client = frame.client;
  const tab = typeof client === "object" && client !== null ? (client as { tab?: unknown }).tab : undefined;
  return typeof tab === "object" && tab !== null ? (tab as TabInfo) : {};
}

/** Stub handlers land in later tasks; for now they log and stay silent on the wire. */
function notImplemented(type: string): (connection: WsConnection, frame: Frame) => void {
  return () => console.log(`[broker] handler not yet implemented: ${type}`);
}

/** Dispatch table, ready for later handlers (annotation.submit, targets.list, page.*). */
const frameHandlers: Record<string, (connection: WsConnection, frame: Frame) => void> = {
  "annotation.submit": notImplemented("annotation.submit"),
  "targets.list": notImplemented("targets.list"),
  "page.request": notImplemented("page.request"),
  "page.response": notImplemented("page.response"),
};

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

  if (frame.type === "hello") {
    if (conns.has(connection)) return; // already welcomed — ignore duplicates
    const tab = tabFromFrame(frame);
    conns.set(connection, tab);
    connection.send({ v: PROTOCOL_VERSION, type: "welcome", broker: { version: VERSION } });
    console.log(`[ws] hello: tab "${tab.title ?? "?"}" (${tab.url ?? "?"})`);
    return;
  }

  if (!conns.has(connection)) {
    // Nothing to authenticate (localhost-trust; 127.0.0.1 bind only) — the
    // branch is kept for protocol compatibility with the page client.
    sendError(connection, frame, "auth_failed", "hello first");
    return;
  }

  if (typeof frame.type !== "string") return; // untyped frames are ignored
  const handler = frameHandlers[frame.type];
  if (handler) {
    handler(connection, frame);
    return;
  }
  sendError(connection, frame, "unsupported_version", `unknown frame type ${frame.type}`);
}

// ---------- lifecycle ----------

/** Bind + attach WS + write pid/json. Rejects with the raw listen error (EADDRINUSE etc.). */
export async function startBroker(options: BrokerOptions): Promise<BrokerHandle> {
  const conns = new Map<WsConnection, TabInfo>();
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
