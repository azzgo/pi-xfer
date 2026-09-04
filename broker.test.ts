/**
 * broker.test.ts — integration tests for the xfer broker daemon (goal 014 task 024).
 *
 * Spawns the REAL daemon (broker-main.ts) with the same `--import` resolve hook as
 * `npm test` (read from package.json so the two can never drift), on ephemeral
 * ports with an isolated os.tmpdir() xfer dir, so tests never touch ~/.pi/xfer.
 * The WS client is a raw net.Socket speaking RFC 6455 by hand (masked frames,
 * like a browser). Every spawned daemon is SIGTERM'd (then SIGKILL'd if needed)
 * in afterEach, and every tmpdir is removed, so the suite leaks nothing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { VERSION } from "./broker-main.js";
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

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-broker-test-"));
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

function readBrokerJson(xferDir: string): { port: number; pid: number; startedAt: string; version: string } {
  const data = JSON.parse(fs.readFileSync(path.join(xferDir, "broker.json"), "utf-8"));
  assert.equal(typeof data.port, "number");
  assert.equal(typeof data.pid, "number");
  assert.equal(typeof data.startedAt, "string");
  assert.equal(typeof data.version, "string");
  return data;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A port that is free right now (bind :0, note it, close). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** pid of a process that has already exited (kill(pid, 0) will ESRCH). */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

afterEach(async () => {
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
          // 'close' always follows 'exit' once stdio drains; listening to both
          // means a lost event can never leave a daemon behind.
          child.once("exit", finish);
          child.once("close", finish);
        }),
    ),
  );
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

// ---------- HTTP helpers ----------

function httpGet(port: number, pathname = "/status"): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
  });
}

async function getStatus(port: number): Promise<{
  ok: boolean;
  port: number;
  version: string;
  clients: number;
  startedAt: string;
}> {
  const response = await httpGet(port, "/status");
  assert.equal(response.statusCode, 200, `GET /status failed: ${response.body}`);
  return JSON.parse(response.body);
}

// ---------- tests ----------

