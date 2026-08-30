/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts).
 * Real sockets only: TCP tests bind 127.0.0.1 ephemeral ports, the unix regression binds
 * a socket inside a per-run mkdtemp. Every client socket is destroyed and every server
 * closed before its test ends, so the suite never leaks handles between tests.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { XferController } from "./controller.js";
import { createServer, listenServer } from "./server.js";
import type { ListenEndpoint } from "./server.js";
import { XferState } from "./state.js";
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

/** Bind a fresh frame server on 127.0.0.1 (ephemeral unless `port` given). */
async function listenTcp(
  deliver: (msg: XferNotifyMessage) => void,
  endpoint: Extract<ListenEndpoint, { kind: "tcp" }> = { kind: "tcp", host: "127.0.0.1", port: 0 },
): Promise<net.Server> {
  const server = createServer({ deliver });
  await listenServer({ server, endpoint, name: "test-agent", ...NOOP_CALLBACKS });
  return server;
}

function tcpPort(server: net.Server): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "expected a bound TCP AddressInfo");
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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

/** Rebind a specific port; retries briefly on EADDRINUSE in case the OS is still
 *  tearing down the previous listener. A genuinely unreleased port still fails. */
async function rebindOnPort(port: number): Promise<net.Server> {
  for (let attempt = 0; ; attempt++) {
    const server = createServer({ deliver: () => {} });
    try {
      await listenServer({
        server,
        endpoint: { kind: "tcp", host: "127.0.0.1", port },
        name: "test-agent",
        ...NOOP_CALLBACKS,
      });
      return server;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("listenServer (tcp)", () => {
  it("binds an ephemeral port and fires onListening", async () => {
    const fired: string[] = [];
    const server = createServer({ deliver: () => {} });
    try {
      await listenServer({
        server,
        endpoint: { kind: "tcp", host: "127.0.0.1", port: 0 },
        name: "test-agent",
        ...NOOP_CALLBACKS,
        onListening: () => { fired.push("listening"); },
      });
      assert.ok(server.listening);
      assert.ok(tcpPort(server) > 0);
      assert.deepEqual(fired, ["listening"]);
    } finally {
      await closeServer(server);
    }
  });

  it("serves a frame over TCP: deliver fires and the client gets its ack line", async () => {
    const delivered: XferNotifyMessage[] = [];
    const server = await listenTcp((msg) => { delivered.push(msg); });
    const frame = makeFrame("tcp round-trip");
    try {
      const client = net.connect({ host: "127.0.0.1", port: tcpPort(server) });
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
    }
  });

  it("rejects with EADDRINUSE when the tcp port is already taken", async () => {
    const first = await listenTcp(() => {});
    try {
      const port = tcpPort(first);
      const second = createServer({ deliver: () => {} });
      await assert.rejects(
        listenServer({
          server: second,
          endpoint: { kind: "tcp", host: "127.0.0.1", port },
          name: "test-agent",
          ...NOOP_CALLBACKS,
        }),
        (error: NodeJS.ErrnoException) => {
          assert.equal(error.code, "EADDRINUSE");
          return true;
        },
      );
    } finally {
      await closeServer(first);
    }
  });

  it("releases the port after close so the same port can be rebound", async () => {
    const server = await listenTcp(() => {});
    const port = tcpPort(server);
    await closeServer(server);
    assert.ok(!server.listening);

    const rebound = await rebindOnPort(port);
    try {
      assert.equal(tcpPort(rebound), port);
    } finally {
      await closeServer(rebound);
    }
  });
});

describe("XferController bridge listener", () => {
  it("serves frames over TCP through the session delivery, then stops and rebinds", async () => {
    const captured: unknown[] = [];
    const stubPi = { sendMessage: (msg: unknown) => { captured.push(msg); } } as never;
    const controller = new XferController(stubPi, new XferState());
    const frame = makeFrame("bridge round-trip");

    try {
      const bridge = await controller.startBridgeListener();
      assert.equal(bridge.host, "127.0.0.1");
      assert.ok(bridge.port > 0);
      assert.ok(bridge.server.listening);
      // The bridge listener is independent of the unix identity.
      assert.equal(controller.state.identity, null);

      const client = net.connect({ host: bridge.host, port: bridge.port });
      try {
        await once(client, "connect");
        client.write(JSON.stringify(frame) + "\n");
        const ackLine = await readLine(client);
        assert.deepEqual(JSON.parse(ackLine), { type: "ack", msg_id: frame.msg_id });
        await waitFor(() => captured.length > 0, "the xfer-inbound message");
        const msg = captured[0] as { customType?: string };
        assert.equal(msg.customType, "xfer-inbound");
      } finally {
        client.destroy();
      }

      await controller.stopBridgeListener();
      assert.ok(!bridge.server.listening);

      // The port is really released: a fresh server can bind it again.
      const rebound = await rebindOnPort(bridge.port);
      await closeServer(rebound);
    } finally {
      await controller.stopBridgeListener();
    }

    // Idempotent: a second stop with nothing running resolves.
    await controller.stopBridgeListener();
  });
});

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
        endpoint: { kind: "unix", path: sockPath },
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
