/**
 * broker-delivery.test.ts — integration tests for the xfer broker's delivery
 * handlers (goal 014 task 029): annotation.submit → handoff doc + xfer-notify
 * push + ack, and targets.list.
 *
 * Same harness as broker.test.ts: spawns the REAL daemon (broker-main.ts) on an
 * ephemeral port with an isolated os.tmpdir() xfer dir, and speaks RFC 6455 by
 * hand over a raw net.Socket. The session side is a fake unix-socket server
 * bound INSIDE that xfer dir — it reads the xfer-notify JSON line and replies
 * ack with the matching msg_id, exactly like a real pi session socket would.
 *
 * Every spawned daemon is SIGTERM'd (then SIGKILL'd if needed) in afterEach;
 * tmpdirs, fake socket servers, and handoff docs are all cleaned up so the
 * suite never touches ~/.pi/xfer and leaks nothing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { decodeFrame, OPCODE_CLOSE, OPCODE_TEXT, type DecodedFrame } from "./ws-server.js";

// ---------- resolve hook (same as `npm test`) ----------

/**
 * The npm test script passes `--import '<hook>'` so node maps `./x.js` imports
 * to `./x.ts`. Extract it from package.json verbatim and reuse it when spawning
 * the daemon, so the spawned process resolves modules identically to the suite.
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

// ---------- daemon spawn harness ----------

interface RawSpawn {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

interface Daemon extends RawSpawn {
  xferDir: string;
  /** Actual bound port (from the daemon's own broker.json). */
  port: number;
}

/** Every spawned child; afterEach SIGTERMs any that are still running. */
const liveChildren: ChildProcess[] = [];
const tmpDirs: string[] = [];
const socketServers: net.Server[] = [];
/** Handoff docs written by daemons into os.tmpdir(); afterEach unlinks them. */
const docFiles: string[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-broker-delivery-"));
  tmpDirs.push(dir);
  return dir;
}

function spawnRaw(xferDir: string, port: number): RawSpawn {
  const child = spawn(process.execPath, [
    "--import",
    RESOLVE_HOOK,
    BROKER_MAIN,
    "--port",
    String(port),
    "--xfer-dir",
    xferDir,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  liveChildren.push(child);
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/** Spawn the daemon and wait until ITS broker.json (pid === child pid) appears. */
async function spawnDaemon(xferDir: string, port = 0): Promise<Daemon> {
  const raw = spawnRaw(xferDir, port);
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (raw.child.exitCode !== null || raw.child.signalCode !== null) {
      throw new Error(
        `daemon exited before writing broker.json ` +
          `(code=${raw.child.exitCode} signal=${raw.child.signalCode})\n` +
          `stdout: ${raw.stdout()}\nstderr: ${raw.stderr()}`,
      );
    }
    try {
      const data = JSON.parse(fs.readFileSync(path.join(xferDir, "broker.json"), "utf-8")) as {
        port?: unknown;
        pid?: unknown;
      };
      if (typeof data.port === "number" && data.port > 0 && data.pid === raw.child.pid) {
        return { ...raw, xferDir, port: data.port };
      }
    } catch {
      /* broker.json not written yet */
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for broker.json in ${xferDir}\nstdout: ${raw.stdout()}\nstderr: ${raw.stderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const server of socketServers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const drained = liveChildren.splice(0);
  for (const child of drained) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    drained.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish();
          }, 2_000);
          child.once("exit", finish);
          child.once("close", finish);
        }),
    ),
  );
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
    return new RawWs(socket);
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
  /** Every xfer-notify frame the fake session received (JSON-lines). */
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

// ---------- handoff doc helpers ----------

function handoffDocsInTmpdir(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((file) => /^pi-xfer-.*\.md$/.test(file))
    .map((file) => path.join(os.tmpdir(), file));
}

/** Docs that appeared in os.tmpdir() since the `before` snapshot. */
function newHandoffDocs(before: Set<string>): string[] {
  return handoffDocsInTmpdir().filter((file) => !before.has(file));
}

/** Parse a text frame's JSON payload into a plain record. */
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

// ---------- tests ----------

