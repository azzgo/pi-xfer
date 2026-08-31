/**
 * Run via `npm test` in this directory (same resolve-hook setup as server.test.ts).
 * Hand-rolled RFC 6455 subset: pure codec unit tests plus one integration test over a
 * REAL http server on an ephemeral port, driven by a raw net.Socket client that speaks
 * frames by hand (masked, like a browser would). Every server is tracked and torn down
 * in afterEach, so concurrent test runs never fight over ports or leaked sockets.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, it } from "node:test";
import { MAX_FRAME_BYTES } from "./constants.js";
import {
  acceptKey,
  attachWsServer,
  decodeFrame,
  encodeFrame,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  type DecodedFrame,
  type WsConnection,
} from "./ws-server.js";

/** Fixed mask key for test-built client frames (any 4 bytes work). */
const MASK_KEY = Buffer.from([0x12, 0x34, 0x56, 0x78]);
/** RFC 6455 §4.2.2 example key; its known accept value doubles as a handshake check. */
const RFC_SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC_SAMPLE_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
/** Regex-escaped accept value (contains `+`, a regex quantifier). */
const RFC_SAMPLE_ACCEPT_RE = new RegExp(
  `^Sec-WebSocket-Accept: ${RFC_SAMPLE_ACCEPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\r\n`,
  "m",
);

// ---------- test-built frames (independent of the implementation under test) ----------

function maskedPayload(payload: Buffer, maskKey: Buffer): Buffer {
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i]! ^ maskKey[i & 3]!;
  }
  return masked;
}

/** Build a client-to-server frame by hand: FIN set, mask bit set, 4-byte mask key. */
function buildMaskedFrame(opcode: number, payload: Buffer, maskKey: Buffer): Buffer {
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
  return Buffer.concat([header, maskKey, maskedPayload(payload, maskKey)]);
}

/** Test-side re-derivation of the wire header size (cross-checks the length rules). */
function expectedHeaderLength(payloadLength: number, masked: boolean): number {
  const base = payloadLength < 126 ? 2 : payloadLength <= 0xffff ? 4 : 10;
  return base + (masked ? 4 : 0);
}

function fill(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i++) buffer[i] = i & 0xff;
  return buffer;
}

// ---------- raw-socket WS test client ----------

