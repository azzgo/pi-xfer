/**
 * broker-manager.test.ts — integration tests for the xfer broker manager
 * (goal 014 task 025).
 *
 * Runs the REAL manager (broker-manager.ts) against the REAL daemon
 * (broker-main.ts) on ephemeral ports with an isolated os.tmpdir() xfer dir,
 * so tests never touch ~/.pi/xfer. The manager spawns the daemon with the
 * same --import resolve hook as `npm test` (read from package.json, so the
 * two can never drift). Every manager is stopped in afterEach and every
 * tmpdir removed, so the suite leaks nothing.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { BrokerManager, type BrokerInfo } from "./broker-manager.js";

// ---------- resolve hook (same as `npm test` / broker.test.ts) ----------

function resolveHook(): string {
  const pkg: { scripts?: { test?: string } } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
  );
  const match = /--import\s+'([^']+)'/.exec(pkg.scripts?.test ?? "");
  if (!match) throw new Error("cannot find --import resolve hook in package.json test script");
  return match[1]!;
}

const RESOLVE_HOOK = resolveHook();
const BROKER_MANAGER = path.join(import.meta.dirname, "broker-manager.ts");

// ---------- harness ----------

const tmpDirs: string[] = [];
const managers: BrokerManager[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-broker-manager-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Manager over an isolated tmpdir on an ephemeral port; registered for cleanup. */
function makeManager(xferDir: string, options: { port?: number } = {}): BrokerManager {
  const manager = new BrokerManager({ xferDir, port: options.port ?? 0 });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.stop();
    } catch {
      /* best effort — the daemon may already be gone */
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function readBrokerJson(xferDir: string): BrokerInfo {
  const data = JSON.parse(fs.readFileSync(path.join(xferDir, "broker.json"), "utf-8")) as BrokerInfo;
  assert.ok(data.port > 0, "broker.json port");
  assert.ok(data.pid > 0, "broker.json pid");
  assert.equal(typeof data.startedAt, "string");
  assert.equal(typeof data.version, "string");
  return data;
}

/** Spawn the manager CLI as a subprocess (used to check the exit code). */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", RESOLVE_HOOK, BROKER_MANAGER, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** pid of a process that has already exited (kill(pid, 0) will ESRCH). */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

/** A plain TCP listener squatting a port — no broker files, no protocol. */
async function squatPort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

/** Write a broker.json naming a dead pid on the given port (crashed-daemon residue). */
function writeStaleJson(xferDir: string, port: number, pid: number): void {
  fs.writeFileSync(
    path.join(xferDir, "broker.json"),
    JSON.stringify({ port, pid, startedAt: "stale", version: "0.0.0" }),
  );
}

/** A port that is free right now (bind :0, note it, close). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---------- tests ----------

describe("BrokerManager start", () => {
  it("spawns the daemon, passes the readiness probe, and status shows the live port", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);

    const result = await manager.start();
    assert.notEqual(result, "already running");

    // Readiness probe: broker.json exists AND its port accepts TCP.
    const info = await manager.probe();
    assert.ok(info !== null, "readiness probe should succeed after start");
    assert.ok(info.port > 0, "daemon should report a real bound port");
    assert.ok(info.pid > 0, "daemon should report its pid");

    const state = readBrokerJson(dir);
    assert.equal(state.port, info.port);
    assert.equal(state.pid, info.pid);

    // status() text carries port, pid, startedAt, version and alive.
    const statusText = await manager.status();
    assert.ok(statusText.includes("alive"), `status should say alive, got:\n${statusText}`);
    assert.ok(statusText.includes(String(info.port)), `status should contain the port, got:\n${statusText}`);
    assert.ok(statusText.includes(String(info.pid)), `status should contain the pid, got:\n${statusText}`);
    assert.ok(statusText.includes(info.version), `status should contain the version, got:\n${statusText}`);
  });

  it("start(portOverride) pins the requested port", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir); // default port 0 (ephemeral)
    const port = await freePort();

    const result = await manager.start(port);
    assert.notEqual(result, "already running");
    assert.ok(result.includes(`port ${port})`), `summary should show the pinned port, got:\n${result}`);

    const state = readBrokerJson(dir);
    assert.equal(state.port, port, "override pins the daemon port");
    assert.ok((await manager.probe()) !== null, "daemon serves the pinned port");
  });

  it("double start returns 'already running' and leaves a single daemon", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);

    const first = await manager.start();
    assert.notEqual(first, "already running");
    const pidFile = path.join(dir, "broker.pid");
    const pidBefore = fs.readFileSync(pidFile, "utf-8").trim();

    const second = await manager.start();
    assert.equal(second, "already running");

    // One pid file, untouched by the second start, naming a live process.
    assert.ok(fs.existsSync(pidFile), "broker.pid still present");
    const pidAfter = fs.readFileSync(pidFile, "utf-8").trim();
    assert.equal(pidAfter, pidBefore, "second start must not rewrite the pid file");
    assert.ok(Number.isInteger(Number(pidAfter)) && Number(pidAfter) > 0);
    assert.doesNotThrow(() => process.kill(Number(pidAfter), 0), "the single daemon is still alive");

    const pidFiles = fs.readdirSync(dir).filter((f) => f.startsWith("broker.pid"));
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.startsWith("broker.json"));
    assert.equal(pidFiles.length, 1, "exactly one broker.pid file");
    assert.equal(jsonFiles.length, 1, "exactly one broker.json file");
  });
});

describe("BrokerManager stop", () => {
  it("stops the daemon and closes its port within 3s", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);

    await manager.start();
    const { port, pid } = readBrokerJson(dir);

    const startedAt = Date.now();
    const text = await manager.stop();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3_000, `stop ladder took ${elapsed}ms`);
    assert.match(text, /broker stopped \(pid \d+\)/);

    // Port released and state files gone (the daemon unlinks on SIGTERM;
    // the manager also cleans up anything still present).
    await waitFor(async () => !(await tcpProbe(port)), `port ${port} to close`, 3_000);
    assert.ok(!fs.existsSync(path.join(dir, "broker.pid")), "broker.pid removed");
    assert.ok(!fs.existsSync(path.join(dir, "broker.json")), "broker.json removed");
    assert.throws(() => process.kill(pid, 0), "daemon pid should be gone");
  });

  it("stop on a non-running broker is a graceful no-op", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);

    const text = await manager.stop();
    assert.match(text, /broker not running/);

    // Idempotent: a second stop stays a no-op too.
    assert.match(await manager.stop(), /broker not running/);
  });
});

describe("BrokerManager status", () => {
  it("status on a non-running broker reports dead and the CLI exits 0", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);

    const text = await manager.status();
    assert.match(text, /dead/, `status should indicate dead, got:\n${text}`);

    // chrome-devtools convention: read the output, not the exit code.
    const cli = await runCli(["status", "--xfer-dir", dir]);
    assert.equal(cli.code, 0, `CLI status must exit 0, stderr: ${cli.stderr}`);
    assert.match(cli.stdout, /dead/, `CLI status should print dead, got:\n${cli.stdout}`);
  });

  it("status on a live broker prints the port and the CLI exits 0", async () => {
    const dir = freshXferDir();
    const manager = makeManager(dir);
    await manager.start();
    const { port } = readBrokerJson(dir);

    const cli = await runCli(["status", "--xfer-dir", dir]);
    assert.equal(cli.code, 0, `CLI status must exit 0, stderr: ${cli.stderr}`);
    assert.ok(cli.stdout.includes("alive"), `CLI status should print alive, got:\n${cli.stdout}`);
    assert.ok(cli.stdout.includes(String(port)), `CLI status should print the port, got:\n${cli.stdout}`);
  });
});

describe("BrokerManager port fallback (foreign program holds the port)", () => {
  it("probe ignores stale broker.json (dead pid) even when a foreign listener squats the port", async () => {
    const dir = freshXferDir();
    const { server, port } = await squatPort();
    try {
      const deadPid = await reapedPid();
      writeStaleJson(dir, port, deadPid);

      // TCP alone would bless the squatter as "already running"; the pid
      // liveness check is what separates a crashed daemon's residue from a
      // live broker.
      const manager = makeManager(dir);
      assert.equal(await manager.probe(), null, "dead pid + squatted port is not a running broker");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("start() lands on an ephemeral port and the summary announces the fallback", async () => {
    const dir = freshXferDir();
    const { server, port } = await squatPort();
    try {
      const manager = new BrokerManager({ xferDir: dir, port });
      managers.push(manager);

      const result = await manager.start();
      assert.notEqual(result, "already running");
      assert.match(result, /port \d+ was occupied by another program/);
      assert.match(result, /fell back to an ephemeral port/);

      // The daemon serves a different port, recorded in broker.json, and
      // the manager's status reflects the fallback port as alive.
      const state = readBrokerJson(dir);
      assert.notEqual(state.port, port, "daemon moved off the occupied port");
      const statusText = await manager.status();
      assert.ok(statusText.includes("alive"), `status should say alive, got:\\n${statusText}`);
      assert.ok(statusText.includes(String(state.port)), `status should show the fallback port, got:\\n${statusText}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("status on stale broker.json + squatted port reports dead with a foreign-program hint", async () => {
    const dir = freshXferDir();
    const { server, port } = await squatPort();
    try {
      const deadPid = await reapedPid();
      writeStaleJson(dir, port, deadPid);

      const manager = makeManager(dir);
      const text = await manager.status();
      assert.match(text, /dead/, `status should indicate dead, got:\\n${text}`);
      assert.match(text, /another program/, `status should hint at the squatter, got:\\n${text}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
