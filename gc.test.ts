/**
 * Tests for the zombie-socket GC (`gc.ts`). Pure node:test — no pi runtime
 * imports, so no resolve hooks are needed. Every test works inside a temp
 * xfer dir. Live sockets are real unix sockets created with net.Server; stale
 * ones are produced by a child process that listens and then SIGKILLs itself —
 * the exact zombie shape after a crash (Node unlinks the socket on clean
 * close, so only an abrupt death leaves the file behind).
 *
 * Run via `npm test` in this directory.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { collectGarbage, planGc, processAlive, socketHasListener } from "./gc.js";

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-gc-test-"));
  tmpDirs.push(dir);
  return dir;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pid that is guaranteed gone: spawn `true` and let it exit. */
function deadPid(): number {
  const r = spawnSync("true");
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0);
  assert.ok(typeof r.pid === "number" && r.pid > 0);
  return r.pid;
}

/** Create a REAL listening unix socket at `sockPath`; returns its server. */
function listenOn(sockPath: string): net.Server {
  try { fs.unlinkSync(sockPath); } catch { /* not there */ }
  const server = net.createServer(() => {});
  server.listen(sockPath);
  return server;
}

/**
 * Create a STALE unix socket file: a child process listens briefly, then
 * SIGKILLs itself — leaving the socket behind with nothing bound to it.
 */
async function staleSocket(sockPath: string): Promise<void> {
  const child = spawn(process.execPath, [
    "-e",
    `const net=require("node:net");const s=net.createServer(()=>{});` +
      `s.listen(${JSON.stringify(sockPath)});` +
      `setTimeout(()=>process.kill(process.pid,"SIGKILL"),30);`,
  ]);
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  for (let i = 0; i < 50 && !fs.existsSync(sockPath); i++) await sleep(10);
  assert.ok(fs.existsSync(sockPath), "stale socket file must be left behind");
}

function writePeer(dir: string, name: string, meta: object): { sockPath: string; jsonPath: string } {
  const jsonPath = path.join(dir, `${name}.json`);
  const sockPath = path.join(dir, `${name}.sock`);
  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
  // A non-socket file probes as ENOTSOCK → no listener, same as a stale socket.
  fs.writeFileSync(sockPath, "");
  return { sockPath, jsonPath };
}

describe("gc: processAlive", () => {
  it("sees the current process as alive and a reaped pid as dead", () => {
    assert.equal(processAlive(process.pid), true);
    assert.equal(processAlive(deadPid()), false);
  });
});

describe("gc: socketHasListener", () => {
  it("true while a server is listening", async () => {
    const dir = tmpXferDir();
    const sockPath = path.join(dir, "live.sock");
    const server = listenOn(sockPath);
    try {
      assert.equal(await socketHasListener(sockPath), true);
    } finally {
      server.close();
    }
  });

  it("false for a stale socket file, a plain file, and a missing path", async () => {
    const dir = tmpXferDir();
    const stale = path.join(dir, "stale.sock");
    await staleSocket(stale);

    assert.equal(await socketHasListener(stale), false, "stale socket has no listener");
    const plain = path.join(dir, "plain.sock");
    fs.writeFileSync(plain, "");
    assert.equal(await socketHasListener(plain), false, "non-socket file has no listener");
    assert.equal(await socketHasListener(path.join(dir, "nope.sock")), false, "missing file has no listener");
  });
});

describe("gc: planGc / collectGarbage", () => {
  it("reaps a peer whose pid is dead, removing sock + json", async () => {
    const dir = tmpXferDir();
    const { sockPath, jsonPath } = writePeer(dir, "ghost", { xferName: "ghost", pid: deadPid() });

    const report = await planGc(dir);
    assert.equal(report.zombies.length, 1);
    assert.equal(report.zombies[0].name, "ghost");
    assert.equal(report.zombies[0].reason, "dead-pid");
    assert.equal(report.alive.length, 0);

    const removed = await collectGarbage(dir);
    assert.equal(removed.zombies.length, 1);
    assert.equal(fs.existsSync(sockPath), false, "sock removed");
    assert.equal(fs.existsSync(jsonPath), false, "json removed");
  });

  it("keeps a peer whose pid is alive", async () => {
    const dir = tmpXferDir();
    const { sockPath, jsonPath } = writePeer(dir, "self", { xferName: "self", pid: process.pid });

    const report = await collectGarbage(dir);
    assert.equal(report.zombies.length, 0);
    assert.deepEqual(report.alive, ["self"]);
    assert.ok(fs.existsSync(sockPath) && fs.existsSync(jsonPath));
  });

  it("reaps an orphan sock (no json) only when nothing listens on it", async () => {
    const dir = tmpXferDir();
    const staleSock = path.join(dir, "orphan.sock");
    await staleSocket(staleSock);

    const report = await collectGarbage(dir);
    assert.equal(report.zombies.length, 1);
    assert.equal(report.zombies[0].name, "orphan");
    assert.equal(report.zombies[0].reason, "orphan-sock");
    assert.equal(fs.existsSync(staleSock), false);

    // A listening orphan survives — its metadata just hasn't been written yet.
    const liveSock = path.join(dir, "fresh.sock");
    const live = listenOn(liveSock);
    try {
      const kept = await collectGarbage(dir);
      assert.equal(kept.zombies.length, 0);
      assert.deepEqual(kept.alive, ["fresh"]);
      assert.ok(fs.existsSync(liveSock));
    } finally {
      live.close();
    }
  });

  it("reaps unreadable metadata only when nothing listens on the sock", async () => {
    const dir = tmpXferDir();
    const jsonPath = path.join(dir, "broken.json");
    const sockPath = path.join(dir, "broken.sock");
    fs.writeFileSync(jsonPath, "{ not json");
    fs.writeFileSync(sockPath, "");

    const report = await collectGarbage(dir);
    assert.equal(report.zombies.length, 1);
    assert.equal(report.zombies[0].reason, "unreadable-json");
    assert.equal(fs.existsSync(sockPath), false);
    assert.equal(fs.existsSync(jsonPath), false);

    // Same broken json, but something IS listening → keep both.
    const json2 = path.join(dir, "alive.json");
    const sock2 = path.join(dir, "alive.sock");
    fs.writeFileSync(json2, "{ not json");
    const server = listenOn(sock2);
    try {
      const kept = await collectGarbage(dir);
      assert.equal(kept.zombies.length, 0);
      assert.deepEqual(kept.alive, ["alive"]);
      assert.ok(fs.existsSync(sock2) && fs.existsSync(json2));
    } finally {
      server.close();
    }
  });

  it("never touches broker.*, settings.json, or subdirectories", async () => {
    const dir = tmpXferDir();
    fs.writeFileSync(path.join(dir, "broker.json"), '{"pid": 1}');
    fs.writeFileSync(path.join(dir, "broker.pid"), "1");
    fs.writeFileSync(path.join(dir, "broker.log"), "");
    fs.writeFileSync(path.join(dir, "settings.json"), '{"peers": {}}');
    fs.mkdirSync(path.join(dir, "nested.dir"));

    const report = await collectGarbage(dir);
    assert.equal(report.zombies.length, 0);
    assert.equal(report.alive.length, 0);
    for (const f of ["broker.json", "broker.pid", "broker.log", "settings.json"]) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} must survive`);
    }
    assert.ok(fs.existsSync(path.join(dir, "nested.dir")));
  });

  it("returns an empty report for a missing directory without throwing", async () => {
    const report = await collectGarbage(path.join(tmpXferDir(), "does-not-exist"));
    assert.deepEqual(report, { zombies: [], alive: [] });
  });
});
