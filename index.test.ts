/**
 * index.test.ts — the two handoff tools as the model sees them: `kind` is a
 * required part of the contract, offers exactly the two values, and the tool
 * description never re-opens the "reply if it's worth saying" judgement
 * (docs/adr/0018-handoff-kind-sender-declares.md).
 *
 * Hermetic: a stub `pi` captures tool registrations and nothing is started —
 * no socket, no mesh, no writes under a real `~/.pi/xfer`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

interface CapturedTool {
  name: string;
  description: string;
  parameters: { required?: string[]; properties: Record<string, any> };
}

const KINDS = [
  { type: "string", const: "task" },
  { type: "string", const: "notification" },
];

let tools: Map<string, CapturedTool>;
let tmpDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-index-test-"));

  const stubPath = path.join(tmpDir, "pi-runtime-stub.mjs");
  fs.writeFileSync(stubPath, "export async function copyToClipboard() {}\n");
  const stubUrl = pathToFileURL(stubPath).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-coding-agent") return { url: stubUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  tools = new Map();
  const pi = {
    registerFlag: () => {},
    registerCommand: () => {},
    registerTool: (tool: CapturedTool) => { tools.set(tool.name, tool); },
    on: () => {},
    getActiveTools: () => [],
  };
  const register = (await import("./index.js")).default;
  register(pi as never);
});

after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("handoff tools: the declared kind", () => {
  for (const name of ["xfer_to", "xfer_mesh_to"]) {
    it(`${name} registers`, () => {
      assert.ok(tools.has(name), `${name} was not registered`);
    });

    it(`${name} requires kind and offers exactly the two values`, () => {
      const tool = tools.get(name)!;
      assert.ok(tool.parameters.required?.includes("kind"), `${name} must require kind`);
      assert.deepEqual(tool.parameters.properties.kind.anyOf, KINDS);
    });

    it(`${name} states what each kind obliges`, () => {
      const tool = tools.get(name)!;
      assert.match(tool.description, /"task" asks the target for output and comes back with exactly one conclusion/);
      assert.match(tool.description, /"notification" informs and stays silent/);
    });

    it(`${name} never re-opens the reply-if-worth-saying judgement`, () => {
      const tool = tools.get(name)!;
      assert.doesNotMatch(tool.description, /only xfer when you have meaningful new information/);
      assert.match(tool.description, /Never send a handoff that only acknowledges or confirms/);
    });
  }
});
