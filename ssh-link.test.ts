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

function writeLink(
  dir: string,
  host: string,
  pid: number,
  names: string[],
  owner = process.pid,
  reverseAs = "self",
): void {
  fs.writeFileSync(
    path.join(dir, `.link.${encodeURIComponent(host)}.json`),
    JSON.stringify({ host, pid, owner, names, reverseAs }, null, 2),
  );
  for (const name of names) fs.writeFileSync(path.join(dir, `${name}.sock`), "");
}

function opts(dir: string): SshLinkOptions {
  return { xferDir: dir, myName: "self" };
}

describe("ssh-link: listLinks", () => {
  it("reads one ledger per host with its names and reverse landing", () => {
    const dir = tmpXferDir();
    writeLink(dir, "pi-nas", 123, ["alpha", "beta"], process.pid, "mac-xfer");
    writeLink(dir, "other", 456, ["gamma"]);

    const links = listLinks(opts(dir)).sort((a, b) => a.host.localeCompare(b.host));
    assert.equal(links.length, 2);
    assert.deepEqual(links[0].names, ["gamma"]);
    assert.deepEqual(links[1].names, ["alpha", "beta"]);
    assert.equal(links[1].pid, 123);
    assert.equal(links[1].reverseAs, "mac-xfer");
  });

  it("ignores peer metadata and malformed ledgers", () => {
    const dir = tmpXferDir();
    fs.writeFileSync(path.join(dir, "peer.json"), JSON.stringify({ xferName: "peer", pid: process.pid }));
    fs.writeFileSync(path.join(dir, ".link.broken.json"), "{ not json");
    fs.writeFileSync(path.join(dir, ".link.nopid.json"), JSON.stringify({ host: "x", owner: 1 }));
    assert.deepEqual(listLinks(opts(dir)), []);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(listLinks(opts(path.join(tmpXferDir(), "nope"))), []);
  });
});

describe("ssh-link: ownership", () => {
  it("listOwnLinks separates this process's Links from another pi's", () => {
    const dir = tmpXferDir();
    writeLink(dir, "h1", deadPid(), ["mine"], process.pid);
    writeLink(dir, "h2", deadPid(), ["theirs"], process.pid + 999999);
    assert.deepEqual(listOwnLinks(opts(dir)).map(l => l.host), ["h1"]);
    assert.equal(listLinks(opts(dir)).length, 2);
    assert.equal(linkStatus(listOwnLinks(opts(dir))[0]), "dead", "its ssh process is gone");
  });

  it("reports a Link whose ssh process is gone as dead", () => {
    const dir = tmpXferDir();
    writeLink(dir, "h1", deadPid(), ["gone"], process.pid);
    assert.equal(linkStatus(listOwnLinks(opts(dir))[0]), "dead");
  });
});

describe("ssh-link: sshDown", () => {
  it("kills the ssh process, removes every imported socket and the ledger", async () => {
    const dir = tmpXferDir();
    writeLink(dir, "pi-nas", deadPid(), ["alpha", "beta"]);
    // The recorded pid is a real process here, so let SIGTERM land harmlessly.
    const result = await sshDown("pi-nas", opts(dir));
    assert.equal(result.torn.length, 1);
    assert.deepEqual(result.torn[0].names, ["alpha", "beta"]);
    assert.equal(fs.existsSync(path.join(dir, "alpha.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, "beta.sock")), false);
    assert.equal(fs.existsSync(path.join(dir, ".link.pi-nas.json")), false);
  });

  it("matches a forward name to its whole host Link", async () => {
    const dir = tmpXferDir();
    writeLink(dir, "pi-nas", deadPid(), ["alpha", "beta"]);
    writeLink(dir, "other", deadPid(), ["gamma"]);
    const result = await sshDown("alpha", opts(dir));
    assert.equal(result.torn.length, 1, "one host Link tears down as a unit");
    assert.equal(result.torn[0].host, "pi-nas");
    assert.equal(fs.existsSync(path.join(dir, "gamma.sock")), true, "the other host survives");
  });

  it("bare down tears down every Link this pi owns, and never another pi's", async () => {
    const dir = tmpXferDir();
    // A dead pid: sshDown SIGTERMs it, which must never be our own process.
    writeLink(dir, "h1", deadPid(), ["a"], process.pid);
    writeLink(dir, "h2", deadPid(), ["b"], process.pid + 999999);
    assert.equal((await sshDown(undefined, opts(dir))).torn.length, 1);
    assert.equal(fs.existsSync(path.join(dir, ".link.h2.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "b.sock")), true);
  });
});
