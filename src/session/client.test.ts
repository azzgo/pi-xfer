/**
 * client.test.ts — what `sendNotify` promises about the ack it got: `delivered` only
 * when the receiver said so, `unknown` for anything weaker, and a rejection only when
 * the send never reached a session at all.
 *
 * Hermetic: a throwaway unix socket in a fresh `os.tmpdir()` directory, no pi, no
 * engine.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { sendNotify } from "./client.ts";

let dir: string;

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-client-test-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Bind a one-shot server on `<name>.sock` that answers with `ackLine` (or nothing). */
function peer(name: string, ackLine: string | null): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("error", () => { /* the sender may hang up */ });
    socket.on("data", () => {
      if (ackLine !== null) socket.write(ackLine);
      else socket.destroy();
    });
  });
  return new Promise((resolve) => {
    server.listen(path.join(dir, `${name}.sock`), () => resolve(server));
  });
}

const outbound = (id: string) => ({ type: "xfer-notify", msg_id: id, from: "me", file: "/dev/null", summary: "s" });

describe("sendNotify: what the ack is worth", () => {
  it("reports delivered when the receiver says so", async () => {
    const server = await peer("alpha", `${JSON.stringify({ type: "ack", msg_id: "a1", outcome: "delivered" })}\n`);
    try {
      assert.equal(await sendNotify("alpha", outbound("a1"), dir), "delivered");
    } finally { server.close(); }
  });

  it("reports unknown for an ack with no outcome field (older receiver)", async () => {
    const server = await peer("bravo", `${JSON.stringify({ type: "ack", msg_id: "b1" })}\n`);
    try {
      assert.equal(await sendNotify("bravo", outbound("b1"), dir), "unknown");
    } finally { server.close(); }
  });

  it("reports unknown for an outcome it does not recognise", async () => {
    const server = await peer("charlie", `${JSON.stringify({ type: "ack", msg_id: "c1", outcome: "queued" })}\n`);
    try {
      assert.equal(await sendNotify("charlie", outbound("c1"), dir), "unknown");
    } finally { server.close(); }
  });

  it("rejects when the connection dies before any ack", async () => {
    const server = await peer("delta", null);
    try {
      await assert.rejects(sendNotify("delta", outbound("d1"), dir), /closed before ack/);
    } finally { server.close(); }
  });

  it("rejects when no peer has that name", async () => {
    await assert.rejects(sendNotify("nobody", outbound("n1"), dir), /not found/);
  });
});
