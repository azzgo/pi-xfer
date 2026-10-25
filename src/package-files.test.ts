/**
 * package-files.test.ts — the published tarball must contain every file the
 * extension imports at load time.
 *
 * Regression guard: `src/broker/broker-manager.ts` imported `pidAlive` from
 * `../../daemon/broker-main.ts` while `files` shipped only `src/**` and `dist/`.
 * The repo tree loaded fine, but an npm install failed with
 * `Cannot find module '../../daemon/broker-main.ts'`, the extension never
 * registered, and `pi --xfer <name>` reported `Unknown option: --xfer`.
 *
 * The check is static and hermetic: walk the relative imports of every shipped
 * module and assert each target is matched by the `files` patterns.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.join(import.meta.dirname, "..");

function shippedFiles(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { files: string[] };
  return pkg.files;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped.replace(/\u0000/g, "(?:[^/]+/)*")}$`);
}

function isShipped(relativePath: string, patterns: string[]): boolean {
  const positive = patterns.filter((p) => !p.startsWith("!"));
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  return positive.some((p) => globToRegExp(p).test(relativePath)) && !negative.some((re) => re.test(relativePath));
}

function moduleGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(path.join(root, entry), "utf-8");
  for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const specifier = match[1]!;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
    const target = specifier.endsWith(".ts") || specifier.endsWith(".js") || specifier.endsWith(".mjs")
      ? base
      : `${base}.ts`;
    moduleGraph(target, seen);
  }
  return seen;
}

describe("published package files", () => {
  it("ships every module the extension imports, including daemon sources", () => {
    const patterns = shippedFiles();
    const missing = [...moduleGraph("index.ts")].filter((file) => !isShipped(file, patterns)).sort();
    assert.deepEqual(
      missing,
      [],
      `these imported files are absent from package.json "files": ${missing.join(", ")} — an npm install would fail to load the extension`,
    );
  });

  it("ships the daemon sources that the page-tool follow-up hint names", () => {
    const patterns = shippedFiles();
    for (const file of ["daemon/broker-main.ts", "dist/broker.cjs"]) {
      assert.ok(isShipped(file, patterns), `${file} must ship: handoff docs point runs at it`);
    }
  });
});
