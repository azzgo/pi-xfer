/**
 * admin-manager.test.ts — integration tests for the xfer admin manager
 * (milestone1 P0-1), mirroring broker-manager.test.ts.
 *
 * Runs the REAL manager (admin-manager.ts) against the REAL daemon
 * (admin-main.ts) on ephemeral ports with an isolated os.tmpdir() xfer dir,
 * so tests never touch ~/.pi/xfer. Every manager is stopped in afterEach.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AdminManager, type AdminInfo } from "./admin-manager.js";

const tmpDirs: string[] = [];
const managers: AdminManager[] = [];

function freshXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-admin-manager-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeManager(xferDir: string, options: { port?: number } = {}): AdminManager {
  const manager = new AdminManager({ xferDir, boardDir: path.join(xferDir, "board"), port: options.port ?? 0 });
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

function readAdminJson(xferDir: string): AdminInfo {
  const data = JSON.parse(fs.readFileSync(path.join(xferDir, "admin.json"), "utf-8")) as AdminInfo;
  assert.ok(data.port > 0, "admin.json port");
  assert.ok(data.pid > 0, "admin.json pid");
  assert.equal(typeof data.startedAt, "string");
  assert.equal(typeof data.version, "string");
  return data;
}

describe("AdminManager", () => {
  it("start() spawns the daemon, writes admin.json, and reports the port", async () => {
    const xferDir = freshXferDir();
    const manager = makeManager(xferDir);
    const result = await manager.start();
    assert.match(result, /admin started \(pid \d+, port \d+\)/);
    const info = readAdminJson(xferDir);
    assert.equal(info.pid > 0, true);
    assert.ok(await manager.probe(), "probe after start");
  });

  it("start() is idempotent while the daemon is alive", async () => {
    const xferDir = freshXferDir();
    const manager = makeManager(xferDir);
    await manager.start();
    const first = readAdminJson(xferDir);
    assert.equal(await manager.start(), "already running");
    assert.equal(readAdminJson(xferDir).pid, first.pid, "no second daemon spawned");
  });

  it("stop() terminates the daemon and clears admin.pid/admin.json", async () => {
    const xferDir = freshXferDir();
    const manager = makeManager(xferDir);
    const started = await manager.start();
    const pid = Number.parseInt(/pid (\d+)/.exec(started)![1]!, 10);
    const stopped = await manager.stop();
    assert.equal(stopped, `admin stopped (pid ${pid})`);
    assert.equal(fs.existsSync(path.join(xferDir, "admin.pid")), false);
    assert.equal(fs.existsSync(path.join(xferDir, "admin.json")), false);
    assert.equal(await manager.probe(), null);
  });

  it("stop() without a daemon is a graceful no-op", async () => {
    const xferDir = freshXferDir();
    const manager = makeManager(xferDir);
    assert.equal(await manager.stop(), "admin not running");
  });

  it("stop() clears a stale admin.pid naming a dead process", async () => {
    const xferDir = freshXferDir();
    fs.writeFileSync(path.join(xferDir, "admin.pid"), "999999999\n", "utf-8");
    const manager = makeManager(xferDir);
    assert.equal(await manager.stop(), "admin not running");
    assert.equal(fs.existsSync(path.join(xferDir, "admin.pid")), false);
  });
});

describe("AdminManager error paths", () => {
  it("start() times out with the admin.log tail when the daemon never becomes ready", async () => {
    const xferDir = freshXferDir();
    const stub = path.join(xferDir, "sleepy-daemon.mjs");
    fs.writeFileSync(stub, "console.error('[stub] booting but never listening');\nsetTimeout(() => {}, 60_000).unref();\n", "utf-8");
    const manager = new AdminManager({
      xferDir,
      boardDir: path.join(xferDir, "board"),
      port: 0,
      daemonPath: stub,
      readinessTimeoutMs: 400,
    });
    managers.push(manager);
    await assert.rejects(
      () => manager.start(),
      (err: Error) => {
        assert.match(err.message, /not ready within 400ms/);
        assert.match(err.message, /last admin.log lines/);
        assert.match(err.message, /booting but never listening/, "log tail is surfaced");
        return true;
      },
    );
  });

  it("start() rejects when the daemon entry does not exist", async () => {
    const xferDir = freshXferDir();
    const manager = new AdminManager({
      xferDir,
      boardDir: path.join(xferDir, "board"),
      port: 0,
      daemonPath: path.join(xferDir, "missing.mjs"),
      readinessTimeoutMs: 1_000,
    });
    managers.push(manager);
    await assert.rejects(() => manager.start(), /spawn failed|not ready within/);
  });
});
