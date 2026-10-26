/**
 * bag.test.ts — integration tests for the staging bag (cross-page staging):
 * annotation.stage → bag.list → bag.submit, the per-page handoff doc, and the
 * lifecycle rules from the glossary (no dedup, broker-assigned ids, sending
 * consumes the bag, failure keeps it).
 *
 * Harness mirrors page-tool.test.ts: broker in-process on an ephemeral port
 * with an isolated xfer dir; the receiving session is a fake unix-socket
 * peer; tabs are raw-socket RFC 6455 clients.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { startBroker, type BrokerHandle } from "../../daemon/broker-main.js";
import { decodeFrame, OPCODE_TEXT, type DecodedFrame } from "./ws-server.ts";

// ---------- in-process broker harness (same shape as page-tool.test.ts) ----------

const tmpDirs: string[] = [];
const socketServers: net.Server[] = [];
const brokerHandles: BrokerHandle[] = [];
const rawWsClients: { destroy(): void }[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-bag-"));
  tmpDirs.push(dir);
  return dir;
}

async function startTestBroker(): Promise<BrokerHandle & { xferDir: string }> {
  const xferDir = freshXferDir();
  const handle = await startBroker({ port: 0, xferDir });
  brokerHandles.push(handle);
  return { ...handle, xferDir };
}

afterEach(async () => {
  for (const handle of brokerHandles.splice(0)) await handle.close();
  for (const ws of rawWsClients.splice(0)) ws.destroy();
  for (const server of socketServers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- fake receiving session (same socket contract as broker-delivery) ----------

/** One fake xfer peer: listens on <name>.sock in xferDir, acks one notify line. */
async function fakeSession(xferDir: string, name: string): Promise<{ messages: string[]; waitAck: () => Promise<void> }> {
  const messages: string[] = [];
  let acked: (() => void) | null = null;
  const ackPromise = new Promise<void>((resolve) => { acked = resolve; });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        messages.push(line);
        const record = JSON.parse(line) as Record<string, unknown>;
        if (typeof record.msg_id === "string") {
          socket.write(`${JSON.stringify({ type: "ack", msg_id: record.msg_id })}\n`);
          acked?.();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path.join(xferDir, `${name}.sock`), resolve));
  socketServers.push(server);
  return { messages, waitAck: () => ackPromise };
}

// ---------- raw-socket WS client (trimmed copy of page-tool.test.ts's) ----------

