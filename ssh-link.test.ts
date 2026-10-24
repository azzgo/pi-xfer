/**
 * Tests for the ssh Link layer (`ssh-link.ts`) and the gc Link branch
 * (ADR-0021). Pure node:test — the ssh binary is never invoked: the ssh-link
 * tests drive the record/ledger helpers directly and the plan-validation
 * logic through its error paths, while the gc tests use the same synthetic
 * peer files as gc.test.ts.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { planGc } from "./gc.js";
import { linkStatus, listLinks, listOwnLinks, sshDown, type SshLinkOptions } from "./ssh-link.js";

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpXferDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-ssh-link-test-"));
  tmpDirs.push(dir);
  return dir;
}

function deadPid(): number {
  const r = spawnSync("true");
  assert.ok(typeof r.pid === "number" && r.pid > 0);
  return r.pid;
}

function writeLink(dir: string, name: string, host: string, pid: number, owner = process.pid, direction = "in"): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ via: "ssh", host, pid, owner, direction }, null, 2));
  fs.writeFileSync(path.join(dir, `${name}.sock`), "");
}

function opts(dir: string): SshLinkOptions {
  return { xferDir: dir, myName: "self" };
}

describe("ssh-link: listLinks", () => {
  it("lists only via:ssh records with host+pid", () => {
    const dir = tmpXferDir();
    writeLink(dir, "remote-a", "a@host1", 123);
    fs.writeFileSync(path.join(dir, "peer.json"), JSON.stringify({ xferName: "peer", pid: process.pid }));
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "partial.json"), JSON.stringify({ via: "ssh", host: "x" }));

    const links = listLinks(opts(dir));
    assert.equal(links.length, 1);
    assert.equal(links[0].name, "remote-a");
    assert.equal(links[0].host, "a@host1");
    assert.equal(links[0].pid, 123);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(listLinks(opts(path.join(tmpXferDir(), "nope"))), []);
  });
});

describe("ssh-link: ownership", () => {
  it("listOwnLinks separates this process's Links from another pi's", () => {
    const dir = tmpXferDir();
    writeLink(dir, "mine", "h1", process.pid, process.pid);
    writeLink(dir, "theirs", "h2", process.pid + 999999, process.pid + 999999);
    assert.deepEqual(listOwnLinks(opts(dir)).map(l => l.name), ["mine"]);
    assert.equal(listLinks(opts(dir)).length, 2);
    assert.equal(linkStatus(listOwnLinks(opts(dir))[0]), "up");
  });

  it("reports a Link whose ssh process is gone as dead", () => {
    const dir = tmpXferDir();
    writeLink(dir, "gone", "h1", deadPid(), process.pid);
    assert.equal(linkStatus(listOwnLinks(opts(dir))[0]), "dead");
  });
});

describe("ssh-link: sshDown", () => {
  it("kills the recorded pid and removes sock+json, scoped by host", () => {
    const dir = tmpXferDir();
    writeLink(dir, "remote-a", "a@host1", deadPid());
    writeLink(dir, "remote-b", "b@host2", deadPid());

    const torn = sshDown("a@host1", opts(dir)).torn;
    assert.equal(torn.length, 1);
    assert.equal(fs.existsSync(path.join(dir, "remote-a.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "remote-a.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, "remote-b.json")), true);

    const rest = sshDown(undefined, opts(dir)).torn;
    assert.equal(rest.length, 1);
    assert.equal(fs.existsSync(path.join(dir, "remote-b.sock")), false);
  });

  it("survives an already-dead pid", () => {
    const dir = tmpXferDir();
    writeLink(dir, "remote-a", "a@host1", deadPid());
    assert.equal(sshDown("a@host1", opts(dir)).torn.length, 1);
  });

  it("never touches a Link another pi process owns", () => {
    const dir = tmpXferDir();
    writeLink(dir, "theirs", "a@host1", process.pid + 999999, process.pid + 999999);
    assert.equal(sshDown(undefined, opts(dir)).torn.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "theirs.sock")), true);
    assert.equal(fs.existsSync(path.join(dir, "theirs.json")), true);
  });
});

describe("gc: ssh Link branch", () => {
  it("reaps a dead Link as dead-link and reports the host for the rebuild hint", async () => {
    const dir = tmpXferDir();
    writeLink(dir, "remote-a", "a@host1", deadPid());

    const report = await collect(dir);
    assert.equal(report.zombies.length, 1);
    assert.equal(report.zombies[0].reason, "dead-link");
    assert.equal(report.zombies[0].linkHost, "a@host1");
    assert.equal(fs.existsSync(path.join(dir, "remote-a.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, "remote-a.json")), false);
  });

  it("keeps a live Link without any listener probing", async () => {
    const dir = tmpXferDir();
    // A plain file, not a socket: would probe as "no listener" for a Peer,
    // so this only passes if the Link branch skips probing entirely.
    writeLink(dir, "remote-a", "a@host1", process.pid);

    const report = await collect(dir);
    assert.equal(report.zombies.length, 0);
    assert.deepEqual(report.alive, ["remote-a"]);
  });

  it("treats a via:ssh record without pid as alive (conservative)", async () => {
    const dir = tmpXferDir();
    fs.writeFileSync(path.join(dir, "remote-a.json"), JSON.stringify({ via: "ssh", host: "h" }));
    fs.writeFileSync(path.join(dir, "remote-a.sock"), "");
    const report = await collect(dir);
    assert.equal(report.zombies.length, 0);
  });
});

async function collect(dir: string) {
  const { collectGarbage } = await import("./gc.js");
  return collectGarbage(dir);
}

describe("ssh-link: sshDown by forward name", () => {
  it("tears down the whole ssh process group a name belongs to", () => {
    const dir = tmpXferDir();
    // One `in` importing two remote nodes: one ssh pid, two ledger entries.
    writeLink(dir, "alpha", "pi-nas", 4242, process.pid);
    writeLink(dir, "beta", "pi-nas", 4242, process.pid);
    writeLink(dir, "self", "mac", 4343, process.pid, "out");

    const result = sshDown("alpha", opts(dir));
    assert.deepEqual(result.torn.map(l => l.name).sort(), ["alpha", "beta"]);
    assert.equal(fs.existsSync(path.join(dir, "alpha.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, "beta.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, "self.sock")), true, "the other ssh process survives");
  });

  it("falls back to a host identifier", () => {
    const dir = tmpXferDir();
    writeLink(dir, "alpha", "pi-nas", 4242, process.pid);
    writeLink(dir, "self", "mac", 4343, process.pid, "out");
    const result = sshDown("mac", opts(dir));
    assert.deepEqual(result.torn.map(l => l.name), ["self"]);
    assert.equal(result.host, "mac");
  });
});
