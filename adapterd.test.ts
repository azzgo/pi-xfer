import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultAdapterName, startAdapterd } from "./adapterd.src/daemon.js";
import { appendInbox, inboxPathForName, listInbox, takeInbox, type InboxRecord } from "./adapterd.src/inbox.js";
import { sendNotify } from "./client.js";
import { encodeAgentName } from "./utils.js";
import type { MeshEngine, MeshNodeInfo } from "./mesh-engine.js";
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

interface FakeMeshState {
  nodes: MeshNodeInfo[];
  destroyed: string[];
  stopped: number;
}

function fakeMeshEngine(state: FakeMeshState): MeshEngine {
  return {
    async ensureNode(name) {
      const existing = state.nodes.find((n) => n.name === name);
      if (existing) {
        state.nodes = state.nodes.map((n) => (n.name === name ? { ...n, status: "Running" } : n));
      } else {
        state.nodes.push({ name, actorId: `actor-${name}`, status: "Running" });
      }
    },
    async stop() { state.stopped += 1; },
    async listNodes() { return [...state.nodes]; },
    async destroyNode(actorId) {
      state.destroyed.push(actorId);
      state.nodes = state.nodes.filter((n) => n.actorId !== actorId);
    },
    async queueSend() {},
    async setDescription() { return ""; },
    async getDescription() { return ""; },
  };
}

function meshOptions(state: FakeMeshState, configPath: string) {
  return { configPath, config: { endpoint: "http://localhost:6420" }, engineFactory: () => fakeMeshEngine(state) };
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

describe("adapterd mesh adoption", () => {
  it("joins the mesh and destroys its actor on close", async () => {
    const dir = freshDir();
    const state: FakeMeshState = { nodes: [], destroyed: [], stopped: 0 };
    const handle = await startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused") });
    assert.equal(handle.meshOnline, true);
    assert.deepEqual(state.nodes.map((n) => n.name), ["agent-a"]);
    await handle.close();
    assert.deepEqual(state.destroyed, ["actor-agent-a"]);
    assert.equal(state.stopped, 1);
  });

  it("a second daemon adopts an actor left Sleeping by a crashed first daemon", async () => {
    const dir = freshDir();
    const state: FakeMeshState = { nodes: [{ name: "agent-a", actorId: "actor-agent-a", status: "Sleeping" }], destroyed: [], stopped: 0 };
    const handle = await startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused") });
    assert.equal(handle.meshOnline, true);
    assert.deepEqual(state.destroyed, [], "adoption never destroys the sleeping actor");
    assert.equal(state.nodes[0]?.status, "Running");
    await handle.close();
    assert.deepEqual(state.destroyed, ["actor-agent-a"]);
  });

  it("refuses to join a Running actor on another host and leaves no socket behind", async () => {
    const dir = freshDir();
    const state: FakeMeshState = { nodes: [{ name: "agent-a", actorId: "actor-agent-a", status: "Running" }], destroyed: [], stopped: 0 };
    await assert.rejects(
      () => startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused") }),
      /already Running on another host/,
    );
    assert.ok(!fs.existsSync(endpointForName("agent-a", dir)), "socket is cleaned up");
    assert.ok(!fs.existsSync(metadataForName("agent-a", dir)), "metadata is cleaned up");
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
  it("mesh send without a config errors clearly and needs no daemon", async () => {
    const dir = freshDir();
    const file = path.join(dir, "handoff.md");
    fs.writeFileSync(file, "body");
    const child = spawn(
      process.execPath,
      [bundle, "mesh", "send", "remote", file, "summary", "--mesh-config", path.join(dir, "missing.json")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await waitExit(child);
    assert.equal(code, 1);
    assert.match(stderr, /mesh is not configured/);
  });

});

describe("adapterd CLI: inbox with an explicit --name", () => {
  const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const freshDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-adapterd-inbox-")); dirs.push(d); return d; };

  function runCli(args: string[], dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [bundle, ...args, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => { stdout += c; });
    child.stderr!.on("data", (c: Buffer) => { stderr += c; });
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  }

  it("fails with a start hint when the named daemon never started", async () => {
    const dir = freshDir();
    const r = await runCli(["inbox", "list", "--name", "never-started"], dir);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no daemon "never-started"/);
    assert.match(r.stderr, /up --name never-started/);

    const t = await runCli(["inbox", "take", "--name", "never-started"], dir);
    assert.notEqual(t.code, 0);
    assert.match(t.stderr, /no daemon "never-started"/);
  });

  it("still succeeds with an empty list once the daemon exists", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, `${encodeAgentName("known")}.sock`), "");
    const r = await runCli(["inbox", "list", "--name", "known"], dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});
