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
   *   - annotation.compose → render-only twin: the same handoff doc returned in
   *                          the ack as {prompt} (no write, no notify) for the
   *                          web picker's copy-prompt flow.
 *   - page.request/page.response — reverse tool channel: routePageTool()
 *                          broadcasts a tool call {tool:{op, params}} (MCP-style
 *                          fixed op table — no free-form code) to every welcomed
 *                          tab; the first matching page.response resolves it; a
 *                          timeout (default 30s, BROKER_PAGE_TIMEOUT_MS/env +
 *                          per-call override) or no connected tabs resolve as
 *                          {ok:false, error}. POST /page-tool waits for the
 *                          outcome and returns it in the HTTP response — no
 *                          answer docs, no notify (the human-ask flow was
 *                          removed: agents confirm with the user in their own
 *                          session, not on the page).
 *
 * After a successful bind it writes `<xfer-dir>/broker.pid` and
 * `<xfer-dir>/broker.json` {port, pid, startedAt, version} atomically (tmp +
 * rename, mode 0600, same pattern as state.ts) and deletes both on clean exit
 * (SIGTERM/SIGINT). EADDRINUSE consults broker.pid: an alive pid → "already
 * running" on stdout, exit 0; a dead/stale pid (none of our brokers is up) →
 * unlink both files and fall back to an ephemeral port (0) with a warning on
 * stderr, so a foreign program squatting the configured port cannot wedge or
 * masquerade as the broker. The real port always lands in broker.json.
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
import { ACK_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_FRAME_BYTES, XFER_DIR } from "./src/core/constants.ts";
import { ERR, FROM_WEB_PICKER, WIRE } from "./src/core/wire.ts";
import { renderBagHandoffDoc, renderHandoffDoc, type HandoffPick, type HandoffRecord } from "./src/core/handoff-doc.ts";
import { createMeshDescriber } from "./src/mesh/mesh-describer.ts";
import { listTargetsWithDescriptions } from "./src/core/targets.ts";
import { encodeAgentName, isEntryPoint } from "./src/core/utils.ts";
import { attachWsServer, type WsConnection } from "./src/broker/ws-server.ts";
import { WIRE_VERSION } from "./src/core/wire.ts";

/** Broker software version (welcome + /status + broker.json), from package.json. */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8")) as { version?: string }).version ?? "?";
  } catch {
    return "?";
  }
})();
/** Protocol revision spoken on the wire (v0, per the mock protocol oracle). */
const PROTOCOL_VERSION = WIRE_VERSION;

// Wire frame types + error codes — defined once in wire.ts (the same module
// web-picker.src/wire.js bundles into the userscript), aliased here so the
// handler code keeps its historical names. xfer-notify is the unix-socket
// notification to peer agents, not a WS frame; msg-id prefix + from-tag stay local.
const {
  KIND_HELLO: WIRE_HELLO,
  KIND_WELCOME: WIRE_WELCOME,
  KIND_ERROR: WIRE_ERROR,
  KIND_ACK: WIRE_ACK,
  KIND_SUBMIT: WIRE_ANNOTATION_SUBMIT,
  KIND_COMPOSE: WIRE_ANNOTATION_COMPOSE,
  KIND_STAGE: WIRE_STAGE,
  KIND_BAG_LIST: WIRE_BAG_LIST,
  KIND_BAG_SUBMIT: WIRE_BAG_SUBMIT,
  KIND_TARGETS_LIST: WIRE_TARGETS_LIST,
  KIND_TARGETS_RESULT: WIRE_TARGETS_RESULT,
  KIND_PAGE_REQUEST: WIRE_PAGE_REQUEST,
  KIND_PAGE_RESPONSE: WIRE_PAGE_RESPONSE,
  NS_LOCAL: WIRE_NAMESPACE_LOCAL,
} = WIRE;
const WIRE_XFER_NOTIFY = "xfer-notify";
const WIRE_MSG_ID_PREFIX = "m";

const {
  AUTH_FAILED: ERR_AUTH_FAILED,
  INVALID_PAYLOAD: ERR_INVALID_PAYLOAD,
  BAD_TARGET: ERR_BAD_TARGET,
  TARGET_NOT_FOUND: ERR_TARGET_NOT_FOUND,
  MISSING_TAB: ERR_MISSING_TAB,
  TAB_UNREACHABLE: ERR_TAB_UNREACHABLE,
  DELIVERY_FAILED: ERR_DELIVERY_FAILED,
  UNSUPPORTED_VERSION: ERR_UNSUPPORTED_VERSION,
} = ERR;

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


