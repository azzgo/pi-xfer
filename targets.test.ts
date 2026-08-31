/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts).
 * listTargets is a pure filesystem scan, so every case runs against a per-case
 * mkdtemp whose `*.sock` entries are plain placeholder files — no real unix
 * sockets are bound and the real `~/.pi/xfer` is never touched.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listTargets } from "./targets.js";

/** Fresh temp dir, cleaned up even when the assertion throws. */
function withDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-targets-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a placeholder `*.sock` file plus, optionally, its sibling JSON metadata. */
function addTarget(dir: string, sockName: string, json?: string): void {
  fs.writeFileSync(path.join(dir, sockName), "");
  if (json !== undefined) {
    fs.writeFileSync(path.join(dir, sockName.replace(/\.sock$/, ".json")), json, "utf-8");
  }
}

describe("listTargets", () => {
  it("merges a socket with its sibling metadata", () => {
    withDir((dir) => {
      addTarget(
        dir,
        "alpha.sock",
        JSON.stringify({
          xferName: "alpha",
          sessionName: "goal-014",
          cwd: "/tmp/work",
          model: "test-model",
          status: "busy",
          pid: 123,
          startedAt: 1,
        }),
      );
      // model/pid/startedAt are not part of TargetInfo and are dropped.
      assert.deepEqual(listTargets(dir), [
        { name: "alpha", sessionName: "goal-014", cwd: "/tmp/work", status: "busy" },
      ]);
    });
  });

  it("returns null metadata fields when the sibling json is missing", () => {
    withDir((dir) => {
      addTarget(dir, "bare.sock");
      assert.deepEqual(listTargets(dir), [
        { name: "bare", sessionName: null, cwd: null, status: null },
      ]);
    });
  });

  it("ignores metadata json without a matching socket and other stray files", () => {
    withDir((dir) => {
      addTarget(dir, "orphan.json", `{"sessionName": "no socket", "cwd": "/x", "status": "idle"}`);
      fs.writeFileSync(path.join(dir, "notes.txt"), "unrelated", "utf-8");
      assert.deepEqual(listTargets(dir), []);
    });
  });

  it("returns [] when the directory is missing", () => {
    withDir((dir) => {
      assert.deepEqual(listTargets(path.join(dir, "absent")), []);
    });
  });

  it("returns nulls instead of throwing on malformed json", () => {
    withDir((dir) => {
      addTarget(dir, "bad.sock", "{not json at all");
      assert.deepEqual(listTargets(dir), [
        { name: "bad", sessionName: null, cwd: null, status: null },
      ]);
    });
  });

  it("returns nulls when metadata is not a JSON object", () => {
    withDir((dir) => {
      addTarget(dir, "arr.sock", "[1, 2, 3]");
      addTarget(dir, "str.sock", `"just a string"`);
      const targets = listTargets(dir);
      assert.deepEqual(targets.find((t) => t.name === "arr"), {
        name: "arr",
        sessionName: null,
        cwd: null,
        status: null,
      });
      assert.deepEqual(targets.find((t) => t.name === "str"), {
        name: "str",
        sessionName: null,
        cwd: null,
        status: null,
      });
    });
  });

  it("nulls only the fields missing or wrong-typed in metadata", () => {
    withDir((dir) => {
      addTarget(
        dir,
        "partial.sock",
        JSON.stringify({ sessionName: "kept", cwd: 42, status: "idle", unrelated: true }),
      );
      assert.deepEqual(listTargets(dir), [
        { name: "partial", sessionName: "kept", cwd: null, status: "idle" },
      ]);
    });
  });

  it("decodes URL-encoded socket names", () => {
    withDir((dir) => {
      addTarget(dir, "my%20agent.sock", `{"status": "idle"}`);
      assert.deepEqual(listTargets(dir), [
        { name: "my agent", sessionName: null, cwd: null, status: "idle" },
      ]);
    });
  });

  it("sorts targets by name ascending", () => {
    withDir((dir) => {
      addTarget(dir, "zeta.sock");
      addTarget(dir, "alpha.sock");
      addTarget(dir, "mid.sock");
      assert.deepEqual(
        listTargets(dir).map((t) => t.name),
        ["alpha", "mid", "zeta"],
      );
    });
  });
});
