/**
 * Tests for the ssh completion helpers (`ssh-hosts.ts`): ssh config alias
 * parsing and the probe cache. No ssh, no network, no real ~/.ssh.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { cachedHosts, cachedRemoteNames, listSshHosts, parseSshConfigHosts, rememberRemoteNames } from "./ssh-hosts.js";

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
