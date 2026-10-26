/**
 * constants.test.ts — readModulePackageVersion must work from BOTH daemon
 * dirnames.
 *
 * Regression: VERSION read `<dirname>/package.json` directly. That is correct
 * in the repo tree (`daemon/../package.json` was never reached — it read
 * `daemon/package.json`, which does not exist) and in a bundle `dirname` is
 * `dist/`, so both shipped daemons reported `version: "?"`. The version-drift
 * check then warned on every healthy install.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { readModulePackageVersion, readPackageVersion } from "./constants.ts";

const tmpDirs: string[] = [];

function pkgFixture(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-version-"));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-xfer", version }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(root, "daemon"));
  return root;
}

after(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readModulePackageVersion", () => {
  it("finds the version from the bundle dirname (dist/)", () => {
    const root = pkgFixture("1.2.3");
    assert.equal(readModulePackageVersion(path.join(root, "dist")), "1.2.3");
  });

  it("finds the version from the source dirname (daemon/)", () => {
    const root = pkgFixture("4.5.6");
    assert.equal(readModulePackageVersion(path.join(root, "daemon")), "4.5.6");
  });

  it("finds the version when the module sits at the package root", () => {
    const root = pkgFixture("7.8.9");
    assert.equal(readModulePackageVersion(root), "7.8.9");
  });

  it("resolves the real checkout's version from dist/ and daemon/ alike", () => {
    const checkout = path.join(import.meta.dirname, "../..");
    const expected = readPackageVersion(checkout);
    assert.ok(expected, "the checkout has a version");
    assert.equal(readModulePackageVersion(path.join(checkout, "dist")), expected);
    assert.equal(readModulePackageVersion(path.join(checkout, "daemon")), expected);
  });

  it("answers '?' — never a guess — when no package.json is reachable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-version-none-"));
    tmpDirs.push(root);
    assert.equal(readModulePackageVersion(path.join(root, "dist")), "?");
  });
});
