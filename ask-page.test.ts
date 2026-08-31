/**
 * ask-page.test.ts — integration tests for the session-side ask-page CLI and
 * answer-notify push (goal 014 task 031): `node broker-main.ts ask-page
 * <target> "<question>" [--timeout-ms <ms>]` POSTs /ask-page to the daemon
 * (fire-and-forget, Wayfinder 009), and the daemon pushes the answer (or a
 * timeout) back to the asking session as an xfer-notify frame.
 *
 * Harness: the broker runs IN-PROCESS via startBroker({port: 0}) with an
 * isolated os.tmpdir() xfer dir (like broker-reverse.test.ts); the session
 * side is a fake unix-socket server that acks every frame and records what it
 * received (like broker-delivery.test.ts's fakeSession); tabs are raw-socket
 * RFC 6455 clients. The CLI is spawned as a real child (node broker-main.ts
 * ask-page …) against the in-process broker's broker.json, so the HTTP POST
 * endpoint and the CLI exit-code contract are both exercised end to end.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { startAskPage, startBroker, type BrokerHandle } from "./broker-main.js";
import { decodeFrame, OPCODE_CLOSE, OPCODE_TEXT, type DecodedFrame } from "./ws-server.js";

// ---------- resolve hook (same as `npm test`) ----------

/**
 * The npm test script passes `--import '<hook>'` so node maps `./x.js` imports
 * to `./x.ts`. Extract it from package.json verbatim and reuse it when spawning
 * the CLI, so the spawned process resolves modules identically to the suite.
 */
function resolveHook(): string {
  const pkg: { scripts?: { test?: string } } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
  );
  const match = /--import\s+'([^']+)'/.exec(pkg.scripts?.test ?? "");
  if (!match) throw new Error("cannot find --import resolve hook in package.json test script");
  return match[1]!;
}

const RESOLVE_HOOK = resolveHook();
const BROKER_MAIN = path.join(import.meta.dirname, "broker-main.ts");

// ---------- in-process broker harness ----------

const tmpDirs: string[] = [];
const socketServers: net.Server[] = [];
const brokerHandles: BrokerHandle[] = [];
const rawWsClients: RawWs[] = [];
const liveChildren: ChildProcess[] = [];
/** Answer docs written into os.tmpdir(); afterEach unlinks them. */
const docFiles: string[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-ask-page-"));
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
  for (const server of socketServers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const doc of docFiles.splice(0)) {
    try {
      fs.unlinkSync(doc);
    } catch {
      /* already gone */
    }
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

// ---------- fake session socket ----------

interface FakeSession {
  server: net.Server;
  /** Every JSON line the fake session received (xfer-notify frames, etc.). */
  received: Array<Record<string, unknown>>;
}

/** Bind a fake session socket at <xferDir>/<name>.sock; acks every frame. */
async function fakeSession(xferDir: string, name: string): Promise<FakeSession> {
  const received: Array<Record<string, unknown>> = [];
  const server = net.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON line: ignore, keep listening
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
        const record = msg as Record<string, unknown>;
        received.push(record);
        if (typeof record.msg_id === "string") {
          sock.write(`${JSON.stringify({ type: "ack", msg_id: record.msg_id })}\n`);
        }
      }
    });
    sock.on("error", () => {});
  });
  socketServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(xferDir, `${name}.sock`), () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, received };
}

// ---------- CLI spawn harness ----------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `node broker-main.ts ask-page … --xfer-dir <dir>` and collect the outcome. */
async function runCli(xferDir: string, args: string[]): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--import", RESOLVE_HOOK, BROKER_MAIN, "ask-page", ...args, "--xfer-dir", xferDir],
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

// ---------- HTTP helper (test-side POST /ask-page) ----------

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

// ---------- small helpers ----------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

