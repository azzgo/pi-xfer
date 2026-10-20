import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAdapterd, buildAdminDaemon, buildBrokerDaemon, buildMeshRuntime, buildWebPicker } from "./build.mjs";

/**
 * freshness guard: rebuilds every committed artifact to temp files and
 * byte-compares them with what is on disk. The sha256 test in
 * mesh-bundle.test.ts only catches a bundle/checksum mismatch; this catches a
 * stale pair committed together after a source change (the P1-4 drift).
 */
describe("committed artifact freshness", () => {
  /**
   * The scratch path carries the pid because these tests race themselves: two
   * concurrent `npm test` runs share this directory, and esbuild's outfile
   * write is not atomic — a fixed name let one run read the other's half-written
   * bundle and fail with a bogus "stale" claim.
   */
  const scratch = (name: string): string =>
    path.join(import.meta.dirname, `${name}.fresh.test.tmp-${process.pid}`);
  it("mesh-runtime.cjs rebuilds byte-identical from mesh-runtime.src/", async () => {
    const rebuilt = scratch("mesh-runtime.cjs");
    try {
      await buildMeshRuntime(rebuilt);
      assert.equal(
        fs.readFileSync(rebuilt).equals(fs.readFileSync(path.join(import.meta.dirname, "mesh-runtime.cjs"))),
        true,
        "mesh-runtime.cjs is stale — run `npm run build` and commit both the bundle and its .sha256",
      );
    } finally {
      fs.rmSync(rebuilt, { force: true });
      fs.rmSync(`${rebuilt}.sha256`, { force: true });
    }
  });
  it("xfer-adapterd.cjs rebuilds byte-identical from adapterd.src/", async () => {
    const rebuilt = scratch("xfer-adapterd.cjs");
    try {
      await buildAdapterd(rebuilt);
      assert.equal(
        fs.readFileSync(rebuilt).equals(fs.readFileSync(path.join(import.meta.dirname, "xfer-adapterd.cjs"))),
        true,
        "xfer-adapterd.cjs is stale — run `npm run build` and commit both the bundle and its .sha256",
      );
    } finally {
      fs.rmSync(rebuilt, { force: true });
      fs.rmSync(`${rebuilt}.sha256`, { force: true });
    }
  });
  it("broker.cjs rebuilds byte-identical from broker-main.ts", async () => {
    const rebuilt = scratch("broker.cjs");
    try {
      await buildBrokerDaemon(rebuilt);
      assert.equal(
        fs.readFileSync(rebuilt).equals(fs.readFileSync(path.join(import.meta.dirname, "broker.cjs"))),
        true,
        "broker.cjs is stale — run `npm run build` and commit both the bundle and its .sha256",
      );
    } finally {
      fs.rmSync(rebuilt, { force: true });
      fs.rmSync(`${rebuilt}.sha256`, { force: true });
    }
  });

  it("admin.cjs rebuilds byte-identical from admin-main.ts", async () => {
    const rebuilt = scratch("admin.cjs");
    try {
      await buildAdminDaemon(rebuilt);
      assert.equal(
        fs.readFileSync(rebuilt).equals(fs.readFileSync(path.join(import.meta.dirname, "admin.cjs"))),
        true,
        "admin.cjs is stale — run `npm run build` and commit both the bundle and its .sha256",
      );
    } finally {
      fs.rmSync(rebuilt, { force: true });
      fs.rmSync(`${rebuilt}.sha256`, { force: true });
    }
  });

  it("web-picker.user.js rebuilds byte-identical from web-picker.src/", async () => {
    const rebuilt = scratch("web-picker.user.js");
    try {
      await buildWebPicker(rebuilt);
      assert.equal(
        fs.readFileSync(rebuilt).equals(fs.readFileSync(path.join(import.meta.dirname, "web-picker.user.js"))),
        true,
        "web-picker.user.js is stale — run `npm run build` and commit it",
      );
    } finally {
      fs.rmSync(rebuilt, { force: true });
    }
  });
});
