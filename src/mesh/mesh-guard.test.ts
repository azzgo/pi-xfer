/**
 * The reverse test for the mesh network guard: with the guard armed (a test
 * run), a non-loopback endpoint must fail *structurally* — from both outbound
 * planes and from the config default — while loopback keeps working.
 *
 * Run via `npm test` in this directory.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  MeshRemoteBlockedError,
  assertEndpointReachable,
  endpointHost,
  guardMeshConfig,
  inTestContext,
  isLoopbackEndpoint,
  meshGuardLedger,
  remoteExplicitlyAllowed,
  resetMeshGuardLedger,
  resolveMeshConfigPath,
} from "./mesh-guard.ts";
import { MESH_CONFIG_PATH } from "../core/constants.ts";

const REMOTE = "https://engine.example.com";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-guard-test-"));
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** The env a `node --test` worker actually runs with, plus nothing else. */
const ARMED: NodeJS.ProcessEnv = { NODE_TEST_CONTEXT: "child-v8" };
const UNARMED: NodeJS.ProcessEnv = {};

beforeEach(() => { resetMeshGuardLedger(); });

describe("mesh guard: when it is armed", () => {
  it("is armed by exactly what node sets for a test run, and by nothing else", () => {
    assert.equal(inTestContext({ NODE_TEST_CONTEXT: "child-v8" }), true);
    assert.equal(inTestContext({ NODE_TEST_CONTEXT: "spawn" }), true, "a process spawned from a test is still a test");
    assert.equal(inTestContext({}), false);
    assert.equal(inTestContext({ NODE_ENV: "test" }), false, "NODE_ENV alone never arms it");
    assert.equal(inTestContext({ npm_lifecycle_event: "test" }), false);
  });

  it("refuses a non-loopback endpoint from the shared funnel", () => {
    assert.throws(
      () => assertEndpointReachable(REMOTE, ARMED),
      (err: unknown) =>
        err instanceof MeshRemoteBlockedError &&
        err.endpoint === REMOTE &&
        /refusing to reach "https:\/\/engine\.example\.com" from a test run/.test(err.message) &&
        /XFER_ALLOW_REMOTE=1/.test(err.message),
    );
    assert.deepEqual(meshGuardLedger().blocked, [REMOTE]);
  });

  it("allows loopback, however it is spelled", () => {
    for (const endpoint of ["http://localhost:6420", "http://127.0.0.1:6420", "http://[::1]:6420"]) {
      assert.equal(isLoopbackEndpoint(endpoint), true, endpoint);
      assertEndpointReachable(endpoint, ARMED);
    }
    assert.equal(meshGuardLedger().loopback, 3);
    assert.deepEqual(meshGuardLedger().blocked, []);
  });

  it("refuses an endpoint it cannot even parse rather than guessing", () => {
    assert.equal(endpointHost("not a url"), null);
    assert.equal(isLoopbackEndpoint("not a url"), false);
    assert.throws(() => assertEndpointReachable("not a url", ARMED), MeshRemoteBlockedError);
  });

  it("refuses the rivetkit client plane too, not just REST", () => {
    assert.throws(
      () => guardMeshConfig({ endpoint: REMOTE, token: "t" }, ARMED),
      MeshRemoteBlockedError,
    );
    assert.deepEqual(guardMeshConfig({ endpoint: "http://localhost:6420" }, ARMED), { endpoint: "http://localhost:6420" });
  });

  it("lets a deliberate opt-in through and records it", () => {
    const open = { NODE_TEST_CONTEXT: "child-v8", XFER_ALLOW_REMOTE: "1" };
    assert.equal(remoteExplicitlyAllowed(open), true);
    assertEndpointReachable(REMOTE, open);
    assert.deepEqual(meshGuardLedger().allowed, [REMOTE]);
    assert.deepEqual(meshGuardLedger().blocked, [], "the opt-in is the only way through");
  });

  it("treats any value other than 1 as not opted in", () => {
    assert.equal(remoteExplicitlyAllowed({ XFER_ALLOW_REMOTE: "true" }), false);
    assert.equal(remoteExplicitlyAllowed({ XFER_ALLOW_REMOTE: "0" }), false);
    assert.throws(() => assertEndpointReachable(REMOTE, { NODE_TEST_CONTEXT: "x", XFER_ALLOW_REMOTE: "yes" }), MeshRemoteBlockedError);
  });
});

describe("mesh guard: when it is not armed", () => {
  it("stays out of the way of every real process", () => {
    assertEndpointReachable(REMOTE, UNARMED);
    guardMeshConfig({ endpoint: REMOTE }, UNARMED);
    assert.equal(meshGuardLedger().unguarded, 2);
    assert.deepEqual(meshGuardLedger().blocked, []);
  });

  it("leaves the real config path alone", () => {
    const real = path.join(os.homedir(), ".pi", "xfer", "mesh.config.json");
    assert.equal(resolveMeshConfigPath(real, UNARMED), real);
  });
});

describe("mesh guard: the config default in a test run", () => {
  const real = path.join(os.homedir(), ".pi", "xfer", "mesh.config.json");

  it("never resolves to the developer's real config", () => {
    const resolved = resolveMeshConfigPath(real, ARMED);
    assert.notEqual(resolved, real);
    assert.equal(fs.existsSync(resolved), false, "the test default must not exist, so a missed injection fails loudly");
  });

  it("honours an explicit per-test override", () => {
    const override = path.join(tmpDir, "mesh.config.json");
    assert.equal(resolveMeshConfigPath(real, { NODE_TEST_CONTEXT: "x", XFER_MESH_CONFIG: override }), override);
  });

  it("is what the extension's own default constant resolves to under npm test", () => {
    assert.notEqual(MESH_CONFIG_PATH, real, "the shipped default must not point at the developer's config in a test run");
  });
});

describe("mesh guard: the test suite itself never opts out", () => {
  const root = path.resolve(import.meta.dirname, "../..");

  it("sets XFER_ALLOW_REMOTE in no test file, so npm test grants zero remote allowances", () => {
    const testFiles = fs.readdirSync(root, { recursive: true } as { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.js"));
    assert.ok(testFiles.length > 20, `sanity: found ${testFiles.length} test files`);
    const enabling = testFiles.filter((name) => {
      const source = fs.readFileSync(path.join(root, name), "utf-8");
      return /XFER_ALLOW_REMOTE["'\]\s]*(?:=|:)\s*["']1["']|XFER_ALLOW_REMOTE=1/.test(source) && !name.endsWith("mesh-guard.test.ts");
    });
    assert.deepEqual(enabling, [], "no test may enable the opt-in outside the guard's own test");
  });

  it("leaves the opt-in unset in this very process", () => {
    assert.equal(process.env.XFER_ALLOW_REMOTE, undefined, "npm test must never arm the escape hatch");
    resetMeshGuardLedger();
    for (const endpoint of ["http://localhost:1", "http://127.0.0.1:1"]) {
      assertEndpointReachable(endpoint);
    }
    assert.deepEqual(meshGuardLedger().allowed, [], "zero non-loopback allowances in a hermetic run");
  });
});
