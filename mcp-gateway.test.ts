/**
 * mcp-gateway.test.ts — the local stdio MCP server: a real JSON-RPC handshake
 * against a spawned process, the exact argv each tool produces (via a stub CLI,
 * so a flag change cannot diverge from a tool schema), stdout purity including
 * the error path, and one end-to-end mesh send against a control plane this
 * test starts itself on loopback.
 *
 * Hermetic: every `--dir` is a fresh `os.tmpdir()` directory, the stub CLI is a
 * file in one of them, and the only engine is one this process spawned. The
 * gateway itself never talks to an engine — `xfer_mesh_send` forks the CLI —
 * so the guard lives in the spawned adapter, which inherits NODE_TEST_CONTEXT.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCommand, cliArgv, resolveOptions } from "./mcp-gateway.mjs";

const gateway = path.join(import.meta.dirname, "mcp-gateway.mjs");
const stubSource = path.join(import.meta.dirname, "fixtures", "stub-adapterd.mjs");

let root: string;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-gateway-test-")); });
after(() => { if (!process.env.XFER_KEEP_TEST_DIRS) fs.rmSync(root, { recursive: true, force: true }); });

function freshDir(): string {
  return fs.mkdtempSync(path.join(root, "case-"));
}

/** A stub `xfer-adapterd`: records its argv, prints what a send records, and exits with a chosen code. */
function stubAdapterd(dir: string, opts: { stdout?: string; stderr?: string; code?: number } = {}): { path: string; log: string } {
  const log = path.join(dir, "argv.jsonl");
  const stub = path.join(dir, "stub-adapterd.mjs");
  fs.writeFileSync(stub, fs.readFileSync(stubSource, "utf-8"));
  fs.writeFileSync(path.join(dir, "stub-config.json"), JSON.stringify({ log, ...opts }));
  return { path: stub, log };
}

