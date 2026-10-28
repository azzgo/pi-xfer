/**
 * page-tool.test.ts — integration tests for the session-side page-tool HTTP
 * surface and CLI: POST /page-tool {target, tool:{op, params?}, timeoutMs?}
 * routes a page.request{tool} to the connected tabs, waits for the first
 * page.response (or timeout) and returns the result in the HTTP response.
 * `node broker-main.ts page-tool <target> <op> [paramsJSON] [--timeout-ms]`
 * wraps the same endpoint for shell use.
 *
 * Harness: the broker runs IN-PROCESS via startBroker({port: 0}) with an
 * isolated os.tmpdir() xfer dir (like broker-reverse.test.ts); tabs are
 * raw-socket RFC 6455 clients that answer page.request frames with canned
 * page.response payloads. The CLI is spawned as a real child against the
 * in-process broker's broker.json, so the HTTP endpoint and the CLI
 * exit-code contract are both exercised end to end.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveBrokerCliPath, runPageTool, startBroker, type BrokerHandle } from "../../daemon/broker-main.js";
import { decodeFrame, OPCODE_CLOSE, OPCODE_TEXT, type DecodedFrame } from "./ws-server.ts";

// ---------- resolve hook (same as `npm test`) ----------

/**
 * The npm test script passes `--import '<hook>'` so node maps `./x.js` imports
 * to `./x.ts`. Extract it from package.json verbatim and reuse it when spawning
 * the CLI, so the spawned process resolves modules identically to the suite.
 */
function resolveHook(): string {
  const pkg: { scripts?: { test?: string } } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../..", "package.json"), "utf-8"),
  );
  const match = /--import\s+'([^']+)'/.exec(pkg.scripts?.test ?? "");
  if (!match) throw new Error("cannot find --import resolve hook in package.json test script");
  return path.resolve(import.meta.dirname, "../..", match[1]!);
}

const RESOLVE_HOOK = resolveHook();
const BROKER_MAIN = path.join(import.meta.dirname, "../../daemon/broker-main.ts");

// ---------- in-process broker harness ----------

const tmpDirs: string[] = [];
const brokerHandles: BrokerHandle[] = [];
const rawWsClients: RawWs[] = [];
const liveChildren: ChildProcess[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-page-tool-"));
  tmpDirs.push(dir);
  return dir;
}

/** Bind the real broker in-process on an ephemeral port with an isolated xfer dir. */
async function startTestBroker(): Promise<BrokerHandle & { xferDir: string }> {
  const xferDir = freshXferDir();
  const handle = await startBroker({ port: 0, xferDir });
  brokerHandles.push(handle);
  return { ...handle, xferDir };
}

afterEach(async () => {
  const handles = brokerHandles.splice(0);
  for (const handle of handles) await handle.close();
  for (const ws of rawWsClients.splice(0)) ws.destroy();
  const drained = liveChildren.splice(0);
  for (const child of drained) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- raw-socket WS client (test-built masked frames) ----------

const MASK_KEY = Buffer.from([0x12, 0x34, 0x56, 0x78]);
const RFC_SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

function maskedFrame(opcode: number, payload: Buffer, maskKey: Buffer): Buffer {
  const first = 0x80 | opcode;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([first, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ maskKey[i & 3]!;
  return Buffer.concat([header, maskKey, masked]);
}

function readHttpResponse(socket: net.Socket, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`no HTTP response within ${timeoutMs}ms; got: ${JSON.stringify(raw)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(raw.slice(0, end + 4));
    };
    socket.on("data", onData);
  });
}

class RawWs {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private readonly queue: DecodedFrame[] = [];
  private readonly waiters: Array<(frame: DecodedFrame) => void> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("error", () => socket.destroy());
  }

  /** RFC 6455 upgrade against /ws; asserts the 101 + accept. */
  static async connect(port: number): Promise<RawWs> {
    const socket = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${RFC_SAMPLE_KEY}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    const handshake = await readHttpResponse(socket);
    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    const client = new RawWs(socket);
    rawWsClients.push(client);
    return client;
  }

  sendText(text: string): void {
    this.socket.write(maskedFrame(OPCODE_TEXT, Buffer.from(text, "utf-8"), MASK_KEY));
  }

  sendClose(): void {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000, 0);
    this.socket.write(maskedFrame(OPCODE_CLOSE, body, MASK_KEY));
  }

  /** Resolve with the next inbound (unmasked) frame, or reject on timeout. */
  next(timeoutMs = 2_000): Promise<DecodedFrame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`no frame within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (frame: DecodedFrame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(waiter);
    });
  }

  destroy(): void {
    this.socket.destroy();
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const masked = (this.buffer[1]! & 0x80) !== 0;
      const len7 = this.buffer[1]! & 0x7f;
      if (len7 === 126 && this.buffer.length < 4) return;
      if (len7 === 127 && this.buffer.length < 10) return;
      const payloadLength =
        len7 === 126 ? this.buffer.readUInt16BE(2) : len7 === 127 ? this.buffer.readUInt32BE(6) : len7;
      const headerLength = len7 < 126 ? 2 : len7 === 126 ? 4 : 10;
      const frameLength = headerLength + (masked ? 4 : 0) + payloadLength;
      if (this.buffer.length < frameLength) return;
      const frame = decodeFrame(this.buffer);
      this.buffer = this.buffer.subarray(frameLength);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    }
  }
}

// ---------- small helpers ----------

function parseFrame(frame: DecodedFrame): Record<string, unknown> {
  assert.equal(frame.opcode, OPCODE_TEXT);
  return JSON.parse(frame.payload.toString("utf-8")) as Record<string, unknown>;
}

/** Hello with a stable page-lifetime tabId (what the real userscript sends). */
async function welcome(ws: RawWs, tabId?: string): Promise<void> {
  ws.sendText(JSON.stringify({ v: 0, type: "hello", client: { tab: tabId !== undefined ? { id: tabId } : {} } }));
  const frame = await ws.next();
  assert.equal(frame.opcode, OPCODE_TEXT);
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, "welcome");
}

