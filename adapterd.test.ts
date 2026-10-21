import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultAdapterName, startAdapterd } from "./adapterd.src/daemon.js";
import { failedSendOutcome, meshFailureOutcome } from "./adapterd.src/main.js";
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

/**
 * Resolve once a daemon's Unix socket can actually be connected to.
 *
 * `fs.existsSync(sock)` is not that moment: `bind()` creates the file before
 * `listen()` starts accepting, so connecting in that window gets ECONNREFUSED.
 * Anything that sends right after the socket appears has to wait for a
 * successful connect — retried until the budget runs out, because the window is
 * real but short.
 */
async function waitForSocket(sockPath: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  let lastError = "never attempted";
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(sockPath)) return;
    lastError = `connect to ${sockPath} failed`;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${sockPath} to accept connections (${lastError})`);
}

function canConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: sockPath });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function waitExit(child: ChildProcess, timeoutMs = 20000): Promise<number | null> {
  // A child that already exited has emitted its one `exit` event, so attaching
  // a listener now would wait forever.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    // A child that never exits would otherwise hang the whole run with no
    // output; failing loudly names the test instead.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
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

function meshOptions(state: FakeMeshState, configPath: string, logPath: string) {
  return {
    configPath,
    config: { endpoint: "http://localhost:6420" },
    engineFactory: () => fakeMeshEngine(state),
    logPath,
  };
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
    const handle = await startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused", path.join(dir, "mesh.log")) });
    assert.equal(handle.meshOnline, true);
    assert.deepEqual(state.nodes.map((n) => n.name), ["agent-a"]);
    await handle.close();
    assert.deepEqual(state.destroyed, ["actor-agent-a"]);
    assert.equal(state.stopped, 1);
  });

  it("a second daemon adopts an actor left Sleeping by a crashed first daemon", async () => {
    const dir = freshDir();
    const state: FakeMeshState = { nodes: [{ name: "agent-a", actorId: "actor-agent-a", status: "Sleeping" }], destroyed: [], stopped: 0 };
    const handle = await startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused", path.join(dir, "mesh.log")) });
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
      () => startAdapterd({ name: "agent-a", dir, mesh: meshOptions(state, "unused", path.join(dir, "mesh.log")) }),
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
      await waitForSocket(endpointForName("agent-smoke", dir));
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

  it("declares the sender's cwd and its own kind over the doc's, leaving the original alone", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-stamp", "--once", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForSocket(endpointForName("agent-stamp", dir));
      fs.writeFileSync(metadataForName("agent-sender", dir), JSON.stringify({ xferName: "agent-sender", cwd: "/srv/app" }));
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "kind: notification\n# Doc\n");
      const sender = spawn(process.execPath, [bundle, "send", "agent-stamp", doc, "s", "--kind", "task", "--from", "agent-sender", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
      let sendErr = "";
      sender.stderr?.on("data", (chunk) => { sendErr += chunk.toString(); });
      assert.equal(await waitExit(sender), 0, `stderr: ${sendErr}`);
      assert.equal(await waitExit(child), 0, `stderr: ${stderr}`);
      const delivered = takeInbox(inboxPathForName("agent-stamp", dir))[0]?.document ?? "";
      assert.match(delivered, /^<!-- xfer:sender-cwd cwd=\/srv\/app project=app machine=[^ ]+ -->\nkind: task\n# Doc\n$/);
      assert.equal(fs.readFileSync(doc, "utf-8"), "kind: notification\n# Doc\n");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("leaves an unknown sender unstamped rather than guessing a cwd", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-plain", "--once", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForSocket(endpointForName("agent-plain", dir));
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "plain body");
      const sender = spawn(process.execPath, [bundle, "send", "agent-plain", doc, "s", "--kind", "task", "--from", "agent-unknown", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(await waitExit(sender), 0);
      assert.equal(await waitExit(child), 0, `stderr: ${stderr}`);
      assert.equal(takeInbox(inboxPathForName("agent-plain", dir))[0]?.document, "kind: task\nplain body");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("refuses to send without a kind, because silence is not a failure the sender sees", async () => {
    const dir = freshDir();
    const doc = path.join(dir, "handoff.md");
    fs.writeFileSync(doc, "kind: task\nbody");
    const child = spawn(
      process.execPath,
      [bundle, "send", "nowhere", doc, "summary", "--dir", dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    assert.equal(await waitExit(child), 1);
    assert.match(stderr, /--kind must be "task" or "notification"/);
  });

  it("refuses a kind it does not recognise", async () => {
    const dir = freshDir();
    const doc = path.join(dir, "handoff.md");
    fs.writeFileSync(doc, "body");
    const child = spawn(
      process.execPath,
      [bundle, "send", "nowhere", doc, "summary", "--kind", "maybe", "--dir", dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    assert.equal(await waitExit(child), 1);
    assert.match(stderr, /--kind must be "task" or "notification"/);
  });

  it("SIGTERM drains gracefully, removing socket and metadata", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-sig", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitForSocket(endpointForName("agent-sig", dir));
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
      [bundle, "mesh", "send", "remote", file, "summary", "--kind", "task", "--mesh-config", path.join(dir, "missing.json")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await waitExit(child);
    assert.equal(code, 1);
    assert.match(stderr, /mesh is not configured/);
  });

  it("mesh down without a config errors clearly", async () => {
    const dir = freshDir();
    const child = spawn(
      process.execPath,
      [bundle, "mesh", "down", "--name", "doubao", "--dir", dir, "--mesh-config", path.join(dir, "missing.json")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    assert.equal(await waitExit(child), 1);
    assert.match(stderr, /mesh is not configured/);
  });

  it("mesh down says so when no adapter daemon owns that directory", async () => {
    const dir = freshDir();
    const child = spawn(
      process.execPath,
      [bundle, "mesh", "down", "--dir", dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    assert.equal(await waitExit(child), 1);
    assert.match(stderr, /no adapter daemon found/);
  });
describe("xfer-adapterd CLI: probing never leaves a daemon behind", () => {
  const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");

  /**
   * `up --help` used to ignore the flag, bind a socket, and block forever — a
   * host agent probing the CLI hung for five hours with no output. The probe
   * must print usage and leave.
   */
  it("--help prints usage and exits without binding a socket", async () => {
    const dir = freshDir();
    const child = spawn(
      process.execPath,
      [bundle, "up", "--help", "--name", "agent-help", "--dir", dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    assert.equal(await waitExit(child), 0);
    assert.match(stdout, /xfer-adapterd — adapt a non-pi Agent Host/);
    assert.ok(!fs.existsSync(endpointForName("agent-help", dir)), "--help must not bind a socket");
  });

  it("--help works with no subcommand at all", async () => {
    const child = spawn(process.execPath, [bundle, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    assert.equal(await waitExit(child), 0);
    assert.match(stdout, /xfer-adapterd — adapt a non-pi Agent Host/);
  });

  it("up --check reports what came up, then leaves nothing running", async () => {
    const dir = freshDir();
    const child = spawn(
      process.execPath,
      [bundle, "up", "--name", "agent-check", "--check", "--dir", dir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    assert.equal(await waitExit(child), 0);
    assert.match(stdout, /xfer-adapterd up as "agent-check"/);
    assert.ok(!fs.existsSync(endpointForName("agent-check", dir)), "--check must not leave a socket");
    assert.ok(!fs.existsSync(metadataForName("agent-check", dir)), "--check must not leave metadata");
  });
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

describe("xfer-adapterd CLI: list", () => {
  const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const freshDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-adapterd-list-")); dirs.push(d); return d; };

  function runCli(args: string[], dir: string, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [bundle, ...args, "--dir", dir], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => { stdout += c; });
    child.stderr!.on("data", (c: Buffer) => { stderr += c; });
    child.stdin!.end(stdin ?? "");
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  }

  it("lists the .sock siblings with their metadata, one JSON object per line", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, `${encodeAgentName("alpha")}.sock`), "");
    fs.writeFileSync(path.join(dir, `${encodeAgentName("beta")}.sock`), "");
    fs.writeFileSync(path.join(dir, `${encodeAgentName("beta")}.json`), JSON.stringify({ sessionName: "pi-varna", cwd: "/srv/beta", status: "idle" }));

    const r = await runCli(["list", "--json"], dir);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.name), ["alpha", "beta"]);
    assert.deepEqual(lines[1], { name: "beta", sessionName: "pi-varna", cwd: "/srv/beta", status: "idle" });
    assert.equal(lines[0].cwd, null, "a metadata-less sibling still lists, with nulls");
  });

  it("prints a human line without --json", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, `${encodeAgentName("alpha")}.sock`), "");
    const r = await runCli(["list"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "alpha\n");
  });

  it("an empty or missing directory is an empty listing, never an error", async () => {
    const dir = freshDir();
    for (const flags of [["list"], ["list", "--json"]]) {
      const r = await runCli(flags, dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    const missing = await runCli(["list", "--json"], path.join(dir, "never-created"));
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(missing.stdout, "");
  });

  it("send reads the document from stdin when the file is -", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-stdin", "--once", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForSocket(endpointForName("agent-stdin", dir));
      const sender = await runCli(["send", "agent-stdin", "-", "from stdin", "--kind", "task", "--from", "agent-sender"], dir, "stdin body");
      assert.equal(sender.code, 0, sender.stderr);
      assert.equal(await waitExit(child), 0, `stderr: ${stderr}`);
      assert.equal(takeInbox(inboxPathForName("agent-stdin", dir))[0]?.document, "kind: task\nstdin body");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("sends without --from as the literal sender \"unknown\", never a cwd-derived name", async () => {
    const dir = freshDir();
    const child = spawn(process.execPath, [bundle, "up", "--name", "agent-nofrom", "--once", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForSocket(endpointForName("agent-nofrom", dir));
      const doc = path.join(dir, "handoff.md");
      fs.writeFileSync(doc, "body");
      const sender = await runCli(["send", "agent-nofrom", doc, "s", "--kind", "task"], dir);
      assert.equal(sender.code, 0, sender.stderr);
      assert.equal(await waitExit(child), 0, `stderr: ${stderr}`);
      assert.equal(takeInbox(inboxPathForName("agent-nofrom", dir))[0]?.from, "unknown");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});

describe("xfer-adapterd CLI: the outcome a failed send leaves behind", () => {
  const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const freshDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-adapterd-outcome-")); dirs.push(d); return d; };

  function runCli(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => { stdout += c; });
    child.stderr!.on("data", (c: Buffer) => { stderr += c; });
    child.stdin!.end(stdin ?? "");
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  }

  it("an absent peer is not-delivered", async () => {
    const dir = freshDir();
    const r = await runCli(["send", "ghost", "-", "s", "--kind", "task", "--dir", dir], "body");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found not-delivered$/m);
  });

  it("an ack timeout is unknown, because the handoff may have arrived", async () => {
    const dir = freshDir();
    const sock = path.join(dir, "deaf.sock");
    const server = net.createServer((socket) => { socket.on("data", () => { /* never acks */ }); });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const r = await runCli(["send", "deaf", "-", "s", "--kind", "task", "--dir", dir], "body");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /ack timeout unknown$/m);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a mesh send that is not configured leaves no outcome claim at all", async () => {
    const dir = freshDir();
    const r = await runCli(["mesh", "send", "phone", "-", "s", "--kind", "task", "--mesh-config", path.join(dir, "missing.json"), "--dir", dir], "body");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /mesh is not configured/);
    assert.doesNotMatch(r.stderr, /\b(queued|delivered|unknown|not-delivered)\b/, "a config error is not a delivery outcome");
  });

  it("classifies a local failure: only an absent peer is a definite negative", () => {
    assert.equal(failedSendOutcome(new Error('peer "ghost" not found')), "not-delivered");
    assert.equal(failedSendOutcome(new Error("ack timeout")), "unknown");
    assert.equal(failedSendOutcome(new Error("connect timeout")), "unknown");
    assert.equal(failedSendOutcome(new Error("ECONNRESET")), "unknown");
  });

  it("carries the mesh classifier's own kind, degrading its unclassified case to unknown", () => {
    const withKind = (kind: string) => Object.assign(new Error("mesh refused"), { kind });
    assert.equal(meshFailureOutcome(withKind("not-delivered")), "not-delivered");
    assert.equal(meshFailureOutcome(withKind("unknown")), "unknown");
    assert.equal(meshFailureOutcome(withKind("failed")), "unknown", "an unclassified refusal must not claim nothing was sent");
  });
});
