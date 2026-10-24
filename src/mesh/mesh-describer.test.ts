/**
 * The mesh describer degrades to "no description" when the mesh cannot be
 * reached. That degradation is right, but it used to be loud: the broker built
 * a fresh describer per `targets.list` call, so an unreachable mesh logged the
 * same "descriptions unavailable" line on every request — 12 MB of identical
 * lines in `broker.log`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createMeshDescriber } from "./mesh-describer.ts";

describe("mesh describer", () => {
  it("reuses one describer per config path, so a failure is reported once", () => {
    const configPath = path.join(os.tmpdir(), `xfer-describer-${process.pid}.json`);
    try {
      assert.equal(createMeshDescriber(configPath), createMeshDescriber(configPath));
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });

  it("keeps a different config path on its own describer", () => {
    const a = path.join(os.tmpdir(), `xfer-describer-a-${process.pid}.json`);
    const b = path.join(os.tmpdir(), `xfer-describer-b-${process.pid}.json`);
    try {
      assert.notEqual(createMeshDescriber(a), createMeshDescriber(b));
    } finally {
      fs.rmSync(a, { force: true });
      fs.rmSync(b, { force: true });
    }
  });

  it("degrades to no description when the config is unreadable", async () => {
    const configPath = path.join(os.tmpdir(), `xfer-describer-missing-${process.pid}.json`);
    try {
      const describe = createMeshDescriber(configPath);
      assert.equal(await describe("phone"), undefined);
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });
});
