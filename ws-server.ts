/**
 * Hand-rolled minimal RFC 6455 WebSocket subset for the xfer broker.
 *
 * Scope (matches ws-server.test.ts contract):
 *   - acceptKey(): SHA1 + magic GUID + base64 handshake accept value.
 *   - encodeFrame()/decodeFrame(): text (0x1), close (0x8), ping (0x9), pong (0xA);
 *     client->server frames are masked (mandatory unmask), server->client unmasked;
 *     7-bit / 16-bit / 64-bit payload lengths; > MAX_FRAME_BYTES rejected.
 *   - attachWsServer(): 'upgrade' handling on a node:http server — validates the
 *     path is /ws, answers 101 with the accept key, emits a {send, close}
 *     connection object, JSON.parses inbound text frames (parse errors silently
 *     ignored, per prototype), replies pong to ping, echoes close, and runs a
 *     server->client ping loop that drops a connection after 2 missed pongs.
 *
 * Zero dependencies: node:http + node:crypto only. No ws npm package.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";
import { MAX_FRAME_BYTES } from "./constants.js";

export const OPCODE_TEXT = 0x1;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/** RFC 6455 §1.3 magic GUID appended to the Sec-WebSocket-Key before SHA1. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const DEFAULT_PING_INTERVAL_MS = 30_000;
/** Connection is dropped after this many unanswered server pings in a row. */
const MISSED_PONG_LIMIT = 2;

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface WsConnection {
  /** Send a JSON-serializable object, a string, or raw bytes as a text frame. */
  send(message: unknown | string | Buffer): void;
  /** Send a close frame with an optional status code and end the socket. */
  close(code?: number): void;
}

export interface WsServerOptions {
  onConnection(connection: WsConnection): void;
  onMessage?(connection: WsConnection, message: unknown): void;
  onClose?(connection: WsConnection): void;
  /** Server->client ping interval; injectable for tests (default 30s). */
  pingIntervalMs?: number;
}

/** SHA1(key + magic GUID) base64 — RFC 6455 §4.2.2 accept-key computation. */
export function acceptKey(key: string): string {
  const digest = crypto.createHash("sha1").update(key + WS_GUID).digest();
  return digest.toString("base64");
}

/** Server->client (unmasked) frame encoding. Accepts Buffer or string payloads. */
export function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`payload exceeds MAX_FRAME_BYTES (${data.length} > ${MAX_FRAME_BYTES})`);
  }
  const first = 0x80 | opcode; // FIN set; server frames are never masked
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([first, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  return Buffer.concat([header, data]);
}

/** Decode one complete frame; throws on truncated input or oversized payloads. */
export function decodeFrame(buffer: Buffer): DecodedFrame {
  if (buffer.length < 2) throw new Error("incomplete frame: need at least 2 header bytes");
  const fin = (buffer[0]! & 0x80) !== 0;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let len7 = buffer[1]! & 0x7f;
  let offset = 2;
  if (len7 === 126) {
    if (buffer.length < 4) throw new Error("incomplete frame: missing 16-bit length");
    len7 = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len7 === 127) {
    if (buffer.length < 10) throw new Error("incomplete frame: missing 64-bit length");
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0 || low > MAX_FRAME_BYTES) {
      throw new Error(`payload exceeds MAX_FRAME_BYTES (${low} > ${MAX_FRAME_BYTES})`);
    }
    len7 = low;
    offset = 10;
  }
  if (len7 > MAX_FRAME_BYTES) {
    throw new Error(`payload exceeds MAX_FRAME_BYTES (${len7} > ${MAX_FRAME_BYTES})`);
  }
  let maskKey: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) throw new Error("incomplete frame: missing mask key");
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len7) throw new Error("incomplete frame: payload truncated");
  let payload = buffer.subarray(offset, offset + len7);
  if (masked && maskKey) {
    const unmasked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) {
      unmasked[i] = payload[i]! ^ maskKey[i & 3]!;
    }
    payload = unmasked;
  }
  return { fin, opcode, masked, payload };
}

/** Minimal per-connection frame buffer so chunk boundaries never split frames. */
interface FrameParser {
  buffer: Buffer;
}

function createParser(): FrameParser {
  return { buffer: Buffer.alloc(0) };
}

/**
 * Feed raw socket bytes into the parser; yields one complete frame per callback
 * invocation. Returns false when a frame fails to decode — i.e. an inbound
 * payload above MAX_FRAME_BYTES (the only way decodeFrame throws here, since
 * incomplete frames return before it is called) — so the caller can drop the
 * connection instead of silently stalling on the oversized bytes.
 */
