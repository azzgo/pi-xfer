import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

/**
 * leak guard: `npm run build` writes mesh-runtime.cjs.sha256 alongside the
 * bundle. The committed bundle must always match that checksum, so anyone who
 * rebuilds but forgets to commit the bundle (or the checksum) turns the suite
 * red — on every machine, no build-time deps needed.
 */
describe("mesh runtime bundle consistency", () => {
  it("mesh-runtime.cjs matches its committed .sha256 checksum", () => {
    const bundlePath = path.join(import.meta.dirname, "../../dist/mesh-runtime.cjs");
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

/**
 * API-shape guard: the xfer-instance actor leans on the pinned rivetkit's
 * `state` + `actions` config keys. Nothing else in the suite exercises the real
 * library (the engine only loads on `/xfer mesh up`), so a rivetkit bump that
 * drops or renames them would otherwise surface as a broken mesh at runtime —
 * this turns it into a red test on the machine that bumps the pin. The test
 * skips where rivetkit is absent — it is deliberately not any kind of npm
 * dependency (ADR 0013), so the guard only runs on machines that installed
 * rivetkit, i.e. the one bumping the pin.
 */
import { RIVETKIT_VERSION } from "./mesh-native.ts";

describe("rivetkit actor API shape", () => {
  it("accepts state + actions on an actor definition", async () => {
    const rivetkitInstalled = fs.existsSync(path.join(import.meta.dirname, "node_modules", "rivetkit"));
    if (!rivetkitInstalled) {
      console.log(`skipping: rivetkit not installed locally — run \`npm install --no-save rivetkit@${RIVETKIT_VERSION}\` to run this guard`);
      return;
    }
    const { actor, queue } = await import("rivetkit");
    const definition = actor({
      state: { description: "" },
      actions: {
        setDescription: async () => "",
        getDescription: async () => "",
      },
      queues: { handoff: queue() },
      run: async () => {},
    });
    const config = (definition as unknown as { config: { actions: Record<string, unknown>; state: unknown } }).config;
    assert.deepEqual(Object.keys(config.actions).sort(), ["getDescription", "setDescription"]);
    assert.deepEqual(config.state, { description: "" });
  });
});