type FrameHandler = (connection: WsConnection, frame: Frame) => void;

/**
 * Dispatch table for post-hello frames, rebuilt per broker instance so handlers
 * are bound to that instance's xfer dir (assigned in startBroker).
 */
let frameHandlers: Record<string, FrameHandler> = {};

/** Tab registry of the most recently started broker instance (mirrors frameHandlers). */
let activeConns: Map<WsConnection, TabInfo> | null = null;

/** msg_id scheme mirroring the mock broker: prefix + base36 timestamp + base36 counter. */
let submitSeq = 0;
function nextMsgId(): string {
  return `${WIRE_MSG_ID_PREFIX}${Date.now().toString(36)}${(submitSeq++).toString(36)}`;
}

/** Same base36 scheme as msg ids, but with the `r` prefix (mock broker's nextId("r")). */
function nextRequestId(): string {
  return `r${Date.now().toString(36)}${(submitSeq++).toString(36)}`;
}


/**
 * xfer-notify push, modeled on client.ts's house sendNotify (one JSON line,
 * matching ack ≤ ACK_TIMEOUT_MS) but bound to the broker's own xfer dir — the
 * module-level XFER_DIR constant points at ~/.pi/xfer, not the daemon's dir.
 * A missing socket rejects with code target_not_found; any other failure with
 * delivery_failed. The ack's `outcome` field is deliberately not interpreted here:
 * the broker's own ack to the browser is a different vocabulary, and reading the
 * receiver's field as `delivered` on absence would invent a claim.
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
  const record = parseRecord(frame.record);
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
  if (record === null && frame.record !== undefined) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "malformed record: expected {id, start, events:[{seq,t,kind}...]}");
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
    content = renderHandoffDoc({
      msgId,
      prompt,
      page,
      picks: picks as HandoffPick[],
      record: record ?? undefined,
      // The receiving session's own xfer name: makes the doc's page-tool
      // follow-up command directly runnable (compose passes it too — the two
      // render paths must not drift).
      fromTarget: targetName,
      brokerCliPath: path.join(import.meta.dirname, "broker-main.ts"),
    });
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
  console.log(`[doc] ${doc} (${picks.length} picks${record ? ` + record ${record.id} (${record.events.length} events)` : ""} → local:${targetName})`);
  latestHandoffByTarget.set(targetName, msgId); // the doc exists → page.requests can reference it
  // ADR-0022: the ack carries the originating tabId; the agent passes it back
  // as --tab on every follow-up page-tool call. No latest-tab guess is kept.
  const submittingTab = activeConns?.get(connection);
  const routedTabId = submittingTab && typeof submittingTab.id === "string" ? submittingTab.id : undefined;

  void pushXferNotify(xferDir, targetName, {
    type: WIRE_XFER_NOTIFY,
    msg_id: msgId,
    from: FROM_WEB_PICKER,
    file: doc,
    summary: prompt.slice(0, 120),
  })
    .then(() => {
      connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id, result: { handoff_id: msgId, doc, ...(routedTabId !== undefined ? { routedTabId } : {}) } });
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

/**
 * annotation.compose — render-only twin of annotation.submit: the same handoff
 * doc (renderHandoffDoc, incl. the broker-only bits: brokerCliPath, follow-up
 * channel section) returned in the ack as `result.prompt`, but no file write,
 * no xfer-notify, no latestHandoffByTarget registration. The web picker uses
 * it for the "copy prompt" flow so a non-pi agent (bash-only) gets the exact
 * document a delivered handoff would carry. Target is optional: it only
 * substitutes into the page-tool example as `fromTarget`.
 */
function handleAnnotationCompose(connection: WsConnection, frame: Frame): void {
  const id = frameId(frame);
  const prompt = frame.prompt;
  const picks = frame.picks;
  const record = parseRecord(frame.record);

  const missing: string[] = [];
  if (typeof prompt !== "string" || prompt.trim() === "") missing.push("prompt");
  if (!Array.isArray(picks)) missing.push("picks");
  if (missing.length > 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `missing or invalid: ${missing.join(", ")}`);
    return;
  }
  if (record === null && frame.record !== undefined) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "malformed record: expected {id, start, events:[{seq,t,kind}...]}");
    return;
  }

  const target =
    typeof frame.target === "object" && frame.target !== null ? (frame.target as Record<string, unknown>) : null;
  const targetName = typeof target?.name === "string" && target.name.trim() !== "" ? target.name : undefined;

  const msgId = nextMsgId();
  const pageRaw = typeof frame.page === "object" && frame.page !== null ? (frame.page as Record<string, unknown>) : {};
  let content: string;
  try {
    content = renderHandoffDoc({
      msgId,
      prompt,
      page: {
        url: typeof pageRaw.url === "string" ? pageRaw.url : "",
        title: typeof pageRaw.title === "string" ? pageRaw.title : "",
        ts: typeof pageRaw.ts === "number" ? pageRaw.ts : Date.now(),
      },
      picks: picks as HandoffPick[],
      record: record ?? undefined,
      fromTarget: targetName,
      brokerCliPath: path.join(import.meta.dirname, "broker-main.ts"),
    });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed picks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id, result: { prompt: content } });
  console.log(`[compose] rendered handoff preview ${msgId} (${(picks as unknown[]).length} picks${record ? ` + record ${record.id}` : ""}${targetName ? ` → local:${targetName}` : ""}, not delivered)`);
}