interface Frame {
  jsonrpc: string;
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Speak JSON-RPC to a real spawned gateway. Resolves when the process exits, so
 * a test can assert both the frames it sent and that nothing else was printed.
 */
async function speak(args: string[], requests: unknown[], options: { stdinTail?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ frames: Frame[]; stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [gateway, ...args], { stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
  if (options.stdinTail !== undefined) child.stdin.write(options.stdinTail);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
  const frames = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Frame);
  return { frames, stdout, stderr, code };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

const OUTCOME_VALUES = ["queued", "delivered", "unknown", "not-delivered"];

function recordedArgv(log: string): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

describe("mcp-gateway: startup", () => {
  it("refuses to run without --name, and prints the refusal on stderr only", async () => {
    const result = await speak([], [initialize]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "", "a refused gateway must leave stdout untouched");
    assert.match(result.stderr, /--name is required/);
  });

  it("never derives a name from the directory or an environment variable", () => {
    assert.match(resolveOptions([]).error, /--name is required/);
    assert.equal(resolveOptions(["--dir", "/tmp"]).error !== undefined, true);
    assert.equal(resolveOptions(["--name", "host-a"]).name, "host-a");
  });
});

describe("mcp-gateway: JSON-RPC handshake", () => {
  it("initialize, tools/list and tools/call over stdio", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: '{"name":"peer","sessionName":null,"cwd":"/srv","status":"idle"}\n' });
    const result = await speak(
      ["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path],
      [
        initialize,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        call(3, "xfer_list", {}),
      ],
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.frames.length, 3, "one frame per request id — the notification answers with nothing");

    const [init, list, listing] = result.frames;
    assert.equal(init?.id, 1);
    assert.equal(init?.result.protocolVersion, "2025-06-18");
    assert.equal(init?.result.capabilities.tools.listChanged, false);
    assert.equal(init?.result.serverInfo.name, "xfer-gateway");

    assert.equal(list?.id, 2);
    assert.deepEqual(list?.result.tools.map((tool: any) => tool.name), ["xfer_send", "xfer_mesh_send", "xfer_list"]);
    for (const tool of list?.result.tools ?? []) assert.equal(tool.inputSchema.type, "object");
    for (const name of ["xfer_send", "xfer_mesh_send"]) {
      const tool = list?.result.tools.find((entry: any) => entry.name === name);
      assert.match(tool.description, /Never send a handoff whose only purpose is to acknowledge/, "the anti-acknowledgement rule reaches the model");
      assert.match(tool.inputSchema.properties.kind.description, /acknowledge or confirm/);
    }
    const send = list?.result.tools.find((tool: any) => tool.name === "xfer_send");
    assert.deepEqual(send.inputSchema.required, ["target", "summary", "document", "kind"]);
    assert.deepEqual(send.inputSchema.properties.kind.enum, ["task", "notification"]);
    assert.equal("preflight" in send.inputSchema.properties, false, "--no-preflight is not a model-reachable flag");

    assert.equal(listing?.id, 3);
    assert.equal(listing?.result.isError, false);
    assert.deepEqual(listing?.result.structuredContent.targets, [{ name: "peer", sessionName: null, cwd: "/srv", status: "idle" }]);
  });

  it("answers an unsupported protocol version with the newest it speaks", async () => {
    const dir = freshDir();
    const result = await speak(["--name", "host-a", "--dir", dir], [
      { ...initialize, params: { ...initialize.params, protocolVersion: "1999-01-01" } },
    ]);
    assert.equal(result.frames[0]?.result.protocolVersion, "2025-06-18");
  });
});

describe("mcp-gateway: exact argv per tool", () => {
  it("xfer_send forks `send <target> <file> <summary> --kind <k> --from <name> --dir <dir>`", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: "msg-1 delivered\n" });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_send", { target: "peer", summary: "do the thing", document: "# Hello\n\nbody", kind: "task" }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const [argv] = recordedArgv(stub.log);
    assert.deepEqual(argv, ["send", "peer", argv?.[2], "do the thing", "--kind", "task", "--from", "host-a", "--dir", dir]);
    assert.equal(path.dirname(argv?.[2] ?? ""), os.tmpdir(), "the document goes through a temp file");
    assert.equal(result.frames[0]?.result.isError, false);
    assert.deepEqual(result.frames[0]?.result.structuredContent, { handoff_id: "msg-1", outcome: "delivered", target: "peer" });
  });

  it("xfer_mesh_send forks `mesh send …` with the same shape", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: "msg-2 unknown\n" });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_mesh_send", { target: "phone", summary: "s", document: "doc", kind: "notification" }),
    ]);
    const [argv] = recordedArgv(stub.log);
    assert.deepEqual(argv, ["mesh", "send", "phone", argv?.[3], "s", "--kind", "notification", "--from", "host-a", "--dir", dir]);
    assert.deepEqual(result.frames[0]?.result.structuredContent, { handoff_id: "msg-2", outcome: "unknown", target: "phone" });
  });

  it("xfer_list forks `list --json --dir <dir>` and passes the JSON lines through", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: '{"name":"a","sessionName":null,"cwd":null,"status":null}\n{"name":"b","sessionName":null,"cwd":null,"status":"idle"}\n' });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [call(2, "xfer_list", {})]);
    assert.deepEqual(recordedArgv(stub.log), [["list", "--json", "--dir", dir]]);
    assert.deepEqual(result.frames[0]?.result.structuredContent.targets.map((target: any) => target.name), ["a", "b"]);
  });

  it("the temp document holds the document verbatim and does not outlive the call", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: "msg-3 delivered\n" });
    const seen = path.join(dir, "seen.md");
    fs.writeFileSync(path.join(dir, "stub-config.json"), JSON.stringify({ log: stub.log, stdout: "msg-3 delivered\n", copyTo: seen }));
    const document = "kind: notification\n# Doc\n\n- item\n";
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_send", { target: "peer", summary: "s", document, kind: "task" }),
    ]);
    assert.equal(result.frames[0]?.result.isError, false);
    assert.equal(fs.readFileSync(seen, "utf-8"), document);
    const [argv] = recordedArgv(stub.log);
    assert.equal(fs.existsSync(argv?.[2] ?? ""), false, "the gateway cleans up after itself");
  });

  it("an absent peer is the one definite negative: not-delivered", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stderr: '❌ send to "peer" failed: peer "peer" not found not-delivered\n', code: 1 });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_send", { target: "peer", summary: "s", document: "d", kind: "task" }),
    ]);
    const frame = result.frames[0];
    assert.equal(frame?.result.isError, true);
    assert.equal(frame?.result.structuredContent.outcome, "not-delivered");
    assert.equal(frame?.result.structuredContent.target, "peer");
    assert.match(frame?.result.structuredContent.detail, /not found/);
  });

  it("an ack timeout is unknown, and says not to resend", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stderr: '❌ send to "peer" failed: ack timeout unknown\n', code: 1 });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_send", { target: "peer", summary: "s", document: "d", kind: "task" }),
    ]);
    const content = result.frames[0]?.result.structuredContent;
    assert.equal(result.frames[0]?.result.isError, true);
    assert.equal(content.outcome, "unknown", "the handoff may have arrived — never a definite negative");
    assert.match(content.detail, /do not resend/);
  });

  it("a failure with no named outcome degrades to unknown, never to a false negative", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stderr: "something went sideways\n", code: 1 });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      call(2, "xfer_send", { target: "peer", summary: "s", document: "d", kind: "task" }),
    ]);
    const content = result.frames[0]?.result.structuredContent;
    assert.equal(content.outcome, "unknown");
    assert.match(content.detail, /do not resend/);
  });

  it("never reports an outcome outside ADR-0020's four values", async () => {
    const dir = freshDir();
    for (const [stdout, stderr, code] of [["out-1 delivered\n", "", 0], ["out-2 queued\n", "", 0], ["", "boom\n", 1], ["garbage\n", "", 0]]) {
      const stub = stubAdapterd(freshDir(), { stdout, stderr, code });
      const result = await speak(["--name", "host-a", "--dir", path.dirname(stub.log), "--xfer-adapterd", stub.path], [
        call(2, "xfer_send", { target: "peer", summary: "s", document: "d", kind: "task" }),
      ]);
      assert.equal(OUTCOME_VALUES.includes(result.frames[0]?.result.structuredContent.outcome), true);
    }
  });

  it("a CLI that cannot be spawned is reported as an error result", async () => {
    const dir = freshDir();
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", path.join(dir, "no-such-cli")], [
      call(2, "xfer_list", {}),
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.frames[0]?.result.isError, true);
  });

  it("never invents a fifth outcome value anywhere in the source", () => {
    for (const file of ["mcp-gateway.mjs", "adapterd.src/main.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf-8");
      assert.equal(/\bnot-sent\b/.test(source), false, `${file} must stay inside ADR-0020's four values`);
    }
  });

  it("runs a script through this Node instead of requiring an executable bit", () => {
    assert.deepEqual(cliArgv(["/a/xfer-adapterd.cjs", "list"]), [process.execPath, "/a/xfer-adapterd.cjs", "list"]);
    assert.deepEqual(cliArgv(["/a/stub.mjs", "send"]), [process.execPath, "/a/stub.mjs", "send"]);
    assert.deepEqual(cliArgv(["/usr/bin/xfer-adapterd", "list"]), ["/usr/bin/xfer-adapterd", "list"]);
  });

  it("buildCommand is the single place argv is built", () => {
    const options = { name: "host-a", dir: "/tmp/x", adapterd: "/bin/adapterd" };
    assert.deepEqual(
      buildCommand("xfer_send", { target: "peer", summary: "s", kind: "task" }, options, "/tmp/doc.md"),
      ["/bin/adapterd", "send", "peer", "/tmp/doc.md", "s", "--kind", "task", "--from", "host-a", "--dir", "/tmp/x"],
    );
    assert.deepEqual(buildCommand("xfer_list", {}, options, null), ["/bin/adapterd", "list", "--json", "--dir", "/tmp/x"]);
    assert.throws(() => buildCommand("xfer_nope", {}, options, null), /unknown tool/);
  });
});

