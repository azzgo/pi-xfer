import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildMeshRuntime } from "./build.mjs";

/**
 * 漏提交防线: mesh-runtime.cjs is committed, so it must always equal what
 * `npm run build` produces from the current source. Requires rivetkit in
 * node_modules (a build-time-only install) — skips with a reason otherwise so
 * machines that never build stay green without network access.
 */
describe("mesh runtime bundle consistency", () => {
  it("committed mesh-runtime.cjs matches a fresh rebuild of the source", async () => {
    if (!fs.existsSync(path.join(import.meta.dirname, "node_modules/rivetkit/package.json"))) {
      console.log("skip: rivetkit not installed (build-time dep) — bundle consistency not checked");
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-bundle-check-"));
    try {
      const rebuilt = path.join(tmpDir, "mesh-runtime.cjs");
      await buildMeshRuntime(rebuilt);
      const committed = fs.readFileSync(path.join(import.meta.dirname, "mesh-runtime.cjs"));
      const fresh = fs.readFileSync(rebuilt);
      assert.deepEqual(
        fresh,
        committed,
        "mesh-runtime.cjs is stale — run `npm run build` in the xfer extension directory and commit the rebuilt bundle",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