// Optional `record` field (v1.13): undefined = absent (pick-only submit);
// null = present but malformed (caller answers invalid_payload); otherwise a
// minimally-normalized HandoffRecord. Deep field sanitization is the
// renderer's job — here we only gate the structural minimum.
function parseRecord(raw: unknown): HandoffRecord | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.start !== "number") return null;
  if (!Array.isArray(r.events)) return null;
  if (!r.events.every((ev) => typeof ev === "object" && ev !== null &&
    typeof (ev as Record<string, unknown>).seq === "number" &&
    typeof (ev as Record<string, unknown>).t === "number" &&
    typeof (ev as Record<string, unknown>).kind === "string")) return null;
  return raw as HandoffRecord;
}

/**
 * The picker's pre-send query. Targets carry an optional self-declared mesh
 * description so a human can pick a node by capability; an unreachable actor
 * (or no mesh at all) simply omits the field — it never fails the listing.
 */
async function handleTargetsList(connection: WsConnection, frame: Frame, xferDir: string): Promise<void> {
  const describe = createMeshDescriber(path.join(xferDir, "mesh.config.json"));
  const targets = await listTargetsWithDescriptions(xferDir, describe);
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_TARGETS_RESULT, id: frameId(frame), targets });
  const described = targets.filter((t) => t.description).length;
  console.log(`[targets] ${targets.length} live local target(s), ${described} with a description`);
}

// ---------- reverse channel: page.request / page.response ----------

/** Outcome of one page.request — what the page-tool CLI/HTTP layer reports. */
export interface PageResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** A page tool call: one fixed op + optional params (MCP-style, no free-form code). */
export interface PageTool {
  op: string;
  params?: Record<string, unknown>;
}

/** Default page tool timeout; overridable per call and via BROKER_PAGE_TIMEOUT_MS. */
export const DEFAULT_PAGE_TIMEOUT_MS = 30_000;

/** Latest handoff doc id delivered to each asking target (page.request handoff_id). */
const latestHandoffByTarget = new Map<string, string>();

/** Live tab id → connection.hello registration map (module-level, mirrors activeConns). */
let tabConns: Map<string, WsConnection> | null = null;

// ---------- staging bag (web picker cross-page staging, ADR-glossed in CONTEXT.md) ----------

/** One Staged marker: a pick plus the Provenance of the tab that captured it. */
export interface StagedMarker {
  id: string;
  tabId: string;
  origin: string;
  url: string;
  title: string;
  pick: HandoffPick;
  ts: number;
}

/** The one default Bag: broker-lifetime, in memory, consumed by bag.submit. */
let bag: StagedMarker[] = [];

let stageSeq = 0;
function nextStageId(): string {
  return `s${Date.now().toString(36)}${(stageSeq++).toString(36)}`;
}

/** Parse the provenance + pick payload of annotation.stage; null when malformed. */
function parseStagePayload(frame: Frame): Omit<StagedMarker, "id"> | null {
  const pick = frame.pick;
  if (typeof pick !== "object" || pick === null || Array.isArray(pick)) return null;
  const p = pick as Record<string, unknown>;
  if (typeof p.selector !== "string" || p.selector === "") return null;
  if (typeof p.xpath !== "string" || typeof p.rect !== "object" || p.rect === null) return null;
  const page = typeof frame.page === "object" && frame.page !== null ? (frame.page as Record<string, unknown>) : {};
  const tabId = typeof page.tabId === "string" && page.tabId !== "" ? page.tabId : null;
  if (tabId === null) return null;
  return {
    tabId,
    origin: typeof page.origin === "string" ? page.origin : "",
    url: typeof page.url === "string" ? page.url : "",
    title: typeof page.title === "string" ? page.title : "",
    pick: pick as HandoffPick,
    ts: typeof page.ts === "number" ? page.ts : Date.now(),
  };
}