describe("mcp-gateway: stdout purity", () => {
  it("carries JSON-RPC frames and nothing else, error path included", async () => {
    const dir = freshDir();
    const stub = stubAdapterd(dir, { stdout: "not json at all\n", stderr: "noise on stderr\n", code: 1 });
    const result = await speak(["--name", "host-a", "--dir", dir, "--xfer-adapterd", stub.path], [
      initialize,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xfer_send", arguments: { target: "peer", summary: "s", document: "d", kind: "task" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "xfer_list", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "no/such/method" },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no-such-tool", arguments: {} } },
    ]);
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 5, `every request id got exactly one frame, got ${lines.length}`);
    for (const line of lines) {
      const frame = JSON.parse(line);
      assert.equal(frame.jsonrpc, "2.0");
    }
    assert.equal(result.frames[3]?.error?.code, -32601);
    assert.equal(result.frames[4]?.error?.code, -32602);
    assert.equal(result.stderr.includes("noise on stderr"), true, "the CLI's diagnostics are relayed to stderr");
    assert.match(result.frames[1]?.result.structuredContent.detail, /^noise on stderr/, "and reach the model as the failure detail");
  });

  it("turns an unparseable line into a parse-error frame, not a crash", async () => {
    const dir = freshDir();
    const result = await speak(["--name", "host-a", "--dir", dir], [initialize], { stdinTail: "{not json\n" });
    assert.equal(result.code, 0);
    assert.equal(result.frames.length, 2);
    assert.equal(result.frames[1]?.error?.code, -32700);
    assert.equal(result.frames[1]?.id, null);
  });
});

