/**
 * Tests for the ssh completion helpers (`ssh-hosts.ts`): ssh config alias
 * parsing and the probe cache. No ssh, no network, no real ~/.ssh.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { cachedHosts, cachedRemoteNames, isPrefetching, listSshHosts, parseSshConfigHosts, prefetchRemoteNames, rememberRemoteNames, wantsProbe } from "./ssh-hosts.ts";

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("ssh-hosts: parseSshConfigHosts", () => {
  it("collects aliases, skipping wildcards and comments", () => {
    const text = [
      "# a comment",
      "Host pi-nas",
      "  HostName 10.0.0.5",
      "",
      "Host mac-mini nas-backup",
      "Host *",
      "  ForwardAgent no",
      "Host *.internal",
      "Host !excluded real-one",
      "  Include ~/.ssh/extra",
    ].join("\n");
    assert.deepEqual(parseSshConfigHosts(text), ["pi-nas", "mac-mini", "nas-backup", "real-one"]);
  });

  it("dedupes and tolerates HostName/User lines", () => {
    assert.deepEqual(parseSshConfigHosts("Host a\nHostName x\nHost a\nUser bob"), ["a"]);
  });
});

describe("ssh-hosts: listSshHosts", () => {
  it("reads the config and its relative Include", () => {
    const home = tmpDir("xfer-ssh-home-");
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "extra"), "Host included-host\n");
    fs.writeFileSync(path.join(home, ".ssh", "config"), "Host main-host\n  Include extra\n");

    assert.deepEqual(listSshHosts(home).sort(), ["included-host", "main-host"]);
  });

  it("returns [] when there is no config", () => {
    assert.deepEqual(listSshHosts(tmpDir("xfer-ssh-empty-")), []);
  });
});

describe("ssh-hosts: probe cache", () => {
  it("remembers and returns names per host", () => {
    const dir = tmpDir("xfer-ssh-cache-");
    rememberRemoteNames(dir, "pi-nas", ["design", "kt-base-incus"]);
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas"), ["design", "kt-base-incus"]);
    assert.deepEqual(cachedRemoteNames(dir, "other"), []);
    assert.deepEqual(cachedHosts(dir), ["pi-nas"]);
  });

  it("drops entries older than the TTL", () => {
    const dir = tmpDir("xfer-ssh-cache-");
    rememberRemoteNames(dir, "pi-nas", ["design"]);
    const later = Date.now() + 7 * 60 * 60 * 1000;
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas", later), []);
    assert.deepEqual(cachedHosts(dir, later), []);
  });

  it("survives a corrupt cache file", () => {
    const dir = tmpDir("xfer-ssh-cache-");
    fs.writeFileSync(path.join(dir, ".ssh-link-hosts.json"), "{not json");
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas"), []);
    rememberRemoteNames(dir, "pi-nas", ["design"]);
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas"), ["design"]);
  });
});

describe("ssh-hosts: background prefetch", () => {
  it("runs one probe per host no matter how many requests arrive", async () => {
    const dir = tmpDir("xfer-ssh-prefetch-");
    let probes = 0;
    let release: (names: string[]) => void = () => {};
    const gate = new Promise<string[]>(resolve => { release = resolve; });
    const probe = async () => { probes++; await gate; return { names: ["alpha"] }; };

    const a = prefetchRemoteNames(dir, "pi-nas", probe);
    const b = prefetchRemoteNames(dir, "pi-nas", probe);
    const c = prefetchRemoteNames(dir, "pi-nas", probe);
    assert.equal(probes, 1, "three calls, one ssh");
    assert.equal(isPrefetching("pi-nas"), true);

    release([]);
    const [ra, rb] = await Promise.all([a, b, c]);
    assert.deepEqual(ra, ["alpha"]);
    assert.equal(rb, ra);
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas"), ["alpha"], "the result landed in the cache");
    assert.equal(isPrefetching("pi-nas"), false, "and the in-flight entry is cleared");
  });

  it("a failed probe keeps the previous cache instead of emptying it", async () => {
    const dir = tmpDir("xfer-ssh-prefetch-");
    rememberRemoteNames(dir, "pi-nas", ["stale-but-real"]);
    const probe = async () => { throw new Error("ssh: host unreachable"); };
    const names = await prefetchRemoteNames(dir, "pi-nas", probe);
    assert.deepEqual(names, ["stale-but-real"]);
    assert.deepEqual(cachedRemoteNames(dir, "pi-nas"), ["stale-but-real"]);
  });

  it("allows a new probe once the previous one settled", async () => {
    const dir = tmpDir("xfer-ssh-prefetch-");
    let probes = 0;
    const probe = async () => { probes++; return { names: [`n${probes}`] }; };
    await prefetchRemoteNames(dir, "h", probe);
    await prefetchRemoteNames(dir, "h", probe);
    assert.equal(probes, 2, "sequential calls each probe again");
  });

  it("asks for a probe only when the cache is missing or older than the window", () => {
    const dir = tmpDir("xfer-ssh-prefetch-");
    assert.equal(wantsProbe(dir, "h"), true, "nothing cached");
    rememberRemoteNames(dir, "h", ["a"]);
    const now = Date.now();
    assert.equal(wantsProbe(dir, "h", now), false, "just refreshed");
    assert.equal(wantsProbe(dir, "h", now + 61_000), true, "older than the freshness window");
  });
});
