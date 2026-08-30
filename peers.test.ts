/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts).
 * utils.listPeers hardcodes XFER_DIR (`~/.pi/xfer`) and mkdirs it on every call, so the
 * listAllPeers tests skip their local-scan assertions when that directory is absent —
 * the suite never creates it and never mocks the module constant.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { TestContext } from "node:test";
import { describe, it } from "node:test";
import { XFER_DIR } from "./constants.js";
import { getRemotePeer, listAllPeers, listRemotePeers } from "./peers.js";
import type { Settings } from "./types.js";

describe("listRemotePeers", () => {
  it("returns [] when peers is absent", () => {
    assert.deepEqual(listRemotePeers({}), []);
  });

  it("returns [] when peers is empty", () => {
    assert.deepEqual(listRemotePeers({ peers: {} }), []);
  });

  it("sorts peers by name", () => {
    const settings: Settings = {
      peers: {
        zeta: { send: "send zeta" },
        alpha: { send: "send alpha" },
        mid: { send: "send mid", note: "n" },
      },
    };
    assert.deepEqual(
      listRemotePeers(settings).map((p) => p.name),
      ["alpha", "mid", "zeta"],
    );
  });

  it("carries send, timeoutMs and note through", () => {
    const settings: Settings = {
      peers: { codex: { send: "codex e-notify --file {file}", timeoutMs: 3000, note: "main peer" } },
    };
    assert.deepEqual(listRemotePeers(settings), [
      { name: "codex", send: "codex e-notify --file {file}", timeoutMs: 3000, note: "main peer" },
    ]);
  });

  it("omits unset optional fields instead of writing undefined", () => {
    const settings: Settings = { peers: { bare: { send: "run" } } };
    assert.deepEqual(listRemotePeers(settings), [{ name: "bare", send: "run" }]);
  });
});

describe("getRemotePeer", () => {
  it("finds a peer by name with all fields", () => {
    const settings: Settings = { peers: { codex: { send: "run", timeoutMs: 100, note: "n" } } };
    assert.deepEqual(getRemotePeer(settings, "codex"), {
      name: "codex",
      send: "run",
      timeoutMs: 100,
      note: "n",
    });
  });

  it("returns undefined for a name outside peers", () => {
    const settings: Settings = { peers: { codex: { send: "run" } } };
    assert.equal(getRemotePeer(settings, "ghost"), undefined);
  });

  it("returns undefined on empty settings", () => {
    assert.equal(getRemotePeer({}, "codex"), undefined);
  });
});

describe("listAllPeers", () => {
  /** True when the local scan is safe to call (utils.listPeers mkdirs XFER_DIR on use). */
  function hasXferDir(): boolean {
    return fs.existsSync(XFER_DIR);
  }

  function skipWithoutXferDir(t: TestContext): boolean {
    if (hasXferDir()) return true;
    t.skip(`local-scan skipped: ${XFER_DIR} absent (calling listPeers would create it)`);
    return false;
  }

  it("keeps local and remote namespaces separate when names collide", (t) => {
    if (!skipWithoutXferDir(t)) return;
    const settings: Settings = { peers: { shared: { send: "send-to shared" } } };
    const result = listAllPeers(settings, "my-agent");
    // The remote half is exactly the settings list, never merged with or shadowed by local.
    assert.deepEqual(result.remote, [{ name: "shared", send: "send-to shared" }]);
    assert.ok(Array.isArray(result.local));
  });

  it("excludes the calling agent from the local scan without throwing", (t) => {
    if (!skipWithoutXferDir(t)) return;
    const socks = fs.readdirSync(XFER_DIR).filter((f) => f.endsWith(".sock"));
    const myName = socks.length > 0
      ? decodeURIComponent(socks[0].replace(/\.sock$/, ""))
      : "list-all-peers-self-probe";
    const { local } = listAllPeers({}, myName);
    assert.ok(Array.isArray(local));
    assert.ok(!local.some((p) => p.xferName === myName));
  });

  it("returns an empty remote list alongside the local scan", (t) => {
    if (!skipWithoutXferDir(t)) return;
    const result = listAllPeers({}, "my-agent");
    assert.deepEqual(result.remote, []);
    assert.ok(Array.isArray(result.local));
  });
});