const MASK_KEY = Buffer.from([0x12, 0x34, 0x56, 0x78]);

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const first = 0x80 | opcode;
  const header = payload.length < 126
    ? Buffer.from([first, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([first, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ MASK_KEY[i & 3]!;
  return Buffer.concat([header, MASK_KEY, masked]);
}

class RawWs {
  private socket: net.Socket;
  constructor(socket: net.Socket) { this.socket = socket; }
  queue: DecodedFrame[] = [];
  waiters: ((frame: DecodedFrame) => void)[] = [];

  static async connect(port: number): Promise<RawWs> {
    const key = Buffer.from("0123456789abcdef");
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const ws = new RawWs(socket);
    socket.on("data", (chunk: Buffer) => {
      try { ws.queue.push(decodeFrame(chunk)); } catch { /* test client: ignore */ }
      const waiter = ws.waiters.shift();
      const frame = ws.queue.shift();
      if (waiter && frame) waiter(frame);
    });
    socket.write(
      "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key.toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ws;
  }

  next(timeoutMs = 2_000): Promise<DecodedFrame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  sendText(text: string): void {
    this.socket.write(maskedFrame(OPCODE_TEXT, Buffer.from(text, "utf-8")));
  }

  sendClose(): void {
    this.socket.write(maskedFrame(0x8, Buffer.alloc(0)));
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ---------- helpers ----------

function parseFrame(frame: DecodedFrame): Record<string, unknown> {
  assert.equal(frame.opcode, OPCODE_TEXT);
  return JSON.parse(frame.payload.toString("utf-8")) as Record<string, unknown>;
}

async function welcome(ws: RawWs, tabId: string): Promise<void> {
  ws.sendText(JSON.stringify({ v: 0, type: "hello", client: { tab: { id: tabId, url: "u", title: "t" } } }));
  const parsed = parseFrame(await ws.next());
  assert.equal(parsed.type, "welcome");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One well-formed staged marker for the given page. */
function stageFrame(id: string, tabId: string, url: string, title: string): Record<string, unknown> {
  return {
    v: 0,
    type: "annotation.stage",
    id,
    pick: { selector: `#sel-${id}`, xpath: `//x[${id}]`, rect: { x: 1, y: 2, w: 3, h: 4 }, note: `note ${id}` },
    page: { tabId, origin: new URL(url).origin, url, title, ts: 1_720_000_000_000 },
  };
}

async function sendAndAck(ws: RawWs, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  ws.sendText(JSON.stringify(frame));
  return parseFrame(await ws.next());
}

// ---------- tests ----------

describe("staging bag", () => {
  it("stage → list: broker assigns ids, keeps every entry (no dedup), list returns them all", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const first = await sendAndAck(tab, stageFrame("s1", "tab-1", "https://a.example.com/cart", "Cart"));
    assert.equal(first.type, "ack");
    assert.equal((first.result as { count?: number }).count, 1);
    const firstId = (first.result as { id?: string }).id!;
    assert.match(firstId, /^s[0-9a-z]+$/);

    // Same selector staged again → independent entry, not an overwrite.
    const second = await sendAndAck(tab, stageFrame("s2", "tab-1", "https://a.example.com/cart", "Cart"));
    assert.equal((second.result as { count?: number }).count, 2);
    assert.notEqual((second.result as { id?: string }).id, firstId);

    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    const items = (listed.result as { items?: Array<Record<string, unknown>> }).items!;
    assert.equal(items.length, 2);
    assert.equal((listed.result as { truncated?: boolean }).truncated, false);
    assert.equal((listed.result as { total?: number }).total, 2);
    assert.deepEqual(items.map((i) => i.id).sort(), [firstId, (second.result as { id?: string }).id].sort());
    assert.equal(items[0]!.tabId, "tab-1");
    assert.equal(items[0]!.url, "https://a.example.com/cart");
    assert.deepEqual((items[0]!.pick as Record<string, unknown>).rect, { x: 1, y: 2, w: 3, h: 4 });
  });

  it("stage with a malformed payload → invalid_payload; missing tabId → invalid_payload", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    tab.sendText(JSON.stringify({ v: 0, type: "annotation.stage", id: "bad1", pick: { selector: "#x" }, page: { tabId: "t" } }));
    let err = parseFrame(await tab.next());
    assert.equal(err.type, "error");
    assert.equal(err.code, "invalid_payload");

    tab.sendText(JSON.stringify({ v: 0, type: "annotation.stage", id: "bad2", pick: { selector: "#x", xpath: "//x", rect: { x: 0, y: 0, w: 1, h: 1 } }, page: { url: "u" } }));
    err = parseFrame(await tab.next());
    assert.equal(err.type, "error");
    assert.equal(err.code, "invalid_payload");

    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    assert.equal((listed.result as { items?: unknown[] }).items!.length, 0);
  });

  it("bag.submit on an empty bag → invalid_payload (the user decides, not the broker)", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const err = await sendAndAck(tab, { v: 0, type: "bag.submit", id: "b1", prompt: "go", target: { name: "alpha" } });
    assert.equal(err.type, "error");
    assert.equal(err.code, "invalid_payload");
    assert.match(String(err.message), /bag is empty/);
  });

  it("bag.submit: one doc per page section, delivered, bag cleared; failure keeps the bag", async () => {
    const daemon = await startTestBroker();
    const session = await fakeSession(daemon.xferDir, "alpha");
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    await sendAndAck(tab, stageFrame("s1", "tab-1", "https://a.example.com/cart", "Cart — A"));
    await sendAndAck(tab, stageFrame("s2", "tab-1", "https://a.example.com/cart", "Cart — A"));
    await sendAndAck(tab, stageFrame("s3", "tab-2", "https://b.example.com/checkout", "Checkout — B"));

    const submit = await sendAndAck(tab, {
      v: 0, type: "bag.submit", id: "b1", prompt: "look at these",
      target: { name: "alpha" },
    });
    assert.equal(submit.type, "ack");
    const handoffId = (submit.result as { handoff_id?: string }).handoff_id!;
    const docPath = (submit.result as { doc?: string }).doc!;
    await session.waitAck();
    assert.equal(session.messages.length, 1);

    const doc = fs.readFileSync(docPath, "utf-8");
    assert.match(doc, /# Web annotation handoff \(staging bag\)/);
    assert.match(doc, /## Page: Cart — A/);
    assert.match(doc, /## Page: Checkout — B/);
    assert.match(doc, /tabId: tab-1/);
    assert.match(doc, /tabId: tab-2/);
    assert.match(doc, /#sel-s1/);
    assert.match(doc, /#sel-s3/);
    assert.match(doc, /tab_unreachable/); // routing note: stop and ask, never retry

    // Sending consumes the bag (glossary) — a fresh list is empty.
    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l2" });
    assert.equal((listed.result as { items?: unknown[] }).items!.length, 0);
  });

  it("bag.list caps the snapshot at 100 newest entries and reports total/truncated", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    let lastId = "";
    for (let i = 0; i < 103; i++) {
      const ack = await sendAndAck(tab, stageFrame("s" + i, "tab-1", "https://a.example.com/p" + (i % 3), "Page " + (i % 3)));
      assert.equal(ack.type, "ack");
      lastId = (ack.result as { id?: string }).id ?? lastId;
    }
    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    const items = (listed.result as { items?: Array<Record<string, unknown>> }).items!;
    assert.equal(items.length, 100);
    assert.equal((listed.result as { total?: number }).total, 103);
    assert.equal((listed.result as { truncated?: boolean }).truncated, true);
    // newest first: the last staged id is the first item
    assert.equal((items[0] as { id?: string }).id, lastId);
  });

  it("bag.submit to a missing target → target_not_found; the bag is kept for retry", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    await sendAndAck(tab, stageFrame("s1", "tab-1", "https://a.example.com/cart", "Cart"));
    const err = await sendAndAck(tab, { v: 0, type: "bag.submit", id: "b1", prompt: "go", target: { name: "ghost" } });
    assert.equal(err.type, "error");
    assert.equal(err.code, "target_not_found");

    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    assert.equal((listed.result as { items?: unknown[] }).items!.length, 1);
  });

  it("bag.unstage deletes exactly one entry by id and reports the new count", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    const first = await sendAndAck(tab, stageFrame("s1", "tab-1", "https://a.example.com/cart", "Cart"));
    const keptId = (first.result as { id?: string }).id!;
    const second = await sendAndAck(tab, stageFrame("s2", "tab-1", "https://a.example.com/cart", "Cart"));
    const removedId = (second.result as { id?: string }).id!;

    const ack = await sendAndAck(tab, { v: 0, type: "bag.unstage", id: "u1", entryId: removedId });
    assert.equal(ack.type, "ack");
    assert.equal((ack.result as { id?: string }).id, removedId);
    assert.equal((ack.result as { count?: number }).count, 1);

    // The Bag is the broker's, so the delete really happened there — a fresh
    // list shows only the survivor (the drawer's guarantee).
    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    const items = (listed.result as { items?: Array<Record<string, unknown>> }).items!;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.id, keptId);

    // A second delete is a stale-drawer error, not a silent no-op.
    const again = await sendAndAck(tab, { v: 0, type: "bag.unstage", id: "u2", entryId: removedId });
    assert.equal(again.type, "error");
    assert.equal(again.code, "invalid_payload");
    assert.match(String(again.message), new RegExp(removedId));
  });

  it("bag.unstage without an entryId → invalid_payload, bag untouched", async () => {
    const daemon = await startTestBroker();
    const tab = await RawWs.connect(daemon.port);
    await welcome(tab, "tab-1");

    await sendAndAck(tab, stageFrame("s1", "tab-1", "https://a.example.com/cart", "Cart"));
    const err = await sendAndAck(tab, { v: 0, type: "bag.unstage", id: "u1" });
    assert.equal(err.type, "error");
    assert.equal(err.code, "invalid_payload");

    const listed = await sendAndAck(tab, { v: 0, type: "bag.list", id: "l1" });
    assert.equal((listed.result as { items?: unknown[] }).items!.length, 1);
  });
});