// ── end-to-end on loopback ──
//
// The gateway never talks to an engine itself: `xfer_mesh_send` forks the CLI,
// so driving it end to end means a control plane this test starts. That is what
// `phase4-design-p2.md` asks for, and an argv-only assertion does not satisfy it:
// the join and the fail-closed preflight would go unexercised by this file.
//
// It is **skipped, not faked**, for two reasons that belong to the machine and
// not to the code:
//
// 1. It needs the pinned `rivet-engine` binary, which pi-xfer downloads on
//    first `/xfer mesh up` into `~/.pi/xfer/cache/napi/<version>/`. Point
//    `XFER_ENGINE_BINARY` at one to run it.
// 2. A `rivet-engine` that is already running on the default ports (a
//    developer's own node) makes a second instance fail to bind its guard
//    service, so the control plane starts but cannot serve. Until the engine
//    supports a fully isolated instance, that collision is environmental.
//
// The coverage gap is acknowledged rather than hidden: everything under this
// layer (sendMeshHandoff, the preflight, the triage) is covered by mesh.test.ts
// through fakeDeps, and this change does not touch it.

const engineBinary = process.env.XFER_ENGINE_BINARY ?? "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(endpoint: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`loopback engine at ${endpoint} never answered /health`);
}


describe("mcp-gateway: mesh send end to end on loopback", () => {
  it("preflights against a loopback control plane and enqueues into it", async (t) => {
    if (engineBinary === "" || !fs.existsSync(engineBinary)) {
      return t.skip("set XFER_ENGINE_BINARY to a rivet-engine binary to run the loopback mesh send (and stop any engine already bound to the default ports)");
    }
    const dir = freshDir();
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const configPath = path.join(dir, "mesh.config.json");
    const engineConfig = path.join(dir, "engine.config.json");
    const token = "loopback-test-token";
    fs.writeFileSync(
      engineConfig,
      JSON.stringify({
        auth: { admin_token: token, insecure_allow_unauthenticated: true },
        api_peer: { host: "127.0.0.1", port },
        metrics: { host: "127.0.0.1", port: port + 1 },
      }),
    );
    const engineLog = fs.openSync(path.join(dir, "engine.log"), "w");
    const engine = spawn(engineBinary, ["--config", engineConfig, "start"], { stdio: ["ignore", engineLog, engineLog] });
    try {
      await waitForHealth(endpoint);
      const runnerConfig = await fetch(`${endpoint}/runner-configs/default?namespace=default`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ datacenters: { default: { normal: {} } } }),
      });
      assert.ok(runnerConfig.ok, `runner-config: ${runnerConfig.status} ${await runnerConfig.text()}`);
      fs.writeFileSync(configPath, JSON.stringify({ endpoint, namespace: "default", token }));

      const adapterd = path.join(import.meta.dirname, "xfer-adapterd.cjs");
      const result = await speak(
        ["--name", "loopback-sender", "--dir", dir, "--xfer-adapterd", adapterd],
        [call(2, "xfer_mesh_send", { target: "phone", summary: "loopback probe", document: "kind: notification\nprobe", kind: "notification" })],
        { env: { ...process.env, XFER_MESH_CONFIG: configPath } },
      );
      const frame = result.frames[0];
      assert.equal(result.stdout, `${result.stdout.trim()}\n`, "stdout is frames and nothing else");
      assert.equal(frame?.result.isError, false, `mesh send failed: ${frame?.result?.content?.[0]?.text ?? frame?.error?.message}`);
      assert.match(frame?.result.structuredContent.handoff_id ?? "", /^[0-9a-z]+-[0-9a-z]+$/);
      assert.equal(frame?.result.structuredContent.target, "phone");
      assert.equal(frame?.result.structuredContent.outcome, "queued", "a mesh enqueue that was accepted is queued, never unknown");

      const direct = spawn(process.execPath, [adapterd, "mesh", "send", "phone", "-", "loopback probe", "--kind", "notification", "--from", "loopback-sender", "--dir", dir], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, XFER_MESH_CONFIG: configPath },
      });
      let directErr = "";
      direct.stderr.on("data", (chunk) => { directErr += chunk.toString(); });
      direct.stdin.end("kind: notification\nprobe");
      const directCode = await new Promise<number | null>((resolve) => direct.on("exit", resolve));
      assert.equal(directCode, 0, "a preflight warning is not a failure — the exit code stays 0");
      assert.match(directErr, /queued|^$/m);
    } finally {
      engine.kill("SIGKILL");
      fs.closeSync(engineLog);
    }
  });
});
