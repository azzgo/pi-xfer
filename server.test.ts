/**
 * Run via `npm test` in this directory. Real unix socket inside a per-run mkdtemp;
 * every client socket is destroyed and the server closed before its test ends, so
 * the suite never leaks handles between tests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createServer, listenServer } from "./server.js";
import type { XferNotifyMessage } from "./types.js";

const NOOP_CALLBACKS = {
  notifyError: () => {},
  setStatus: () => {},
  onListening: () => {},
};

function makeFrame(summary: string): XferNotifyMessage {
  return {
    type: "xfer-notify",
    msg_id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    from: "pi",
    file: "/tmp/handoff.md",
    summary,
  };
}

/** Close a server and resolve once its handle is released. */
/** Resolve with the first newline-terminated line the socket receives. */
function readLine(socket: net.Socket, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`no line within ${timeoutMs}ms; buffered: ${JSON.stringify(buf)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(buf.slice(0, nl));
    };
    socket.on("data", onData);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("listenServer (unix regression)", () => {
  it("binds, chmods 0600 and serves frame+ack over a unix socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-unix-test-"));
    const sockPath = path.join(dir, "agent.sock");
    const delivered: XferNotifyMessage[] = [];
    const server = createServer({ deliver: (msg) => { delivered.push(msg); } });
    const frame = makeFrame("unix round-trip");
    try {
      await listenServer({
        server,
        path: sockPath,
        name: "test-agent",
        ...NOOP_CALLBACKS,
      });
      assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);

      const client = net.connect({ path: sockPath });
      try {
        await once(client, "connect");
        client.write(JSON.stringify(frame) + "\n");
        const ackLine = await readLine(client);
        assert.deepEqual(JSON.parse(ackLine), { type: "ack", msg_id: frame.msg_id });
        await waitFor(() => delivered.length > 0, "the deliver callback");
        assert.deepEqual(delivered, [frame]);
      } finally {
        client.destroy();
      }
    } finally {
      await closeServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