describe("broker delivery (integration)", () => {
  it("annotation.submit round trip: pushes xfer-notify, acks {handoff_id, doc}, doc mode 0600", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const session = await fakeSession(daemon.xferDir, "alpha");
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    const prompt = "collect the highlights and send them over";
    const picks = [
      {
        selector: ".note",
        xpath: "/html[1]/body[1]/main[1]",
        rect: { x: 1, y: 2, w: 3, h: 4 },
        textPreview: "hi",
        note: "n",
      },
    ];
    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.submit",
        id: "a1",
        prompt,
        picks,
        target: { name: "alpha" },
        page: { url: "https://example.com/page", title: "Example", ts: 1_720_000_000_000 },
      }),
    );

    const ack = parseFrame(await ws.next());
    assert.equal(ack.v, 0);
    assert.equal(ack.type, "ack");
    assert.equal(ack.id, "a1");
    const result = ack.result as { handoff_id?: unknown; doc?: unknown };
    assert.equal(typeof result.handoff_id, "string");
    assert.match(result.handoff_id as string, /^m[0-9a-z]+$/);
    assert.equal(typeof result.doc, "string");
    const doc = result.doc as string;
    assert.equal(doc, path.join(os.tmpdir(), `pi-xfer-${result.handoff_id}.md`));
    docFiles.push(doc);

    // The fake session saw exactly one xfer-notify, matching the ack's id.
    assert.equal(session.received.length, 1);
    const notify = session.received[0]!;
    assert.equal(notify.type, "xfer-notify");
    assert.equal(notify.msg_id, result.handoff_id);
    assert.equal(notify.from, "web-picker");
    assert.equal(notify.file, doc);
    assert.equal(notify.summary, prompt.slice(0, 120));

    // Doc on disk, mode 0600, content carries the prompt + handoff id.
    const stat = fs.statSync(doc);
    assert.equal(stat.mode & 0o777, 0o600);
    const content = fs.readFileSync(doc, "utf-8");
    assert.ok(content.includes(prompt), "doc renders the prompt");
    assert.ok(content.includes(`handoff_id: ${result.handoff_id}`), "doc carries handoff_id");
    assert.ok(content.includes("from: web-picker"), "doc carries from: web-picker");
    ws.destroy();
  });

  it("annotation.submit with a missing target socket → error{target_not_found}, doc kept on disk", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    const before = new Set(handoffDocsInTmpdir());
    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.submit",
        id: "a1",
        prompt: "hand this off",
        picks: [],
        target: { name: "ghost" },
      }),
    );

    const reply = parseFrame(await ws.next());
    assert.equal(reply.type, "error");
    assert.equal(reply.id, "a1");
    assert.equal(reply.code, "target_not_found");

    // The doc stays on disk even though delivery failed.
    const created = newHandoffDocs(before);
    assert.equal(created.length, 1, "the handoff doc was still written");
    docFiles.push(created[0]!);
    ws.destroy();
  });

  it("annotation.submit with target.namespace != local → error{bad_target}", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.submit",
        id: "a1",
        prompt: "x",
        picks: [],
        target: { name: "remote", namespace: "peer" },
      }),
    );
    const reply = parseFrame(await ws.next());
    assert.equal(reply.type, "error");
    assert.equal(reply.id, "a1");
    assert.equal(reply.code, "bad_target");
    ws.destroy();
  });

  it("annotation.submit with a malformed payload → error{invalid_payload} naming what's missing", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    const cases: Array<{ id: string; frame: Record<string, unknown>; missing: string }> = [
      { id: "m1", frame: { picks: [], target: { name: "alpha" } }, missing: "prompt" },
      { id: "m2", frame: { prompt: "x", target: { name: "alpha" } }, missing: "picks" },
      { id: "m3", frame: { prompt: "x", picks: [] }, missing: "target.name" },
    ];
    for (const { id, frame, missing } of cases) {
      ws.sendText(JSON.stringify({ v: 0, type: "annotation.submit", id, ...frame }));
      const reply = parseFrame(await ws.next());
      assert.equal(reply.type, "error");
      assert.equal(reply.id, id);
      assert.equal(reply.code, "invalid_payload");
      assert.ok(
        String(reply.message).includes(missing),
        `message ${JSON.stringify(reply.message)} should name the missing field ${missing}`,
      );
    }
    ws.destroy();
  });

  it("unknown frame type after hello → error{unsupported_version}", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    ws.sendText(JSON.stringify({ v: 0, type: "totally.unknown", id: "q1" }));
    const reply = parseFrame(await ws.next());
    assert.equal(reply.type, "error");
    assert.equal(reply.id, "q1");
    assert.equal(reply.code, "unsupported_version");
    ws.destroy();
  });

  it("targets.list → targets.result listing the fake session socket", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    await fakeSession(daemon.xferDir, "alpha");
    const ws = await RawWs.connect(daemon.port);
    await welcome(ws);

    ws.sendText(JSON.stringify({ v: 0, type: "targets.list", id: "t1" }));
    const reply = parseFrame(await ws.next());
    assert.equal(reply.v, 0);
    assert.equal(reply.type, "targets.result");
    assert.equal(reply.id, "t1");
    assert.deepEqual(reply.targets, [
      { name: "alpha", sessionName: null, cwd: null, status: null },
    ]);
    ws.destroy();
  });
});