interface FrameWaiter {
  resolve(frame: DecodedFrame): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class WsTestClient {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private readonly queue: DecodedFrame[] = [];
  private readonly pending: FrameWaiter[] = [];
  private readonly closeWaiters: Array<() => void> = [];
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.closed = true;
      for (const notify of this.closeWaiters.splice(0)) notify();
      for (const waiter of this.pending.splice(0)) {
        waiter.reject(new Error("connection closed before a frame arrived"));
      }
    });
  }

  /** Perform the upgrade handshake with the RFC sample key; asserts the 101 + accept. */
  static async connect(port: number, path = "/ws"): Promise<WsTestClient> {
    const socket = net.connect({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${RFC_SAMPLE_KEY}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    const handshake = await readHttpResponse(socket);
    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.match(handshake, RFC_SAMPLE_ACCEPT_RE);
    return new WsTestClient(socket);
  }

  sendMaskedFrame(opcode: number, payload: Buffer): void {
    this.socket.write(buildMaskedFrame(opcode, payload, MASK_KEY));
  }

  sendMaskedText(text: string): void {
    this.sendMaskedFrame(OPCODE_TEXT, Buffer.from(text, "utf-8"));
  }

  sendClose(code = 1000): void {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.sendMaskedFrame(OPCODE_CLOSE, body);
  }

  /** Resolve with the next inbound frame (server frames are unmasked). */
  next(timeoutMs = 2_000): Promise<DecodedFrame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve: (frame) => {
          clearTimeout(waiter.timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: null as unknown as NodeJS.Timeout,
      };
      waiter.timer = setTimeout(() => {
        const index = this.pending.indexOf(waiter);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`no frame within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.push(waiter);
    });
  }

  waitClosed(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`socket did not close within ${timeoutMs}ms`)), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
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
      const frameLength = expectedHeaderLength(payloadLength, masked) + payloadLength;
      if (this.buffer.length < frameLength) return;
      const frame = decodeFrame(this.buffer);
      this.buffer = this.buffer.subarray(frameLength);
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve(frame);
      else this.queue.push(frame);
    }
  }
}

/** Read one HTTP response (through the blank line) off a raw socket. */
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

// ---------- tracked http servers + afterEach teardown ----------

interface LiveServer {
  server: http.Server;
  sockets: Set<net.Socket>;
}

const liveServers: LiveServer[] = [];

/** Bind a fresh http server on 127.0.0.1:0; registered for afterEach teardown. */
async function listenHttp(): Promise<LiveServer> {
  const server = http.createServer(() => {});
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const live: LiveServer = { server, sockets };
  liveServers.push(live);
  return live;
}

function portOf(live: LiveServer): number {
  const address = live.server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP AddressInfo");
  return address.port;
}

afterEach(async () => {
  const drained = liveServers.splice(0);
  for (const live of drained) {
    for (const socket of live.sockets) socket.destroy();
    live.server.closeAllConnections();
  }
  await Promise.all(
    drained.map((live) => new Promise<void>((resolve) => live.server.close(() => resolve()))),
  );
});

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------- unit tests: codec ----------

describe("acceptKey", () => {
  it("matches the RFC 6455 §4.2.2 example vector", () => {
    assert.equal(acceptKey(RFC_SAMPLE_KEY), RFC_SAMPLE_ACCEPT);
  });
});

describe("encodeFrame/decodeFrame", () => {
  it("round-trips payloads across every length boundary", () => {
    for (const size of [0, 1, 125, 126, 127, 65535, 65536, 65537]) {
      const payload = fill(Buffer.alloc(size));
      const frame = encodeFrame(OPCODE_TEXT, payload);
      assert.equal(frame[0], 0x80 | OPCODE_TEXT, `fin+text opcode at size ${size}`);
      assert.equal(frame[1] & 0x80, 0, `server frames are unmasked at size ${size}`);
      const decoded = decodeFrame(frame);
      assert.equal(decoded.opcode, OPCODE_TEXT, `opcode at size ${size}`);
      assert.equal(decoded.fin, true, `fin at size ${size}`);
      assert.equal(decoded.masked, false, `masked at size ${size}`);
      assert.equal(decoded.payload.length, size);
      assert.ok(decoded.payload.equals(payload), `payload content at size ${size}`);
    }
  });

  it("round-trips a string payload", () => {
    const decoded = decodeFrame(encodeFrame(OPCODE_TEXT, "héllo ws"));
    assert.equal(decoded.payload.toString("utf-8"), "héllo ws");
  });

  it("decodes a masked client frame by applying the 4-byte XOR mask", () => {
    const payload = Buffer.from("Hello, mask!");
    const frame = buildMaskedFrame(OPCODE_TEXT, payload, MASK_KEY);
    assert.equal(frame[1] & 0x80, 0x80, "mask bit is set on the wire");
    const decoded = decodeFrame(frame);
    assert.equal(decoded.masked, true);
    assert.equal(decoded.opcode, OPCODE_TEXT);
    assert.ok(decoded.payload.equals(payload));
  });

  it("rejects decoding a frame whose declared payload exceeds MAX_FRAME_BYTES", () => {
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE_TEXT;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 6);
    assert.throws(() => decodeFrame(header), /MAX_FRAME_BYTES/);
  });

  it("rejects encoding a payload larger than MAX_FRAME_BYTES", () => {
    assert.throws(
      () => encodeFrame(OPCODE_TEXT, Buffer.alloc(MAX_FRAME_BYTES + 1)),
      /MAX_FRAME_BYTES/,
    );
  });

  it("throws on a truncated frame", () => {
    assert.throws(() => decodeFrame(Buffer.from([0x81, 5, 0x68])), /incomplete/i);
  });

  it("encodes a close frame with a 2-byte status code", () => {
    const frame = encodeFrame(OPCODE_CLOSE, Buffer.from([0x03, 0xe8]));
    assert.equal(frame[0], 0x88, "fin bit + close opcode");
    assert.equal(frame[1], 2, "unmasked 7-bit length of the status code");
    assert.equal(frame.readUInt16BE(2), 1000);
    const decoded = decodeFrame(frame);
    assert.equal(decoded.opcode, OPCODE_CLOSE);
    assert.equal(decoded.payload.length, 2);
    assert.equal(decoded.payload.readUInt16BE(0), 1000);
  });
});

// ---------- integration: real http server + raw socket client ----------

describe("attachWsServer", () => {
  it("handshakes, echoes a masked text frame, answers ping with pong, and reports close", async () => {
    const live = await listenHttp();
    const connections: WsConnection[] = [];
    const closed: WsConnection[] = [];
    const messages: Array<{ connection: WsConnection; message: unknown }> = [];
    attachWsServer(live.server, {
      onConnection: (connection) => connections.push(connection),
      onMessage: (connection, message) => {
        messages.push({ connection, message });
        connection.send({ echo: message });
      },
      onClose: (connection) => closed.push(connection),
      pingIntervalMs: 60_000,
    });

    const client = await WsTestClient.connect(portOf(live));

    // Non-JSON text frames are silently ignored (prototype behavior)…
    client.sendMaskedText("this is not json {{{");
    // …and a masked text frame is JSON.parsed and echoed back as server JSON.
    client.sendMaskedText(JSON.stringify({ hello: "world" }));
    const echoed = await client.next();
    assert.equal(echoed.opcode, OPCODE_TEXT);
    assert.deepEqual(JSON.parse(echoed.payload.toString("utf-8")), { echo: { hello: "world" } });

    await waitFor(() => messages.length === 1, "the onMessage callback");
    assert.equal(connections.length, 1);
    assert.deepEqual(messages[0]!.message, { hello: "world" });
    assert.equal(messages[0]!.connection, connections[0]);

    // A masked ping gets an unmasked pong with the same application payload.
    client.sendMaskedFrame(OPCODE_PING, Buffer.from("keepalive"));
    const pong = await client.next();
    assert.equal(pong.opcode, OPCODE_PONG);
    assert.ok(pong.payload.equals(Buffer.from("keepalive")));

    // Close handshake: server echoes a close frame, ends the socket, fires onClose once.
    client.sendClose(1000);
    const bye = await client.next();
    assert.equal(bye.opcode, OPCODE_CLOSE);
    assert.equal(bye.payload.readUInt16BE(0), 1000);
    await client.waitClosed();
    await waitFor(() => closed.length === 1, "the onClose callback");
  });

  it("drops a connection that misses 2 consecutive pongs", async () => {
    const live = await listenHttp();
    const closed: WsConnection[] = [];
    attachWsServer(live.server, {
      onConnection: () => {},
      onClose: (connection) => closed.push(connection),
      pingIntervalMs: 25,
    });

    const client = await WsTestClient.connect(portOf(live));
    const started = Date.now();
    await client.waitClosed();
    assert.ok(Date.now() - started < 2_000, "connection dropped well before the timeout");
    await waitFor(() => closed.length === 1, "the onClose callback after missed pongs");
    client.destroy();
  });

  it("rejects upgrades to any path other than /ws", async () => {
    const live = await listenHttp();
    attachWsServer(live.server, { onConnection: () => {} });

    const socket = net.connect({ host: "127.0.0.1", port: portOf(live) });
    try {
      await once(socket, "connect");
      socket.write(
        `GET /other HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${RFC_SAMPLE_KEY}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
      const response = await readHttpResponse(socket);
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.doesNotMatch(response, /101/);
    } finally {
      socket.destroy();
    }
  });
});