function pumpFrames(
  parser: FrameParser,
  chunk: Buffer,
  onFrame: (frame: DecodedFrame) => boolean | void,
): boolean {
  parser.buffer = Buffer.concat([parser.buffer, chunk]);
  for (;;) {
    const buf = parser.buffer;
    if (buf.length < 2) return true;
    let headerLen: number;
    const len7 = buf[1]! & 0x7f;
    if (len7 === 126) headerLen = 4;
    else if (len7 === 127) headerLen = 10;
    else headerLen = 2;
    if (buf.length < headerLen) return true;
    const frameLen =
      headerLen +
      (len7 === 126
        ? buf.readUInt16BE(2)
        : len7 === 127
          ? buf.readUInt32BE(6)
          : len7) +
      ((buf[1]! & 0x80) !== 0 ? 4 : 0);
    if (buf.length < frameLen) return true;
    let frame: DecodedFrame;
    try {
      frame = decodeFrame(buf.subarray(0, frameLen));
    } catch {
      return false; // oversized / malformed — caller tears the connection down
    }
    parser.buffer = buf.subarray(frameLen);
    if (onFrame(frame) === false) return true; // close handled by the caller
  }
}

/**
 * Attach the WS upgrade handler to an existing node:http server.
 * Only upgrades to /ws are accepted; everything else gets an HTTP 400.
 */
export function attachWsServer(httpServer: http.Server, options: WsServerOptions): void {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

  httpServer.on("upgrade", (request, socket: Socket, head: Buffer) => {
    const url = request.url ?? "";
    const pathOnly = url.split("?")[0]!;
    if (pathOnly !== "/ws") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    let closed = false;
    let missedPongs = 0;
    const parser = createParser();
    if (head.length > 0) socket.unshift(head);

    const connection: WsConnection = {
      send(message: unknown | string | Buffer): void {
        if (closed || socket.destroyed) return;
        const data =
          typeof message === "string"
            ? message
            : message instanceof Buffer
              ? message
              : JSON.stringify(message);
        try {
          socket.write(encodeFrame(OPCODE_TEXT, data));
        } catch {
          // payload too large — drop the connection rather than corrupt the stream
          teardown();
        }
      },
      close(code = 1000): void {
        if (closed) return;
        try {
          const body = Buffer.alloc(2);
          body.writeUInt16BE(code, 0);
          socket.write(encodeFrame(OPCODE_CLOSE, body));
        } catch {
          // ignore encoding failures during teardown
        }
        teardown();
      },
    };

    function teardown(): void {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      try {
        socket.end();
      } catch {
        socket.destroy();
      }
      if (options.onClose) options.onClose(connection);
    }

    const pingTimer = setInterval(() => {
      if (closed || socket.destroyed) return;
      if (missedPongs >= MISSED_PONG_LIMIT) {
        teardown();
        return;
      }
      try {
        socket.write(encodeFrame(OPCODE_PING, Buffer.alloc(0)));
      } catch {
        teardown();
        return;
      }
      missedPongs++;
    }, pingIntervalMs);
    // Do not keep the event loop alive just for keepalive pings.
    if (typeof pingTimer.unref === "function") pingTimer.unref();

    options.onConnection(connection);

    socket.on("data", (chunk: Buffer) => {
      const ok = pumpFrames(parser, chunk, (frame) => {
        switch (frame.opcode) {
          case OPCODE_TEXT: {
            let message: unknown;
            try {
              message = JSON.parse(frame.payload.toString("utf-8"));
            } catch {
              return; // non-JSON text frames silently ignored (prototype behavior)
            }
            if (options.onMessage) options.onMessage(connection, message);
            return;
          }
          case OPCODE_PING:
            if (!closed) {
              try {
                socket.write(encodeFrame(OPCODE_PONG, frame.payload));
              } catch {
                /* ignore */
              }
            }
            return;
          case OPCODE_PONG:
            missedPongs = 0;
            return;
          case OPCODE_CLOSE:
            connection.close(1000);
            return false; // stop parsing after close
          default:
            return; // unknown/continuation frames ignored in this subset
        }
      });
      if (!ok) {
        console.log("[ws] dropping connection: inbound frame exceeds MAX_FRAME_BYTES");
        connection.close(1009); // 1009 = message too big
      }
    });

    socket.on("error", () => {
      if (!closed) teardown();
    });
    socket.on("close", () => {
      if (!closed) teardown();
    });
  });
}
