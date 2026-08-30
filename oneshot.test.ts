/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts —
 * see the header there). These tests spawn real `sh` children; every child either reads
 * the staged msgfile or consumes stdin, and all artifacts land in a per-run mkdtemp.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { sendViaCommand } from "./oneshot.js";
import type { PeerSendConfig, XferNotifyMessage } from "./types.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-oneshot-test-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFrame(): XferNotifyMessage {
  return {
    type: "xfer-notify",
    msg_id: "msg-007",
    from: "pi",
    file: "/tmp/handoff.md",
    summary: "Review the doc",
  };
}

function frameBytes(msg: XferNotifyMessage): Buffer {
  return Buffer.from(JSON.stringify(msg) + "\n", "utf-8");
}

function outPath(name: string): string {
  return path.join(tmpDir, name);
}

/** Entries in os.tmpdir() matching the xfer frame mktemp pattern. */
function leftoverFrameEntries(): string[] {
  try {
    return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("xfer-frame-"));
  } catch {
    return [];
  }
}

describe("sendViaCommand", () => {
  it("stages the frame in a 0600 msgfile when the template references %msgfile", async () => {
    const out = outPath("msgfile-frame.bin");
    const peer: PeerSendConfig = {
      // `find -perm 0600` passes only if the staged file is owner-rw-only, then cp captures it.
      send: `find %msgfile -perm 0600 | grep -q . && cp %msgfile ${out}`,
    };
    const msg = makeFrame();
    const result = await sendViaCommand(peer, msg, { peer: "codex" });
    assert.deepEqual(result, { ok: true, code: 0, stderrHead: "" });
    assert.deepEqual(fs.readFileSync(out), frameBytes(msg));
  });

  it("pipes the frame bytes to stdin when the template has no %msgfile", async () => {
    const out = outPath("stdin-frame.bin");
    const peer: PeerSendConfig = { send: `cat > ${out}` };
    const msg = makeFrame();
    const result = await sendViaCommand(peer, msg);
    assert.deepEqual(result, { ok: true, code: 0, stderrHead: "" });
    assert.deepEqual(fs.readFileSync(out), frameBytes(msg));
  });

  it("reports a non-zero exit code as a failed result", async () => {
    const result = await sendViaCommand({ send: "exit 3" }, makeFrame());
    assert.deepEqual(result, { ok: false, code: 3, stderrHead: "" });
  });

  it("SIGTERMs a hung child at timeoutMs and resolves with code null", async () => {
    const start = Date.now();
    const result = await sendViaCommand({ send: "sleep 30", timeoutMs: 300 }, makeFrame());
    const elapsed = Date.now() - start;
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
    assert.ok(elapsed < 3000, `expected the child killed well within 3s, took ${elapsed}ms`);
  });

  it("captures the child's stderr head", async () => {
    const result = await sendViaCommand({ send: "echo boom >&2; exit 1" }, makeFrame());
    assert.deepEqual(result, { ok: false, code: 1, stderrHead: "boom\n" });
  });

  it("truncates stderrHead to 500 chars", async () => {
    // `%%` interpolates to a literal `%`, so the child runs `printf "%.700d" 0` (700 zeros).
    const result = await sendViaCommand({ send: `printf "%%.700d" 0 >&2; exit 1` }, makeFrame());
    assert.equal(result.ok, false);
    assert.equal(result.code, 1);
    assert.equal(result.stderrHead.length, 500);
    assert.match(result.stderrHead, /^0+$/);
  });

  it("leaves no /tmp/xfer-frame-* entries behind", async () => {
    const before = leftoverFrameEntries();
    await sendViaCommand({ send: `cat > ${outPath("discard-stdin.bin")}` }, makeFrame());
    await sendViaCommand({ send: `cp %msgfile ${outPath("discard-msgfile.bin")}` }, makeFrame(), { p: "1" });
    assert.deepEqual(leftoverFrameEntries(), before);
  });

  it("merges msgfile into caller vars and interpolates %p", async () => {
    const out = outPath("vars-port.txt");
    // `%%s` → literal `%s` for the child's printf; `%p` comes from the caller vars.
    const peer: PeerSendConfig = { send: `printf %%s %p > ${out}` };
    const result = await sendViaCommand(peer, makeFrame(), { p: "7777" });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(out, "utf-8"), "7777");
  });
});