function parseFrame(frame: DecodedFrame): Record<string, unknown> {
  assert.equal(frame.opcode, OPCODE_TEXT);
  return JSON.parse(frame.payload.toString("utf-8")) as Record<string, unknown>;
}

async function welcome(ws: RawWs): Promise<void> {
  ws.sendText(JSON.stringify({ v: 0, type: "hello" }));
  const frame = await ws.next();
  assert.equal(frame.opcode, OPCODE_TEXT);
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, "welcome");
}

/** Poll the fake session until the xfer-notify for the ask-page answer lands. */
function findNotify(session: FakeSession): Record<string, unknown> | undefined {
  return session.received.find((frame) => frame.type === "xfer-notify");
}

// ---------- tests ----------

describe("ask-page flow (goal 014 task 031)", () => {
  it("startAskPage: answer notify lands on the fake session socket with the answer doc path + summary", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const outcome = startAskPage(daemon.xferDir, "alpha", "what is 2+2?", 2_000);
    assert.equal(outcome.ok, true);
    assert.match(outcome.request_id!, /^r[0-9a-z]+$/);

    const request = parseFrame(await tab.next());
    assert.equal(request.type, "page.request");
    assert.equal(request.id, outcome.request_id);
    assert.equal(request.from, "alpha");
    assert.equal(request.text, "what is 2+2?");
    assert.equal(request.timeoutMs, 2_000);

    tab.sendText(JSON.stringify({ v: 0, type: "page.response", id: outcome.request_id, ok: true, text: "4" }));

    const notify = await waitFor(() => findNotify(session), 3_000, "answer notify");
    assert.equal(typeof notify.msg_id, "string");
    assert.match(notify.msg_id as string, /^m[0-9a-z]+$/);
    assert.equal(notify.from, "web-picker-ask");
    assert.equal(notify.summary, "answer: 4");

    const doc = notify.file as string;
    assert.equal(doc, path.join(os.tmpdir(), `pi-xfer-${notify.msg_id}.md`));
    docFiles.push(doc);
    const stat = fs.statSync(doc);
    assert.equal(stat.mode & 0o777, 0o600);
    const content = fs.readFileSync(doc, "utf-8");
    assert.ok(content.includes("what is 2+2?"), "doc renders the question");
    assert.ok(content.includes("4"), "doc renders the answer");
    assert.ok(content.includes(`request_id: ${outcome.request_id}`), "doc carries request_id");
    assert.ok(content.includes(`msg_id: ${notify.msg_id}`), "doc carries msg_id");
  });

  it("startAskPage with a short timeout → timeout notify with summary 'timeout' and an error doc", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const outcome = startAskPage(daemon.xferDir, "alpha", "slow question?", 100);
    assert.equal(outcome.ok, true);
    assert.equal(parseFrame(await tab.next()).timeoutMs, 100);

    // No response: the 100ms override fires the timeout notify.
    const notify = await waitFor(() => findNotify(session), 3_000, "timeout notify");
    assert.equal(notify.summary, "timeout");
    assert.equal(notify.from, "web-picker-ask");
    const doc = notify.file as string;
    docFiles.push(doc);
    const content = fs.readFileSync(doc, "utf-8");
    assert.ok(content.includes("## Error"), "timeout doc renders the error section");
    assert.ok(content.includes("timeout"), "timeout doc carries the timeout error");
    assert.ok(content.includes(`request_id: ${outcome.request_id}`), "timeout doc carries request_id");
  });

  it("startAskPage with no tabs → {ok:false, error:'no_tabs'}, no request, no notify", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    assert.deepEqual(startAskPage(daemon.xferDir, "alpha", "anyone there?"), {
      ok: false,
      error: "no_tabs",
    });
    await sleep(50);
    assert.equal(session.received.length, 0, "no notify when no tabs are connected");
  });

  it("HTTP POST /ask-page → {ok:true, request_id} immediately; answer notify round trips", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const response = await httpPost(daemon.port, "/ask-page", {
      target: "alpha",
      question: "which pick is the note?",
      timeoutMs: 2_000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.ok, true);
    const requestId = response.data.request_id as string;
    assert.match(requestId, /^r[0-9a-z]+$/);

    assert.equal(parseFrame(await tab.next()).id, requestId);
    tab.sendText(JSON.stringify({ v: 0, type: "page.response", id: requestId, ok: true, text: "the note one" }));

    const notify = await waitFor(() => findNotify(session), 3_000, "answer notify");
    assert.equal(notify.summary, "answer: the note one");
    const doc = notify.file as string;
    docFiles.push(doc);
    assert.ok(fs.existsSync(doc), "answer doc written to os.tmpdir()");
  });

  it("HTTP POST /ask-page with no tabs → {ok:false, error:'no_tabs'}", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const response = await httpPost(daemon.port, "/ask-page", { target: "alpha", question: "anyone?" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { ok: false, error: "no_tabs" });
    assert.equal(session.received.length, 0, "no notify when no tabs are connected");
  });

  it("HTTP POST /ask-page: oversized body → 413, malformed JSON / missing fields → 400", async () => {
    const daemon = await startTestBroker();

    const oversized = await httpPost(daemon.port, "/ask-page", {
      target: "alpha",
      question: "x".repeat(1024 * 1024 + 10),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.data.error, "payload_too_large");

    const malformed = await httpPost(daemon.port, "/ask-page", "{not json");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.data.error, "invalid_json");

    for (const bad of [
      { target: "alpha" }, // missing question
      { question: "hi?" }, // missing target
      { target: "", question: "hi?" }, // empty target
      { target: "alpha", question: "hi?", timeoutMs: -5 }, // bad timeout
      { target: "alpha", question: "hi?", timeoutMs: "500" }, // non-number timeout
    ]) {
      const response = await httpPost(daemon.port, "/ask-page", bad);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.ok(String(response.data.error).startsWith("invalid_payload"));
    }
  });

  it("CLI ask-page: prints request_id and exits 0; the answer notify still flows", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const result = await runCli(daemon.xferDir, ["alpha", "cli question?", "--timeout-ms", "2000"]);
    assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const requestId = result.stdout.trim();
    assert.match(requestId, /^r[0-9a-z]+$/);

    assert.equal(parseFrame(await tab.next()).id, requestId);
    tab.sendText(JSON.stringify({ v: 0, type: "page.response", id: requestId, ok: true, text: "42" }));
    const notify = await waitFor(() => findNotify(session), 3_000, "answer notify");
    assert.equal(notify.summary, "answer: 42");
    const doc = notify.file as string;
    docFiles.push(doc);
    assert.ok(fs.existsSync(doc));
  });

  it("CLI ask-page with no tabs → error message and exit 1, no notify", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const result = await runCli(daemon.xferDir, ["alpha", "anyone there?"]);
    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /no_tabs/);
    assert.equal(session.received.length, 0, "no notify when no tabs are connected");
  });

  it("CLI ask-page with no broker.json → friendly error and exit 1", async () => {
    const xferDir = freshXferDir(); // never started a broker here
    const result = await runCli(xferDir, ["alpha", "hello?"]);
    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /broker not running/);
  });

  it("CLI ask-page with a stale broker.json (nothing listening) → friendly error and exit 1", async () => {
    const xferDir = freshXferDir();
    fs.writeFileSync(
      path.join(xferDir, "broker.json"),
      JSON.stringify({ port: 1, pid: 2, startedAt: new Date().toISOString(), version: "0.1.0" }),
    );
    const result = await runCli(xferDir, ["alpha", "hello?"]);
    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /broker unreachable/);
  });

  it("CLI ask-page with missing arguments → usage error and exit 1", async () => {
    const xferDir = freshXferDir();
    const result = await runCli(xferDir, ["alpha"]);
    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /usage:/);
  });
});