describe("broker daemon (integration)", () => {
  it("greets hello with welcome{broker:{version}}, serves /status, and tracks tab close", async () => {
    const daemon = await spawnDaemon(freshXferDir());

    const ws = await RawWs.connect(daemon.port);
    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "hello",
        client: { tab: { id: "t1", url: "https://example.com", title: "Example" } },
      }),
    );
    const welcome = await ws.next();
    assert.equal(welcome.opcode, OPCODE_TEXT);
    assert.deepEqual(JSON.parse(welcome.payload.toString("utf-8")), {
      v: 0,
      type: "welcome",
      broker: { version: VERSION },
    });

    // /status mirrors the daemon state: one welcomed tab, real bound port.
    const status = await getStatus(daemon.port);
    assert.equal(status.ok, true);
    assert.equal(status.port, daemon.port);
    assert.equal(status.version, VERSION);
    assert.equal(status.clients, 1);
    assert.equal(typeof status.startedAt, "string");

    // broker.json carries the actual (ephemeral) port and this daemon's pid.
    const state = readBrokerJson(daemon.xferDir);
    assert.equal(state.port, daemon.port);
    assert.equal(state.pid, daemon.child.pid);
    assert.equal(state.version, VERSION);

    // Closing the tab drops the registry back to zero.
    ws.sendClose();
    ws.destroy();
    await waitFor(
      async () => (await getStatus(daemon.port)).clients === 0,
      "clients to drop to 0 after tab close",
    );
  });

  it("replies error{auth_failed} to any frame sent before hello", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);

    ws.sendText(JSON.stringify({ v: 0, type: "targets.list", id: "r1" }));
    const reply = await ws.next();
    assert.equal(reply.opcode, OPCODE_TEXT);
    const parsed = JSON.parse(reply.payload.toString("utf-8")) as {
      type: string;
      code: string;
      id: string;
    };
    assert.equal(parsed.type, "error");
    assert.equal(parsed.code, "auth_failed");
    assert.equal(parsed.id, "r1");
    ws.destroy();
  });

  it("replies error{unsupported_version} to an unknown frame type after hello", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);

    ws.sendText(JSON.stringify({ v: 0, type: "hello" }));
    await ws.next(); // welcome

    ws.sendText(JSON.stringify({ v: 0, type: "totally.unknown", id: "q1" }));
    const reply = await ws.next();
    const parsed = JSON.parse(reply.payload.toString("utf-8")) as {
      type: string;
      code: string;
      id: string;
    };
    assert.equal(parsed.type, "error");
    assert.equal(parsed.code, "unsupported_version");
    assert.equal(parsed.id, "q1");
    ws.destroy();
  });

  it("routes known protocol frames through the dispatch table", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);

    ws.sendText(JSON.stringify({ v: 0, type: "hello" }));
    await ws.next(); // welcome

    // annotation.submit: no "someone" socket in the xfer dir → target_not_found
    // (proves the handler is wired and fails fast instead of bouncing unsupported).
    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.submit",
        id: "a1",
        prompt: "collect",
        picks: [],
        target: { name: "someone" },
      }),
    );
    const submit = JSON.parse((await ws.next(5000)).payload.toString("utf-8")) as {
      type: string;
      code: string;
      id: string;
    };
    assert.equal(submit.type, "error");
    assert.equal(submit.code, "target_not_found");
    assert.equal(submit.id, "a1");

    // targets.list → targets.result (empty dir).
    ws.sendText(JSON.stringify({ v: 0, type: "targets.list", id: "t1" }));
    const targets = JSON.parse((await ws.next(5000)).payload.toString("utf-8")) as {
      type: string;
      id: string;
      targets: unknown[];
    };
    assert.equal(targets.type, "targets.result");
    assert.equal(targets.id, "t1");
    assert.deepEqual(targets.targets, []);

    // page.request / page.response are still silent stubs until task 030
    // registers their routing handlers — neither may bounce unsupported.
    ws.sendText(JSON.stringify({ v: 0, type: "page.request", id: "p1", text: "hi" }));
    ws.sendText(JSON.stringify({ v: 0, type: "page.response", id: "p2", ok: true, text: "yo" }));
    await assert.rejects(ws.next(300), /no frame/);
    ws.destroy();
  });

  it("annotation.compose returns the rendered handoff doc without writing or notifying", async () => {
    const xferDir = freshXferDir();
    const daemon = await spawnDaemon(xferDir);
    const ws = await RawWs.connect(daemon.port);
    ws.sendText(JSON.stringify({ v: 0, type: "hello" }));
    await ws.next(); // welcome

    ws.sendText(
      JSON.stringify({
        v: 0,
        type: "annotation.compose",
        id: "c1",
        prompt: "inspect these",
        page: { url: "https://example.com/", title: "Example", ts: 1_700_000_000_000 },
        picks: [
          { selector: "#cta", xpath: '//*[@id="cta"]', textPreview: "Go", rect: { x: 0, y: 0, w: 10, h: 10 }, note: "look" },
        ],
        target: { namespace: "local", name: "someone" },
      }),
    );
    const reply = JSON.parse((await ws.next(5000)).payload.toString("utf-8")) as {
      type: string;
      id: string;
      result?: { prompt?: string };
    };
    assert.equal(reply.type, "ack");
    assert.equal(reply.id, "c1");
    const doc = reply.result?.prompt ?? "";
    assert.match(doc, /# Web annotation handoff/);
    assert.match(doc, /inspect these/);
    assert.match(doc, /### #cta/);
    assert.match(doc, /broker-main\.ts page-tool someone/);
    assert.match(doc, /handoff_id: /);

    const handoffId = /handoff_id: (\S+)/.exec(doc)?.[1] ?? "";
    assert.ok(handoffId, "compose doc carries a handoff_id footer");
    assert.equal(fs.existsSync(path.join(os.tmpdir(), `pi-xfer-${handoffId}.md`)), false, "no doc file written for a compose");
    assert.match(daemon.stdout(), /\[compose\]/);
    assert.doesNotMatch(daemon.stdout(), /\[xfer\] delivered/);
    ws.destroy();
  });

  it("annotation.compose validates like submit and rejects a missing prompt", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const ws = await RawWs.connect(daemon.port);
    ws.sendText(JSON.stringify({ v: 0, type: "hello" }));
    await ws.next(); // welcome

    ws.sendText(JSON.stringify({ v: 0, type: "annotation.compose", id: "c2", picks: [] }));
    const reply = JSON.parse((await ws.next(5000)).payload.toString("utf-8")) as {
      type: string;
      id: string;
      code?: string;
    };
    assert.equal(reply.type, "error");
    assert.equal(reply.id, "c2");
    assert.equal(reply.code, "invalid_payload");
    ws.destroy();
  });

  it("removes broker.pid and broker.json on SIGTERM and exits 0", async () => {
    const xferDir = freshXferDir();
    const daemon = await spawnDaemon(xferDir);
    const pidFile = path.join(xferDir, "broker.pid");
    const jsonFile = path.join(xferDir, "broker.json");
    assert.ok(fs.existsSync(pidFile), "broker.pid exists while running");
    assert.ok(fs.existsSync(jsonFile), "broker.json exists while running");

    daemon.child.kill("SIGTERM");
    const { code } = await daemon.exited;
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(pidFile), "broker.pid removed on clean exit");
    assert.ok(!fs.existsSync(jsonFile), "broker.json removed on clean exit");
  });

  it("second daemon on a live broker prints 'already running' and exits 0", async () => {
    const xferDir = freshXferDir();
    const first = await spawnDaemon(xferDir);

    // Same xferDir + same port: second spawn must see broker.pid, find the pid
    // alive, and bow out without touching the running daemon's state.
    const second = spawnRaw(xferDir, first.port);
    const { code } = await second.exited;
    assert.equal(code, 0);
    assert.match(second.stdout(), /already running/);

    const state = readBrokerJson(xferDir);
    assert.equal(state.pid, first.child.pid, "first daemon's state untouched");
    assert.equal(state.port, first.port);
    assert.ok(fs.existsSync(path.join(xferDir, "broker.pid")));
  });

  it("starts over a stale broker.pid (dead process) when the port is free", async () => {
    const xferDir = freshXferDir();
    const port = await freePort();
    const deadPid = await reapedPid();

    // Simulate a crashed previous daemon: pid file names a dead process,
    // json file carries stale state.
    fs.writeFileSync(path.join(xferDir, "broker.pid"), `${deadPid}\n`);
    fs.writeFileSync(
      path.join(xferDir, "broker.json"),
      JSON.stringify({ port, pid: deadPid, startedAt: "stale", version: "0.0.0" }),
    );

    const daemon = await spawnDaemon(xferDir, port);
    assert.equal(daemon.port, port, "free port keeps the requested port");

    // State rewritten with the new live pid, and the daemon actually serves.
    const state = readBrokerJson(xferDir);
    assert.notEqual(state.pid, deadPid);
    assert.equal(state.pid, daemon.child.pid);
    const status = await getStatus(daemon.port);
    assert.equal(status.ok, true);
  });

  it("falls back to an ephemeral port when a foreign program holds the configured port", async () => {
    const xferDir = freshXferDir();

    // A plain TCP listener with no broker files: pid file absent → the daemon
    // must NOT claim "already running" and must NOT fail — it warns and lands
    // on an ephemeral port instead.
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const squatterPort = (squatter.address() as { port: number }).port;
    try {
      const daemon = await spawnDaemon(xferDir, squatterPort);
      assert.notEqual(daemon.port, squatterPort, "daemon moved off the occupied port");

      // broker.json records the fallback port, and the daemon actually serves it.
      const state = readBrokerJson(xferDir);
      assert.equal(state.port, daemon.port);
      assert.equal(state.pid, daemon.child.pid);
      const status = await getStatus(daemon.port);
      assert.equal(status.ok, true);

      // The fallback is announced on stderr (→ broker.log under the manager).
      assert.match(daemon.stderr(), /port \d+ is occupied by another program/);
      assert.match(daemon.stderr(), /falling back to an ephemeral port/);

      daemon.child.kill("SIGTERM");
      await daemon.exited;
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("still reports 'already running' when the port is held by OUR live broker", async () => {
    const xferDir = freshXferDir();
    const first = await spawnDaemon(xferDir);
    const second = spawnRaw(xferDir, first.port);
    const { code } = await second.exited;
    assert.equal(code, 0);
    assert.match(second.stdout(), /already running/);
    assert.ok(!second.stderr().includes("falling back"), "no fallback when our broker owns the port");
  });

  it("refuses a second daemon on a DIFFERENT port while broker.pid names a live process", async () => {
    const xferDir = freshXferDir();
    const first = await spawnDaemon(xferDir);

    // The pre-bind pid check is what makes this a no-op: a different, free
    // port would otherwise bind cleanly and clobber the pid/json state,
    // orphaning the first daemon.
    const other = await freePort();
    const second = spawnRaw(xferDir, other);
    const { code } = await second.exited;
    assert.equal(code, 0);
    assert.match(second.stdout(), /already running/);

    // State still belongs to the first daemon, which keeps serving.
    const state = readBrokerJson(xferDir);
    assert.equal(state.pid, first.child.pid, "first daemon's pid untouched");
    assert.equal(state.port, first.port, "first daemon's port untouched");
    const status = await getStatus(first.port);
    assert.equal(status.ok, true);
  });

  it("returns 404 for paths other than /status", async () => {
    const daemon = await spawnDaemon(freshXferDir());
    const response = await httpGet(daemon.port, "/other");
    assert.equal(response.statusCode, 404);
  });
});
