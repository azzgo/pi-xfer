/**
 * broker-reverse.test.ts — integration tests for the xfer broker's reverse
 * channel (goal 014 task 030): routePageRequest → page.request broadcast to
 * every welcomed tab, first page.response wins, timeout synthesis, late
 * responses ignored, and the no-tabs short circuit.
 *
 * Harness mirrors broker-delivery.test.ts's RawWs (RFC 6455 by hand over a
 * raw net.Socket) and fakeSession helpers, but runs the broker IN-PROCESS via
 * startBroker({port: 0}) — the reverse channel is driven by routePageRequest,
 * the same exported API the ask-page CLI (task 031) calls.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  askPage,
  awaitPageResult,
  DEFAULT_PAGE_TIMEOUT_MS,
  routePageRequest,
  startBroker,
  type BrokerHandle,
} from "./broker-main.js";
import { decodeFrame, OPCODE_CLOSE, OPCODE_TEXT, type DecodedFrame } from "./ws-server.js";

// ---------- in-process broker harness ----------

const tmpDirs: string[] = [];
const socketServers: net.Server[] = [];
const brokerHandles: BrokerHandle[] = [];
const rawWsClients: RawWs[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-broker-reverse-"));
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
  for (const server of socketServers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

// ---------- fake session socket (for the handoff_id test) ----------

/** Bind a fake session socket at <xferDir>/<name>.sock; acks every frame. */
async function fakeSession(xferDir: string, name: string): Promise<void> {
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
          continue;
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
        const record = msg as Record<string, unknown>;
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
}

// ---------- small helpers ----------

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` with console.log captured into the returned lines (restored afterwards). */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// ---------- tests ----------

describe("broker reverse channel (integration)", () => {
  it("first responder wins: both tabs get page.request, the first page.response resolves", async () => {
    const daemon = await startTestBroker();
    const tab1 = await RawWs.connect(daemon.port);
    const tab2 = await RawWs.connect(daemon.port);
    await welcome(tab1);
    await welcome(tab2);

    const requestId = routePageRequest("alpha", "what color is the button?", 5_000);
    assert.equal(typeof requestId, "string");
    assert.match(requestId!, /^r[0-9a-z]+$/);

    for (const tab of [tab1, tab2]) {
      const frame = parseFrame(await tab.next());
      assert.equal(frame.v, 0);
      assert.equal(frame.type, "page.request");
      assert.equal(frame.id, requestId);
      assert.equal(frame.handoff_id, "demo");
      assert.equal(frame.from, "alpha");
      assert.equal(frame.kind, "question");
      assert.equal(frame.text, "what color is the button?");
      assert.equal(frame.timeoutMs, 5_000);
    }

    tab1.sendText(
      JSON.stringify({ v: 0, type: "page.response", id: requestId, ok: true, text: "red" }),
    );
    assert.deepEqual(await awaitPageResult(requestId!), { ok: true, text: "red" });

    // A late response from the second tab is ignored: log line, no re-resolution.
    const late = await captureLog(async () => {
      tab2.sendText(
        JSON.stringify({ v: 0, type: "page.response", id: requestId, ok: false, error: "dismissed" }),
      );
      await sleep(50);
    });
    assert.ok(
      late.some((line) => line.includes("page.response") && line.includes("ignored")),
      `expected an ignored-response log line, got: ${JSON.stringify(late)}`,
    );
    assert.deepEqual(await awaitPageResult(requestId!), { ok: true, text: "red" });
  });

  it("timeout: explicit short override resolves {ok:false, error:'timeout'}, late response ignored", async () => {
    assert.equal(DEFAULT_PAGE_TIMEOUT_MS, 120_000);
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const started = Date.now();
    const requestId = routePageRequest("alpha", "slow question?", 100);
    assert.ok(requestId);
    assert.equal(parseFrame(await tab.next()).timeoutMs, 100);

    assert.deepEqual(await awaitPageResult(requestId!), { ok: false, error: "timeout" });
    assert.ok(Date.now() - started >= 95, "timeout resolved before the override elapsed");

    const late = await captureLog(async () => {
      tab.sendText(
        JSON.stringify({ v: 0, type: "page.response", id: requestId, ok: true, text: "too late" }),
      );
      await sleep(50);
    });
    assert.ok(
      late.some((line) => line.includes("page.response") && line.includes("ignored")),
      `expected an ignored-response log line, got: ${JSON.stringify(late)}`,
    );
    assert.deepEqual(await awaitPageResult(requestId!), { ok: false, error: "timeout" });
  });

  it("timeout default: BROKER_PAGE_TIMEOUT_MS env fallback, else 120s on the wire", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    const previous = process.env.BROKER_PAGE_TIMEOUT_MS;
    process.env.BROKER_PAGE_TIMEOUT_MS = "60";
    try {
      const requestId = routePageRequest("alpha", "env timeout?");
      assert.ok(requestId);
      assert.equal(parseFrame(await tab.next()).timeoutMs, 60);
      assert.deepEqual(await awaitPageResult(requestId!), { ok: false, error: "timeout" });
    } finally {
      if (previous === undefined) delete process.env.BROKER_PAGE_TIMEOUT_MS;
      else process.env.BROKER_PAGE_TIMEOUT_MS = previous;
    }

    // With no env and no explicit timeout the frame carries the 120s default.
    const defaultId = routePageRequest("alpha", "default timeout?");
    assert.ok(defaultId);
    assert.equal(parseFrame(await tab.next()).timeoutMs, DEFAULT_PAGE_TIMEOUT_MS);
  });

  it("no tabs connected → routePageRequest returns null, askPage resolves {ok:false, error:'no_tabs'}", async () => {
    const daemon = await startTestBroker();
    assert.equal(routePageRequest("alpha", "anyone there?"), null);
    assert.deepEqual(await askPage("alpha", "anyone there?"), { ok: false, error: "no_tabs" });

    // Sanity: once a tab connects, requests flow again (no stale no_tabs state).
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);
    const requestId = routePageRequest("alpha", "now?");
    assert.ok(requestId);
    assert.equal(parseFrame(await tab.next()).id, requestId);
  });

  it("page.request handoff_id: latest handoff for the target, 'demo' when none", async () => {
    const daemon = await startTestBroker();
    await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab);

    tab.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.submit",
        id: "a1",
        prompt: "collect highlights",
        picks: [],
        target: { name: "alpha" },
        page: { url: "https://example.com", title: "Example", ts: 1_720_000_000_000 },
      }),
    );
    const ack = parseFrame(await tab.next());
    assert.equal(ack.type, "ack");
    const handoffId = (ack.result as { handoff_id?: unknown }).handoff_id as string;

    const requestId = routePageRequest("alpha", "which pick is the note?");
    assert.ok(requestId);
    assert.equal(parseFrame(await tab.next()).handoff_id, handoffId);

    // A target with no handoff yet falls back to "demo".
    const otherId = routePageRequest("ghost", "hello?");
    assert.ok(otherId);
    assert.equal(parseFrame(await tab.next()).handoff_id, "demo");
  });
});