/**
 * annotation.stage — add one marker to the Bag. No dedup (glossary: repeated
 * staging creates independent entries); the broker assigns the entry id, so a
 * reconnecting picker rebuilds its view from bag.list alone.
 */
function handleAnnotationStage(connection: WsConnection, frame: Frame): void {
  const staged = parseStagePayload(frame);
  if (staged === null) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "malformed stage: expected {pick:{selector,xpath,rect...}, page:{tabId,origin,url,title,ts}}");
    return;
  }
  const entry: StagedMarker = { id: nextStageId(), ...staged };
  bag.push(entry);
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id: frameId(frame), result: { id: entry.id, count: bag.length } });
  console.log(`[bag] staged ${entry.id} [tab ${entry.tabId}] ${entry.pick.selector} (bag: ${bag.length})`);
}

/**
 * bag.list — Bag snapshot, newest first. The reply is capped at
 * BAG_LIST_MAX_ITEMS: a list frame past MAX_FRAME_BYTES would make
 * ws-server teardown the connection (encodeFrame throws → connection.send
 * tears down), which is how a few hundred staged markers turned into a
 * silent reconnect loop. `total`/`truncated` tell the picker there is more
 * than the snapshot shows.
 */
const BAG_LIST_MAX_ITEMS = 100;

function handleBagList(connection: WsConnection, frame: Frame): void {
  const ordered = bag.slice().reverse();
  const truncated = ordered.length > BAG_LIST_MAX_ITEMS;
  const items = truncated ? ordered.slice(0, BAG_LIST_MAX_ITEMS) : ordered;
  connection.send({
    v: PROTOCOL_VERSION,
    type: WIRE_ACK,
    id: frameId(frame),
    result: { items, total: bag.length, truncated },
  });
}

/** Shared validation of bag.submit's {prompt, target}; null → error already sent. */
function parseBagSubmitTarget(connection: WsConnection, frame: Frame): { prompt: string; targetName: string } | null {
  const prompt = frame.prompt;
  const target = typeof frame.target === "object" && frame.target !== null ? (frame.target as Record<string, unknown>) : null;
  const targetName = target?.name;
  const missing: string[] = [];
  if (typeof prompt !== "string" || prompt.trim() === "") missing.push("prompt");
  if (typeof targetName !== "string" || targetName.trim() === "") missing.push("target.name");
  const namespace = target?.namespace;
  if (namespace !== undefined && namespace !== WIRE_NAMESPACE_LOCAL) {
    sendError(connection, frame, ERR_BAD_TARGET, `namespace "${String(namespace)}" out of scope (v0: local only)`);
    return null;
  }
  if (missing.length > 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `missing or invalid: ${missing.join(", ")}`);
    return null;
  }
  return { prompt: prompt as string, targetName: targetName as string };
}

/**
 * bag.submit — render the whole Bag as one per-page handoff doc, deliver it to
 * the target and clear the Bag (glossary: sending consumes). A full Bag is a
 * client error: the user decides whether to send an empty bag, not us.
 */
