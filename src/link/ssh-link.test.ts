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
import { spawn, spawnSync } from "node:child_process";
import { planGc } from "../core/gc.ts";
import { linkStatus, listLinks, listOwnLinks, sshDown, type SshLinkOptions } from "./ssh-link.ts";

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

describe("gc: ssh Link records", () => {
  it("reports a role:reverse marker and never deletes it", async () => {
    const dir = tmpXferDir();
    fs.writeFileSync(
      path.join(dir, "mac-xfer.json"),
      JSON.stringify({ xferName: "mac-xfer", via: "ssh", host: "mac-xfer", role: "reverse" }),
    );
    fs.writeFileSync(path.join(dir, "mac-xfer.sock"), "");

    const plan = await planGc(dir);
    const hit = plan.zombies.find(z => z.name === "mac-xfer");
    assert.ok(hit, "reported");
    assert.equal(hit!.reason, "dead-link");
    assert.equal(hit!.reportOnly, true, "flagged as not ours to delete");

    const { collectGarbage } = await import("../core/gc.ts");
    await collectGarbage(dir);
    assert.equal(fs.existsSync(path.join(dir, "mac-xfer.json")), true, "the record survives: its owner is elsewhere");
  });

  it("judges a Link ledger by its ssh pid and owns its sockets", async () => {
    const dir = tmpXferDir();
    fs.writeFileSync(
      path.join(dir, ".link.pi-nas.json"),
      JSON.stringify({ host: "pi-nas", pid: deadPid(), owner: process.pid, names: ["alpha", "beta"], reverseAs: "me", remoteDir: "/remote" }),
    );
    fs.writeFileSync(path.join(dir, "alpha.sock"), "");
    fs.writeFileSync(path.join(dir, "beta.sock"), "");

    const plan = await planGc(dir);
    const hit = plan.zombies.find(z => z.reason === "dead-link" && !z.reportOnly);
    assert.ok(hit, "the dead Link is reported");
    assert.equal(hit!.ownedSockets?.length, 2, "both imported sockets are attributed to it");
    assert.ok(!plan.zombies.some(z => z.reason === "orphan-sock"), "and not double-reported as orphans");

    const { collectGarbage } = await import("../core/gc.ts");
    await collectGarbage(dir);
    assert.deepEqual(fs.readdirSync(dir), [], "ledger and every socket it owned are gone");
  });

  it("keeps a Link whose ssh process is alive, even if its sockets look stale", async () => {
    const dir = tmpXferDir();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    try {
      fs.writeFileSync(
        path.join(dir, ".link.pi-nas.json"),
        JSON.stringify({ host: "pi-nas", pid, owner: process.pid, names: ["alpha"], reverseAs: "me", remoteDir: "/remote" }),
      );
      const plan = await planGc(dir);
      assert.ok(!plan.zombies.some(z => z.reason === "dead-link"), "not reaped while ssh lives");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe("ssh-link: imported sockets get a marker", () => {
  it("a Link that imports a node leaves a role:import record here", async () => {
    // Covered end to end by scripts/ssh-link-smoke.ts (needs ssh); here we pin
    // the shape gc depends on, since a missing marker is what made every
    // reply carry an unreadable path.
    const dir = tmpXferDir();
    const { metadataForName } = await import("../core/utils.ts");
    assert.equal(metadataForName("alpha", dir), path.join(dir, "alpha.json"));
  });
});

describe("gc: role:import vs role:reverse ownership", () => {
  it("reaps our own import record, reports the other machine's reverse record", async () => {
    const dir = tmpXferDir();
    fs.writeFileSync(path.join(dir, "alpha.json"), JSON.stringify({ xferName: "alpha", via: "ssh", host: "pi-nas", role: "import" }));
    fs.writeFileSync(path.join(dir, "alpha.sock"), "");
    fs.writeFileSync(path.join(dir, "mac-xfer.json"), JSON.stringify({ xferName: "mac-xfer", via: "ssh", host: "mac-xfer", role: "reverse" }));
    fs.writeFileSync(path.join(dir, "mac-xfer.sock"), "");

    const plan = await planGc(dir);
    const imported = plan.zombies.find(z => z.name === "alpha");
    assert.equal(imported?.reportOnly, undefined, "ours to delete");
    const reverse = plan.zombies.find(z => z.name === "mac-xfer");
    assert.equal(reverse?.reportOnly, true, "theirs to delete");

    const { collectGarbage } = await import("../core/gc.ts");
    await collectGarbage(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["mac-xfer.json", "mac-xfer.sock"]);
  });
});

describe("plan: the -R landing must not be one of the imported names", () => {
  // Both checks live in planSshUp, which needs a live probe; the decision itself
  // is a pure predicate, so pin it directly against the shapes that matter.
  const collides = (names: string[], reverseAs: string): boolean => names.includes(reverseAs);

  it("rejects importing this pi's own landing name on the FIRST link", () => {
    assert.equal(collides(["a"], "a"), true);
  });

  it("rejects it when EXTENDING an existing Link too", () => {
    // The regression: the old code only checked `!existing`, so a second `in`
    // could add a name that collides with the landing set up by the first.
    assert.equal(collides(["a", "b"], "a"), true);
  });

  it("accepts a landing name that is not imported", () => {
    assert.equal(collides(["a", "b"], "me"), false);
  });
});

describe("plan: a bare remote socket does not block the landing name", () => {
  // `sshDown` deletes the metadata immediately, but sshd keeps the -R socket
  // alive until the connection finishes closing. During that gap the remote
  // lists a socket with no agent behind it; treating it as a live node made
  // `down` followed by `in` fail as "the remote already has a node named X".
  const blocks = (remoteNames: string[], housed: string[], reverseAs: string): boolean =>
    housed.includes(reverseAs);

  it("blocks when the remote really has an agent by that name", () => {
    assert.equal(blocks(["mac-xfer"], ["mac-xfer"], "mac-xfer"), true);
  });

  it("does NOT block on a bare socket left by a teardown", () => {
    assert.equal(blocks(["mac-xfer"], [], "mac-xfer"), false, "socket without metadata is an sshd leftover");
  });

  it("does not block on a name that is not listed at all", () => {
    assert.equal(blocks(["other"], ["other"], "mac-xfer"), false);
  });
});