/** Read the next page.request off the tab and answer it with a canned payload. */
async function answerNextPageRequest(
  ws: RawWs,
  respond: { ok: true; text: string } | { ok: false; error: string },
): Promise<Record<string, unknown>> {
  const frame = parseFrame(await ws.next());
  assert.equal(frame.type, "page.request");
  ws.sendText(JSON.stringify({ v: 0, type: "page.response", id: frame.id, ...respond }));
  return frame;
}

// ---------- CLI spawn harness ----------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `node daemon/broker-main.ts page-tool … --xfer-dir <dir>` and collect the outcome. */
async function runCli(xferDir: string, args: string[]): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--import", RESOLVE_HOOK, BROKER_MAIN, "page-tool", ...args, "--xfer-dir", xferDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  liveChildren.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 8_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

describe("page-tool self-description", () => {
  it("prints the op table instead of failing on a missing target", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-page-tool-help-"));
    const result = await runCli(dir, ["--help"]);
    assert.equal(result.code, 0, "the help path exits 0");
    assert.match(result.stdout, /dom\.query/);
    assert.match(result.stdout, /page\.info/);
    assert.match(result.stdout, /--tab/);
    assert.match(result.stdout, /tab_unreachable/);
    assert.match(result.stdout, /dom\.click/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- HTTP helper (test-side POST /page-tool) ----------

function httpPost(port: number, pathname: string, body: unknown | string): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = {};
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Stale broker.json: correct shape, nothing listening on that port. */
function writeStaleBrokerJson(xferDir: string): void {
  fs.writeFileSync(
    path.join(xferDir, "broker.json"),
    `${JSON.stringify({ port: 59999, pid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0" }, null, 2)}\n`,
  );
}

// ---------- tests ----------

describe("page-tool flow", () => {
  it("runPageTool: the named tab gets page.request{tool}, its page.response resolves the result", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const pending = runPageTool("alpha", { op: "dom.query", params: { selector: ".btn" } }, 5_000, "tab-1");
    const frame = await answerNextPageRequest(tab, { ok: true, text: '{"matched":2}' });

    assert.equal(frame.from, "alpha");
    assert.deepEqual(frame.tool, { op: "dom.query", params: { selector: ".btn" } });
    assert.equal(frame.timeoutMs, 5_000);
    assert.deepEqual(await pending, { ok: true, text: '{"matched":2}' });
  });

  it("runPageTool with a short timeout → {ok:false, error:'timeout'}, late responses ignored", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const pending = runPageTool("alpha", { op: "page.info" }, 100, "tab-1");
    const frame = parseFrame(await tab.next());
    assert.equal(frame.type, "page.request");
    assert.equal(frame.timeoutMs, 100);

    assert.deepEqual(await pending, { ok: false, error: "timeout" });

    // A late response must not resurrect the settled request.
    const late = tab.next(150).then(
      () => tab.sendText(JSON.stringify({ v: 0, type: "page.response", id: frame.id, ok: true, text: "late" })),
      () => {
        /* no page.request observed — the entry is settled, nothing to assert */
      },
    );
    await late;
    assert.deepEqual(await runPageTool("alpha", { op: "page.info" }, 1, "tab-1"), { ok: false, error: "timeout" });
  });

  it("runPageTool without tabId → {ok:false, error:'missing_tab'} without creating a request (ADR-0022)", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    assert.deepEqual(await runPageTool("alpha", { op: "page.info" }), { ok: false, error: "missing_tab" });
    await tab.next(200).then(
      () => assert.fail("a frame reached the tab despite missing_tab"),
      () => { /* silence expected */ },
    );
  });

  it("runPageTool with an unknown tabId → {ok:false, error:'tab_unreachable'} without creating a request", async () => {
    await startTestBroker();
    assert.deepEqual(await runPageTool("alpha", { op: "page.info" }, undefined, "tab-ghost"), { ok: false, error: "tab_unreachable" });
  });

  it("runPageTool with a disconnected tabId → tab_unreachable (the page is gone; no retry)", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");
    tab.sendClose();
    // The broker prunes its tab registry when the close handshake completes —
    // a probe request while the tab is still registered would block for the
    // full default timeout, so wait for the socket to finish closing first.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(await runPageTool("alpha", { op: "page.info" }, undefined, "tab-1"), { ok: false, error: "tab_unreachable" });
  });

  it("HTTP POST /page-tool → {ok:true, result:<parsed JSON>} once the named tab answers", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const respond = answerNextPageRequest(tab, { ok: true, text: '{"url":"https://example.com","depth":3}' });
    const response = await httpPost(daemon.port, "/page-tool", {
      target: "alpha",
      tabId: "tab-1",
      tool: { op: "framework.inspect", params: { selector: "#app" } },
      timeoutMs: 5_000,
    });
    await respond;

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { ok: true, result: { url: "https://example.com", depth: 3 } });
  });

  it("HTTP POST /page-tool: non-JSON response text falls back to {ok:true, text}", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const respond = answerNextPageRequest(tab, { ok: true, text: "plain answer" });
    const response = await httpPost(daemon.port, "/page-tool", {
      target: "alpha",
      tabId: "tab-1",
      tool: { op: "page.info" },
      timeoutMs: 5_000,
    });
    await respond;

    assert.deepEqual(response.data, { ok: true, text: "plain answer" });
  });

  it("HTTP POST /page-tool: page error response passes through as {ok:false, error}", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const respond = answerNextPageRequest(tab, { ok: false, error: "unknown_op: dom.eval" });
    const response = await httpPost(daemon.port, "/page-tool", {
      target: "alpha",
      tabId: "tab-1",
      tool: { op: "dom.eval" },
      timeoutMs: 5_000,
    });
    await respond;

    assert.deepEqual(response.data, { ok: false, error: "unknown_op: dom.eval" });
  });

  it("HTTP POST /page-tool without tabId → {ok:false, error:'missing_tab'}", async () => {
    const daemon = await startTestBroker();
    const response = await httpPost(daemon.port, "/page-tool", { target: "alpha", tool: { op: "page.info" } });
    assert.deepEqual(response.data, { ok: false, error: "missing_tab" });
  });

  it("HTTP POST /page-tool with an unreachable tabId → {ok:false, error:'tab_unreachable'}", async () => {
    const daemon = await startTestBroker();
    const response = await httpPost(daemon.port, "/page-tool", { target: "alpha", tabId: "tab-ghost", tool: { op: "page.info" } });
    assert.deepEqual(response.data, { ok: false, error: "tab_unreachable" });
  });

  it("HTTP POST /page-tool validation: malformed JSON / bad tool / bad params / bad timeoutMs → 400, oversized → 413", async () => {
    const daemon = await startTestBroker();
    const cases: Array<[unknown, RegExp]> = [
      ["{not json", /invalid_json/],
      [{ tool: { op: "page.info" }, tabId: "t" }, /missing or invalid target/],
      [{ target: "alpha", tabId: "t" }, /tool must be an object/],
      [{ target: "alpha", tabId: "t", tool: { op: "  " } }, /tool\.op must be a non-empty string/],
      [{ target: "alpha", tabId: "t", tool: { op: "page.info", params: [1, 2] } }, /tool\.params must be an object/],
      [{ target: "alpha", tabId: "t", tool: { op: "page.info" }, timeoutMs: -5 }, /timeoutMs must be a positive number/],
    ];
    for (const [body, expected] of cases) {
      const response = await httpPost(daemon.port, "/page-tool", body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(String(response.data.error), expected);
    }
    const oversized = await httpPost(daemon.port, "/page-tool", {
      target: "alpha",
      tabId: "t",
      tool: { op: "page.info", params: { blob: "x".repeat(1024 * 1024 + 1) } },
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.data.error, "payload_too_large");
  });

  it("CLI page-tool: prints the result JSON and exits 0", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const cli = runCli(daemon.xferDir, ["alpha", "dom.query", '{"selector":"button","maxCount":5}', "--tab", "tab-1"]);
    const frame = await answerNextPageRequest(tab, {
      ok: true,
      text: '{"matched":1,"elements":[{"tagName":"button"}]}',
    });
    assert.equal((frame.tool as { op?: unknown }).op, "dom.query");

    const { code, stdout, stderr } = await cli;
    assert.equal(code, 0, `expected exit 0, stderr: ${stderr}`);
    const parsed = JSON.parse(stdout.trim()) as { matched?: unknown; elements?: unknown[] };
    assert.equal(parsed.matched, 1);
    assert.equal((parsed.elements as unknown[]).length, 1);
  });

  it("CLI page-tool without --tab → usage error and exit 1 (ADR-0022)", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const { code, stdout, stderr } = await runCli(daemon.xferDir, ["alpha", "page.info"]);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /--tab is mandatory/);
    await tab.next(200).then(
      () => assert.fail("a frame reached the tab despite missing --tab"),
      () => { /* silence expected */ },
    );
  });

  it("CLI page-tool with an unreachable tab → error message and exit 1", async () => {
    const daemon = await startTestBroker();
    const { code, stdout, stderr } = await runCli(daemon.xferDir, ["alpha", "page.info", "--tab", "tab-ghost"]);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /tab_unreachable/);
  });

  it("CLI page-tool with no broker.json → friendly error and exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-page-tool-nojson-"));
    tmpDirs.push(dir);
    const { code, stderr } = await runCli(dir, ["alpha", "page.info", "--tab", "tab-1"]);
    assert.equal(code, 1);
    assert.match(stderr, /broker not running/);
  });

  it("CLI page-tool with a stale broker.json (nothing listening) → friendly error and exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-page-tool-stale-"));
    tmpDirs.push(dir);
    writeStaleBrokerJson(dir);
    const { code, stderr } = await runCli(dir, ["alpha", "page.info", "--tab", "tab-1"]);
    assert.equal(code, 1);
    assert.match(stderr, /broker unreachable/);
  });

  it("CLI page-tool with missing arguments → usage error and exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-page-tool-args-"));
    tmpDirs.push(dir);
    const { code, stderr } = await runCli(dir, ["alpha"]);
    assert.equal(code, 1);
    assert.match(stderr, /usage: node daemon\/broker-main\.ts page-tool/);
  });
});