function handleBagSubmit(connection: WsConnection, frame: Frame, xferDir: string): void {
  const parsed = parseBagSubmitTarget(connection, frame);
  if (parsed === null) return;
  const { prompt, targetName } = parsed;
  if (bag.length === 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "bag is empty");
    return;
  }
  const msgId = nextMsgId();
  const doc = path.join(os.tmpdir(), `pi-xfer-${msgId}.md`);
  let content: string;
  try {
    content = renderBagHandoffDoc({ msgId, prompt, items: bag, fromTarget: targetName, brokerCliPath: path.join(import.meta.dirname, "broker-main.ts") });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed staged markers: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    fs.writeFileSync(doc, content, { mode: 0o600 });
  } catch (error) {
    sendError(connection, frame, ERR_DELIVERY_FAILED, `cannot write doc: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log(`[bag] ${doc} (${bag.length} staged markers across ${new Set(bag.map((m) => m.tabId)).size} tab(s) → local:${targetName})`);
  latestHandoffByTarget.set(targetName, msgId);
  void pushXferNotify(xferDir, targetName, {
    type: WIRE_XFER_NOTIFY,
    msg_id: msgId,
    from: FROM_WEB_PICKER,
    file: doc,
    summary: prompt.slice(0, 120),
  })
    .then(() => {
      bag = [];
      connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id: frameId(frame), result: { handoff_id: msgId, doc, count: bag.length } });
      console.log(`[xfer] delivered to ${targetName}; bag cleared`);
    })
    .catch((error: unknown) => {
      const code = (error as { code?: unknown }).code === ERR_TARGET_NOT_FOUND ? ERR_TARGET_NOT_FOUND : ERR_DELIVERY_FAILED;
      const message = error instanceof Error ? error.message : String(error);
      sendError(connection, frame, code, message);
      console.log(`[xfer] FAILED: ${message} (doc kept at ${doc}; bag kept)`);
    });
}

/**
 * In-flight page.requests: requestId → entry. Settled entries stay put (so the
 * HTTP layer can still read the result and late responses are recognized as
 * such) until the map exceeds MAX_PENDING_PAGE_REQUESTS, when settled ones are
 * pruned.
 */
const pendingPageRequests = new Map<string, PendingPageRequest>();
const MAX_PENDING_PAGE_REQUESTS = 128;

interface PendingPageRequest {
  /** Tab connection that answered (set when a response arrives; null until then). */
  tabConn: WsConnection | null;
  /** Session the tool call is aimed at (xfer name; also the page.request `from`). */
  askingTarget: string;
  timer: NodeJS.Timeout;
  settled: boolean;
  result: Promise<PageResult>;
  resolve: (result: PageResult) => void;
}

function envPageTimeoutMs(): number {
  const raw = process.env.BROKER_PAGE_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_TIMEOUT_MS;
}

/** Resolve a pending request exactly once; keeps the entry for late-response detection. */
function settlePageRequest(requestId: string, result: PageResult): void {
  const entry = pendingPageRequests.get(requestId);
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  entry.resolve(result);
  if (pendingPageRequests.size > MAX_PENDING_PAGE_REQUESTS) {
    for (const [id, pending] of pendingPageRequests) {
      if (pendingPageRequests.size <= MAX_PENDING_PAGE_REQUESTS) break;
      if (pending.settled) pendingPageRequests.delete(id);
    }
  }
}

/**
/**
 * Route a page tool call to ONE explicit tab and register the pending request.
 * ADR-0022: routing always targets a tab — the caller passes the tabId it
 * read from the submit ack / handoff Provenance. No broadcast, no latest-tab
 * guess: a miss is a direct connect-style error (missing_tab when the caller
 * gave no tabId, tab_unreachable when the named tab is not connected), and
 * the caller stops and asks the human instead of retrying. Returns null (no
 * request created) for the immediate-error cases; the requestId otherwise.
 */
export function routePageTool(target: string, tool: PageTool, timeoutMs?: number, tabId?: string): string | null {
  if (tabId === undefined || tabId === "") {
    console.log(`[page.request] no tabId given → missing_tab (target ${target})`);
    return null;
  }
  const conn = tabConns?.get(tabId);
  if (conn === undefined || !activeConns?.has(conn)) {
    console.log(`[page.request] tab ${tabId} not connected → tab_unreachable (target ${target})`);
    return null;
  }
  const routed = [conn];
  const id = nextRequestId();
  const resolvedTimeout = timeoutMs ?? envPageTimeoutMs();
  const frame = {
    v: PROTOCOL_VERSION,
    type: WIRE_PAGE_REQUEST,
    id,
    handoff_id: latestHandoffByTarget.get(target) ?? "demo",
    from: target,
    tool,
    timeoutMs: resolvedTimeout,
  };
  let sent = 0;
  for (const conn of routed) {
    conn.send(frame);
    sent++;
  }
  console.log(
    `[page.request ${id}] → tab ${tabId}: ${tool.op} ${JSON.stringify(tool.params ?? {})} (handoff ${frame.handoff_id}, timeout ${resolvedTimeout}ms)`,
  );

  let resolve!: (result: PageResult) => void;
  const result = new Promise<PageResult>((res) => {
    resolve = res;
  });
  const entry: PendingPageRequest = {
    tabConn: null,
    askingTarget: target,
    settled: false,
    result,
    resolve,
    timer: setTimeout(() => settlePageRequest(id, { ok: false, error: "timeout" }), resolvedTimeout),
  };
  // Do not keep the daemon alive just for an unanswered page request.
  entry.timer.unref?.();
  pendingPageRequests.set(id, entry);
  return id;
}

/** Await the outcome of a previously routed page request (resolves immediately when settled). */
export function awaitPageResult(requestId: string): Promise<PageResult> {
  const entry = pendingPageRequests.get(requestId);
  return entry ? entry.result : Promise.resolve({ ok: false, error: "no_such_request" });
}

/**
 * Session-facing wrapper: route a page tool call and await its outcome
 * (synchronous round trip — the HTTP layer returns the result directly).
 * tabId is mandatory (ADR-0022): missing_tab / tab_unreachable come back as
 * immediate errors without creating a request.
 */
export function runPageTool(target: string, tool: PageTool, timeoutMs?: number, tabId?: string): Promise<PageResult> {
  const requestId = routePageTool(target, tool, timeoutMs, tabId);
  if (requestId === null) {
    return Promise.resolve({ ok: false, error: tabId === undefined || tabId === "" ? "missing_tab" : "tab_unreachable" });
  }
  return awaitPageResult(requestId);
}

/**
 * Inbound page.response{id, ok, text|error} → correlate with the pending request.
 * The first response wins; late responses (already settled / unknown id) are
 * logged and ignored. No frame is sent back to the tab (mock protocol behavior).
 */
export function handlePageResponse(connection: WsConnection, frame: Frame): void {
  const id = frameId(frame);
  if (id === null) {
    console.log(`[page.response] ignored: missing id`);
    return;
  }
  const entry = pendingPageRequests.get(String(id));
  if (!entry || entry.settled) {
    console.log(`[page.response ${String(id)}] ignored (${entry ? "already settled" : "unknown request"})`);
    return;
  }
  if (frame.ok !== true && frame.ok !== false) {
    console.log(`[page.response ${String(id)}] ignored: ok must be a boolean`);
    return;
  }
  entry.tabConn = connection;
  const text = typeof frame.text === "string" ? frame.text : undefined;
  const error = typeof frame.error === "string" ? frame.error : undefined;
  const result: PageResult = frame.ok
    ? { ok: true, ...(text !== undefined ? { text } : {}) }
    : { ok: false, ...(error !== undefined ? { error } : {}) };
  console.log(`[page.response ${String(id)}] ok=${frame.ok} ${frame.ok ? `text: ${text ?? ""}` : `error: ${error ?? ""}`}`);
  settlePageRequest(String(id), result);
}

// ---------- page tool: session-side HTTP surface (replaces the ask-page flow) ----------

/**
 * POST /page-tool — {target, tool:{op, params?}, timeoutMs?}, size-guarded
 * POST /page-tool — {target, tool:{op, params?}, tabId?, timeoutMs?}, size-guarded
 * ≤ MAX_FRAME_BYTES. Synchronous round trip: waits for the page.response (or
 * timeout) and replies {ok:true, result:<parsed JSON>} / {ok:false, error}.
 * When the response text is not valid JSON it is returned verbatim as
 * {ok:true, text}. tabId is mandatory (ADR-0022): a missing or unreachable
 * tab answers {ok:false, error:"missing_tab"|"tab_unreachable"}.
 */
function handlePageToolHttp(request: http.IncomingMessage, response: http.ServerResponse): void {
  let settled = false;
  let oversized = false;
  let size = 0;
  const chunks: Buffer[] = [];
  const respond = (status: number, body: Record<string, unknown>): void => {
    if (settled) return;
    settled = true;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  request.on("data", (chunk: Buffer) => {
    if (oversized) return;
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) {
      oversized = true;
      respond(413, { ok: false, error: "payload_too_large" });
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (settled) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      respond(400, { ok: false, error: "invalid_json" });
      return;
    }
    const record = (body ?? {}) as { target?: unknown; tool?: unknown; tabId?: unknown; timeoutMs?: unknown };
    const { target, tool, tabId, timeoutMs } = record;
    if (typeof target !== "string" || target.trim() === "") {
      respond(400, { ok: false, error: "invalid_payload: missing or invalid target" });
      return;
    }
    if (typeof tabId !== "string" || tabId.trim() === "") {
      respond(400, { ok: false, error: ERR_MISSING_TAB });
      return;
    }
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      respond(400, { ok: false, error: "invalid_payload: tool must be an object" });
      return;
    }
    const toolRecord = tool as { op?: unknown; params?: unknown };
    if (typeof toolRecord.op !== "string" || toolRecord.op.trim() === "") {
      respond(400, { ok: false, error: "invalid_payload: tool.op must be a non-empty string" });
      return;
    }
    if (toolRecord.params !== undefined &&
        (typeof toolRecord.params !== "object" || toolRecord.params === null || Array.isArray(toolRecord.params))) {
      respond(400, { ok: false, error: "invalid_payload: tool.params must be an object" });
      return;
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      respond(400, { ok: false, error: "invalid_payload: timeoutMs must be a positive number" });
      return;
    }
    const pageTool: PageTool = {
      op: toolRecord.op,
      ...(toolRecord.params !== undefined
        ? { params: toolRecord.params as Record<string, unknown> }
        : {}),
    };
    void runPageTool(target, pageTool, timeoutMs as number | undefined, tabId).then((result) => {
      if (result.ok) {
        let parsed: unknown;
        let parseOk = false;
        try {
          parsed = JSON.parse(result.text ?? "");
          parseOk = true;
        } catch {
          /* not JSON — return verbatim */
        }
        if (parseOk) respond(200, { ok: true, result: parsed });
        else respond(200, { ok: true, text: result.text ?? "" });
      } else {
        respond(200, { ok: false, error: result.error ?? "unknown" });
      }
    });
  });
}
/** page.request is broker→page only; an inbound one is a protocol misuse — log, stay silent. */
function handleInboundPageRequest(): void {
  console.log("[broker] page.request is outbound-only; inbound request ignored");
}

/** Handlers bound to one broker instance's xfer dir (assigned by startBroker). */
function buildFrameHandlers(xferDir: string): Record<string, FrameHandler> {
  return {
    [WIRE_ANNOTATION_SUBMIT]: (connection, frame) => handleAnnotationSubmit(connection, frame, xferDir),
    [WIRE_ANNOTATION_COMPOSE]: (connection, frame) => handleAnnotationCompose(connection, frame),
    [WIRE_STAGE]: (connection, frame) => handleAnnotationStage(connection, frame),
    [WIRE_BAG_LIST]: (connection, frame) => handleBagList(connection, frame),
    [WIRE_BAG_SUBMIT]: (connection, frame) => handleBagSubmit(connection, frame, xferDir),
    [WIRE_TARGETS_LIST]: (connection, frame) => handleTargetsList(connection, frame, xferDir),
    [WIRE_PAGE_REQUEST]: () => handleInboundPageRequest(),
    [WIRE_PAGE_RESPONSE]: (connection, frame) => handlePageResponse(connection, frame),
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
    // Stable page-lifetime tab id → live connection (targeted page.request).
    const tabId = typeof tab.id === "string" && tab.id !== "" ? tab.id : null;
    if (tabId !== null && tabConns !== null) tabConns.set(tabId, connection);
    connection.send({ v: PROTOCOL_VERSION, type: WIRE_WELCOME, broker: { version: VERSION } });
    console.log(`[ws] hello: tab "${tab.title ?? "?"}" (${tab.url ?? "?"})${tabId !== null ? ` [${tabId}]` : ""}`);
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
  activeConns = conns;
  activeConns = conns;
  tabConns = new Map();
  bag = []; // per-broker-instance state — a test-started broker gets a fresh bag
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
    if (url.pathname === "/page-tool" && request.method === "POST") {
      handlePageToolHttp(request, response);
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
      if (tabConns !== null) {
        for (const [tabId, conn] of tabConns) {
          if (conn === connection) tabConns.delete(tabId);
        }
      }
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

// ---------- page-tool CLI helpers ----------

/** POST a JSON body and collect the response (used by the page-tool CLI). */
function httpPostJson(port: number, pathname: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        host: HOST,
        port,
        path: pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          raw += chunk;
        });
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * `node broker-main.ts page-tool <target> <op> [paramsJSON] --tab <id> [--timeout-ms <ms>]` —
 * reads broker.json (port) from the daemon's xfer dir, POSTs /page-tool, waits
 * for the outcome and prints the result JSON (stdout, exit 0), or an error
 * (stderr, exit 1) for missing_tab / tab_unreachable / timeout / broker down.
 * ADR-0022: --tab is mandatory — the tabId from the handoff/submit ack.
 */
async function runPageToolCommand(args: string[]): Promise<void> {
  // Flags may appear anywhere in argv; --xfer-dir is re-read via parseArgs
  // (same resolution as the daemon), so here we only skip it when collecting
  // the positionals <target> <op> [paramsJSON].
  const positional: string[] = [];
  let timeoutMs: number | undefined;
  let tabId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--timeout-ms") {
      const raw = args[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`[broker] page-tool: invalid --timeout-ms "${raw}"`);
        process.exit(1);
      }
      timeoutMs = parsed;
      i++;
      continue;
      continue;
    }
    if (arg === "--tab") {
      const raw = args[i + 1];
      if (raw === undefined || raw.trim() === "") {
        console.error('[broker] page-tool: --tab requires the tabId from the handoff/submit ack');
        process.exit(1);
      }
      tabId = raw;
      i++;
      continue;
    }
    if (arg === "--xfer-dir") {
      i++; // the value is consumed by parseArgs below
      continue;
    }
    positional.push(arg);
  }
  const target = positional[0];
  const op = positional[1];
  const paramsRaw = positional[2];
  let params: Record<string, unknown> | undefined;
  if (paramsRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(paramsRaw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      params = parsed as Record<string, unknown>;
    } catch {
      console.error("[broker] page-tool: params must be a JSON object literal");
      process.exit(1);
    }
  }
  if (tabId === undefined) {
    console.error("usage: node broker-main.ts page-tool <target> <op> [paramsJSON] --tab <id> [--timeout-ms <ms>]");
    console.error("  --tab is mandatory (ADR-0022): the tabId carried by the handoff / submit ack");
    process.exit(1);
  }
  if (typeof target !== "string" || target.trim() === "" || typeof op !== "string" || op.trim() === "") {
    console.error("usage: node broker-main.ts page-tool <target> <op> [paramsJSON] --tab <id> [--timeout-ms <ms>]");
    process.exit(1);
  }

  // Same xfer-dir resolution as the daemon; broker.json carries the port.
  const xferDir = parseArgs(process.argv.slice(2)).xferDir;
  let port: number;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(xferDir, "broker.json"), "utf-8"));
    const info = raw as { port?: unknown };
    if (typeof info.port !== "number" || info.port <= 0 || info.port > 65535) throw new Error("bad port");
    port = info.port;
  } catch {
    console.error(`[broker] page-tool: broker not running in ${xferDir} (no broker.json)`);
    process.exit(1);
  }

  let response: { status: number; body: unknown };
  try {
    response = await httpPostJson(port, "/page-tool", {
      target,
      tabId,
      tool: { op, ...(params !== undefined ? { params } : {}) },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    console.error(`[broker] page-tool: broker unreachable on ${HOST}:${port} (${(error as Error).message})`);
    process.exit(1);
  }

  const body = (response.body ?? {}) as { ok?: unknown; result?: unknown; text?: unknown; error?: unknown };
  if (response.status === 200 && body.ok === true) {
    process.stdout.write(`${JSON.stringify(body.result !== undefined ? body.result : body.text)}\n`, () => process.exit(0));
    return;
  }
  console.error(`[broker] page-tool failed: ${typeof body.error === "string" ? body.error : `http ${response.status}`}`);
  process.exit(1);
}


/** CLI entry: parse args, handle EADDRINUSE, install clean-exit handlers. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "page-tool") {
    await runPageToolCommand(args.slice(1));
    return;
  }
  const { port, xferDir } = parseArgs(args);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[broker] invalid port: ${port}`);
    process.exit(1);
  }
  // A live broker.pid means one of OUR brokers is already up for this xfer-dir —
  // regardless of which port it holds. Check BEFORE binding: the EADDRINUSE
  // branch below only fires on a port collision, so without this pre-check a
  // second daemon on a different (free) port would start and clobber the pid/json
  // state, orphaning the first.
  const existingPid = readPidFile(xferDir);
  if (existingPid !== null && pidAlive(existingPid)) {
    console.log("already running");
    process.exit(0);
  }

  let handle: BrokerHandle;
  try {
    handle = await startBroker({ port, xferDir });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      console.error(`[broker] bind failed: ${(error as Error).message}`);
      process.exit(1);
    }
    // Backstop for the race where a broker appeared between the pre-bind check
    // above and this bind: broker.pid decides.
    const racedPid = readPidFile(xferDir);
    if (racedPid !== null && pidAlive(racedPid)) {
      console.log("already running");
      process.exit(0);
    }
    // Stale (or missing) pid file → none of our brokers is up; clear the
    // stale state. A port held by a foreign program must not wedge startup
    // (nor pass itself off as the broker): fall back to an ephemeral port
    // and warn on stderr — the real port lands in broker.json either way.
    unlinkBrokerFiles(xferDir);
    if (port !== 0) {
      console.error(`[broker] port ${port} is occupied by another program — falling back to an ephemeral port`);
    }
    try {
      handle = await startBroker({ port: 0, xferDir });
    } catch (fallbackError) {
      console.error(`[broker] bind failed: ${(fallbackError as Error).message}`);
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

// Run as a daemon only when executed directly (not when imported by tests, and
// not from inside admin.cjs, which bundles this module).
function isMainModule(): boolean {
  return isEntryPoint(["broker-main.ts", "broker.cjs"]);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[broker] fatal: ${(error as Error).message}`);
    process.exit(1);
  });
}
