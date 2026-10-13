import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultAdapterName, startAdapterd } from "./adapterd.src/daemon.js";
import { appendInbox, inboxPathForName, listInbox, takeInbox, type InboxRecord } from "./adapterd.src/inbox.js";
import { sendNotify } from "./client.js";
import { endpointForName, metadataForName, msgId } from "./utils.js";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-adapterd-test-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function freshDir(): string {
  return fs.mkdtempSync(path.join(tmpDir, "case-"));
}

function record(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: msgId(),
    from: "sender",
    to: "receiver",
    summary: "do the thing",
    file: "/tmp/does-not-exist.md",
    document: null,
    transport: "local",
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

describe("adapterd inbox", () => {
  it("take consumes each line exactly once", () => {
    const dir = freshDir();
    const inbox = inboxPathForName("agent-a", dir);
    appendInbox(record({ id: "1" }), inbox);
    appendInbox(record({ id: "2" }), inbox);
    assert.deepEqual(takeInbox(inbox).map((r) => r.id), ["1", "2"]);
    assert.deepEqual(takeInbox(inbox), []);
    assert.deepEqual(listInbox(inbox), []);
  });

  it("a concurrent append during take survives", () => {
    const dir = freshDir();
    const inbox = inboxPathForName("agent-a", dir);
    appendInbox(record({ id: "first" }), inbox);
    assert.deepEqual(takeInbox(inbox).map((r) => r.id), ["first"]);
    appendInbox(record({ id: "during" }), inbox);
    assert.deepEqual(listInbox(inbox).map((r) => r.id), ["during"]);
    assert.deepEqual(takeInbox(inbox).map((r) => r.id), ["during"]);
  });

  it("list is a peek that never consumes", () => {
    const dir = freshDir();
    const inbox = inboxPathForName("agent-a", dir);
    appendInbox(record({ id: "peek" }), inbox);
    assert.deepEqual(listInbox(inbox).map((r) => r.id), ["peek"]);
    assert.deepEqual(listInbox(inbox).map((r) => r.id), ["peek"]);
  });

  it("missing inbox is empty, never an error", () => {
    assert.deepEqual(listInbox(path.join(freshDir(), "nope.jsonl")), []);
    assert.deepEqual(takeInbox(path.join(freshDir(), "nope.jsonl")), []);
  });
});

describe("adapterd daemon", () => {
  it("binds the socket, writes peer metadata, appends the inbox and acks", async () => {
    const dir = freshDir();
    const handle = await startAdapterd({ name: "agent-a", dir, host: "cursor" });
    try {
      assert.ok(fs.existsSync(handle.endpoint), "socket exists");
      const metadata = JSON.parse(fs.readFileSync(handle.metadataPath, "utf-8"));
      assert.equal(metadata.xferName, "agent-a");
      assert.equal(metadata.kind, "adapterd");
      assert.equal(metadata.host, "cursor");
      assert.equal(metadata.inbox, handle.inboxPath);
      assert.equal(metadata.pid, process.pid);

      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "# Handoff\n\nbody");
      await sendNotify("agent-a", { type: "xfer-notify", msg_id: "m1", from: "sender", file: doc, summary: "check auth" }, dir);

      const taken = takeInbox(handle.inboxPath);
      assert.equal(taken.length, 1);
      assert.equal(taken[0].id, "m1");
      assert.equal(taken[0].from, "sender");
      assert.equal(taken[0].to, "agent-a");
      assert.equal(taken[0].document, "# Handoff\n\nbody");
      assert.equal(taken[0].transport, "local");
      assert.deepEqual(takeInbox(handle.inboxPath), [], "ack only after inbox is durable");
    } finally {
      await handle.close();
    }
    assert.ok(!fs.existsSync(handle.endpoint));
    assert.ok(!fs.existsSync(handle.metadataPath));
  });

  it("spawns --on-handoff with the handoff JSON on stdin and the env stamps", async () => {
    const dir = freshDir();
    const captured = path.join(dir, "captured.json");
    const handle = await startAdapterd({
      name: "agent-a",
      dir,
      onHandoff: `cat > "${captured}"`,
    });
    try {
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "hello");
      await sendNotify("agent-a", { type: "xfer-notify", msg_id: "m2", from: "sender", file: doc, summary: "s" }, dir);
      await handle.pendingHandoffs();
      const payload = JSON.parse(fs.readFileSync(captured, "utf-8"));
      assert.equal(payload.id, "m2");
      assert.equal(payload.document, "hello");
    } finally {
      await handle.close();
    }
  });

  it("a failing deliver strategy does not kill the daemon", async () => {
    const dir = freshDir();
    const handle = await startAdapterd({ name: "agent-a", dir, onHandoff: "definitely-not-a-real-command-xyz" });
    try {
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "x");
      await sendNotify("agent-a", { type: "xfer-notify", msg_id: "m3", from: "sender", file: doc, summary: "s" }, dir);
      await handle.pendingHandoffs();
      assert.equal(listInbox(handle.inboxPath).length, 1);
      // still serving
      await sendNotify("agent-a", { type: "xfer-notify", msg_id: "m4", from: "sender", file: doc, summary: "s" }, dir);
      assert.equal(listInbox(handle.inboxPath).length, 2);
    } finally {
      await handle.close();
    }
  });

  it("--once delivers one handoff then shuts down", async () => {
    const dir = freshDir();
    let resolveOnce: () => void = () => {};
    const once = new Promise<void>((resolve) => { resolveOnce = resolve; });
    const handle = await startAdapterd({ name: "agent-a", dir, once: true, onOnce: resolveOnce });
    const doc = path.join(dir, "handoff.md");
    fs.writeFileSync(doc, "body");
    await sendNotify("agent-a", { type: "xfer-notify", msg_id: "once-1", from: "sender", file: doc, summary: "s" }, dir);
    await once;
    assert.ok(!fs.existsSync(handle.endpoint), "socket removed after --once");
    assert.equal(takeInbox(handle.inboxPath).length, 1);
  });

  it("send fails with a clear error when the target has no socket", async () => {
    const dir = freshDir();
    await assert.rejects(
      () => sendNotify("nobody", { type: "xfer-notify", msg_id: "x", from: "me", file: "/dev/null", summary: "s" }, dir),
      /peer "nobody" not found/,
    );
  });

  it("defaults to an agent- prefixed name", () => {
    assert.equal(defaultAdapterName("/tmp/some-project"), "agent-some-project");
    assert.match(defaultAdapterName("/"), /^agent-/);
  });
});

describe("xfer-adapterd CLI smoke", () => {
  const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");

  it("up --once serves a send, then exits 0 with the record in the inbox", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-smoke", "--once", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitFor(() => fs.existsSync(endpointForName("agent-smoke", dir)), 10000);
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "cli body");
      await sendNotify("agent-smoke", { type: "xfer-notify", msg_id: "cli-1", from: "sender", file: doc, summary: "s" }, dir);
      const code = await waitExit(child);
      assert.equal(code, 0, `stderr: ${stderr}`);
      assert.equal(takeInbox(inboxPathForName("agent-smoke", dir))[0]?.document, "cli body");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("SIGTERM drains gracefully, removing socket and metadata", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-sig", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitFor(() => fs.existsSync(endpointForName("agent-sig", dir)), 10000);
      child.kill("SIGTERM");
      const code = await waitExit(child);
      assert.equal(code, 0);
      assert.ok(!fs.existsSync(endpointForName("agent-sig", dir)));
      assert.ok(!fs.existsSync(metadataForName("agent-sig", dir)));
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
