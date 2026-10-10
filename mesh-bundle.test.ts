import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

/**
 * 漏提交防线: `npm run build` writes mesh-runtime.cjs.sha256 alongside the
 * bundle. The committed bundle must always match that checksum, so anyone who
 * rebuilds but forgets to commit the bundle (or the checksum) turns the suite
 * red — on every machine, no build-time deps needed.
 */
describe("mesh runtime bundle consistency", () => {
  it("mesh-runtime.cjs matches its committed .sha256 checksum", () => {
    const bundlePath = path.join(import.meta.dirname, "mesh-runtime.cjs");
    const checksumPath = `${bundlePath}.sha256`;
    assert.ok(fs.existsSync(bundlePath), "mesh-runtime.cjs missing — run `npm run build` in the xfer extension directory and commit it");
    assert.ok(fs.existsSync(checksumPath), "mesh-runtime.cjs.sha256 missing — run `npm run build` in the xfer extension directory and commit it");
    const actual = createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
    const expected = fs.readFileSync(checksumPath, "utf8").trim();
    assert.equal(
      actual,
      expected,
      "mesh-runtime.cjs is out of sync with mesh-runtime.cjs.sha256 — run `npm run build` in the xfer extension directory and commit both files",
    );
  });
});