/**
 * The doc's page-tool path comes from these two helpers. Regression: the live
 * 0.10.0 broker kept its startup dirname (the package ROOT), so after the
 * 0.10.1 layout move every handoff doc named `<pkg>/broker-main.ts` — a file
 * that no longer existed — and every follow-up died on `Cannot find module`.
 */
describe("broker CLI path resolution (doc-embedded page-tool command)", () => {
  const ROOT = "/opt/pi-xfer";

  it("prefers the bundle over the .ts source, from either dirname", () => {
    const all = new Set([
      path.join(ROOT, "dist/broker.cjs"),
      path.join(ROOT, "daemon/broker-main.ts"),
    ]);
    const exists = (c: string) => all.has(c);
    // bundle process (dirname = dist/) and a root-dirname daemon (0.10.0 zombie)
    // both resolve to the runnable bundle
    assert.equal(resolveBrokerCliPath(path.join(ROOT, "dist"), exists, "x"), path.join(ROOT, "dist/broker.cjs"));
    assert.equal(resolveBrokerCliPath(ROOT, exists, "x"), path.join(ROOT, "dist/broker.cjs"));
    // a repo tree running the source still finds the bundle — node cannot
    // type-strip a .ts under node_modules, so the bundle is always preferred
    assert.equal(resolveBrokerCliPath(path.join(ROOT, "daemon"), exists, "x"), path.join(ROOT, "dist/broker.cjs"));
  });

  it("falls back to a source layout only when no bundle exists", () => {
    const only = new Set([path.join(ROOT, "daemon/broker-main.ts")]);
    const exists = (c: string) => only.has(c);
    assert.equal(resolveBrokerCliPath(ROOT, exists, "x"), path.join(ROOT, "daemon/broker-main.ts"));
    assert.equal(resolveBrokerCliPath(path.join(ROOT, "daemon"), exists, "x"), path.join(ROOT, "daemon/broker-main.ts"));
  });

  it("never returns a path that does not exist — it returns the fallback instead", () => {
    const gone = (c: string) => c.endsWith("only-thing.cjs");
    assert.equal(resolveBrokerCliPath(ROOT, gone, "fallback.cjs"), "fallback.cjs");
  });

  it("a stale root dirname still resolves inside the upgraded package", () => {
    // the 0.10.0 broker was started from the package root and kept that dirname
    const upgraded = new Set([path.join(ROOT, "dist/broker.cjs")]);
    const resolved = resolveBrokerCliPath(ROOT, (c) => upgraded.has(c), "x");
    assert.equal(resolved, path.join(ROOT, "dist/broker.cjs"));
    assert.equal(resolved.endsWith("broker-main.ts"), false, "the dead 0.10.0 path must not be named");
  });
});
