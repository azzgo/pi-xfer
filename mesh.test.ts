import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { MeshNode, loadMeshRuntimeBundle, MESH_RUNTIME_BUNDLE } from "./mesh.js";
import { parseMeshConfig, serializeMeshKey, deserializeMeshKey } from "./mesh-config.js";
import {
  applyDescriptionAction,
  normalizeNodeDescription,
  readDescriptionAction,
  type MeshEngine,
  type MeshHandoffMessage,
  type MeshNodeInfo,
  type XferInstanceState,
} from "./mesh-engine.js";
import type { XferNotifyMessage } from "./types.js";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-mesh-test-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeConfig(config: unknown): string {
  const configPath = path.join(tmpDir, `mesh-${Math.random().toString(36).slice(2)}.config.json`);
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

interface FakeEngineState {
  nodes: MeshNodeInfo[];
  ensured: string[];
  stopped: number;
  destroyed: string[];
  sent: Array<{ target: string; message: MeshHandoffMessage }>;
  /** Descriptions as the fake engine "holds" them, keyed by node name. */
  descriptions: Record<string, string>;
  /** Names whose actor is unreachable (describe rejects). */
  unreachable: string[];
  upFail?: boolean;
}

function fakeEngine(state: FakeEngineState): MeshEngine {
  return {
    async ensureNode(name) {
      if (state.upFail) throw new Error("engine unreachable");
      state.ensured.push(name);
      state.nodes.push({ name, actorId: `actor-${name}` });
    },
    async stop() { state.stopped += 1; },
    async listNodes() { return [...state.nodes]; },
    async destroyNode(actorId) {
      state.destroyed.push(actorId);
      state.nodes = state.nodes.filter((n) => n.actorId !== actorId);
    },
    async queueSend(target, message) { state.sent.push({ target, message }); },
    async setDescription(value) {
      const name = state.nodes.find((n) => n.actorId === `actor-${state.ensured.at(-1)}`);
      const key = name?.name ?? state.ensured.at(-1) ?? "";
      const stored = normalizeNodeDescription(value);
      state.descriptions[key] = stored;
      return stored;
    },
    async getDescription(target) {
      if (state.unreachable.includes(target)) throw new Error(`mesh: describe "${target}" failed — actor unreachable`);
      return state.descriptions[target] ?? "";
    },
  };
}

function makeNode(configPath: string, engine: MeshEngine, delivered: XferNotifyMessage[] = []): MeshNode {
  return new MeshNode({
    configPath,
    deliver: (msg) => delivered.push(msg),
    engineFactory: () => engine,
  });
}

describe("mesh config", () => {
  it("parses endpoint with explicit namespace/token", () => {
    const config = parseMeshConfig({ endpoint: "http://localhost:6420", namespace: "prod", token: "sk_1" });
    assert.deepEqual(config, { endpoint: "http://localhost:6420", namespace: "prod", token: "sk_1" });
  });

  it("extracts namespace/token from URL auth syntax and strips them from the endpoint", () => {
    const config = parseMeshConfig({ endpoint: "https://myns:sk_abc@mesh.example.com" });
    assert.equal(config.endpoint, "https://mesh.example.com/");
    assert.equal(config.namespace, "myns");
    assert.equal(config.token, "sk_abc");
  });

  it("rejects a missing or empty endpoint", () => {
    assert.throws(() => parseMeshConfig({}), /endpoint/);
    assert.throws(() => parseMeshConfig({ endpoint: "  " }), /endpoint/);
  });

  it("round-trips actor keys", () => {
    assert.equal(serializeMeshKey(["web"]), "web");
    assert.deepEqual(deserializeMeshKey("web"), ["web"]);
    assert.deepEqual(deserializeMeshKey("/"), []);
    assert.deepEqual(deserializeMeshKey(serializeMeshKey(["a/b", "c\\d"])), ["a/b", "c\\d"]);
  });
});

describe("mesh node descriptions", () => {
  const fresh = (): FakeEngineState => ({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] });

  it("set stores the trimmed value on this node and returns it", async () => {
    const state = fresh();
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.equal(await node.setDescription("  handles auth reviews  "), "handles auth reviews");
    assert.equal(state.descriptions.web, "handles auth reviews");
  });

  it("set with empty text clears the description", async () => {
    const state = fresh();
    state.descriptions.web = "handles auth reviews";
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.equal(await node.setDescription(""), "");
    assert.equal(state.descriptions.web, "");
  });

  it("set rejects a non-string and an over-long description", () => {
    assert.throws(() => normalizeNodeDescription(42), /must be a string/);
    assert.throws(() => normalizeNodeDescription("x".repeat(501)), /limited to 500 characters/);
    assert.equal(normalizeNodeDescription("x".repeat(500)).length, 500);
    assert.equal(normalizeNodeDescription("   "), "");
  });

  it("actor action bodies trim + cap on write and read back what is stored", async () => {
    const state: XferInstanceState = { description: "" };
    assert.equal(await readDescriptionAction(state), "");
    assert.equal(await applyDescriptionAction(state, "  handles auth reviews  "), "handles auth reviews");
    assert.equal(state.description, "handles auth reviews");
    assert.equal(await readDescriptionAction(state), "handles auth reviews");
    assert.equal(await applyDescriptionAction(state, "   "), "");
    await assert.rejects(() => applyDescriptionAction(state, "x".repeat(501)), /limited to 500 characters/);
  });

  it("describe returns another node's stored description", async () => {
    const state = fresh();
    state.descriptions.phone = "handles iOS build fixes";
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(await node.describe("phone"), { name: "phone", description: "handles iOS build fixes" });
    assert.deepEqual(await node.describe("quiet"), { name: "quiet", description: "" });
  });

  it("describe surfaces the offline error for an unreachable node", async () => {
    const state = fresh();
    state.unreachable.push("phone");
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await assert.rejects(() => node.describe("phone"), /actor unreachable/);
  });

  it("set + describe require the mesh to be online", async () => {
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(fresh()));
    await assert.rejects(() => node.setDescription("x"), /not online/);
    await assert.rejects(() => node.describe("phone"), /not online/);
  });
});

describe("mesh node lifecycle", () => {
  it("up connects under the given name after a conflict check", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
    assert.deepEqual(node.status(), { online: true, name: "web" });
  });

  it("up refuses when a node with the same name already exists", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await assert.rejects(() => node.up("web"), /already exists/);
    assert.deepEqual(state.ensured, []);
    assert.deepEqual(node.status(), { online: false });
  });

  it("up surfaces config errors with the config path", async () => {
    const node = makeNode(path.join(tmpDir, "does-not-exist.config.json"), fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] }));
    await assert.rejects(() => node.up("web"), /mesh not configured/);
  });

  it("up awaits an async engineFactory (default bundle-loading path)", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const engine = fakeEngine(state);
    const node = new MeshNode({
      configPath: writeConfig({ endpoint: "http://localhost:6420" }),
      deliver: () => {},
      engineFactory: async (config) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return engine;
      },
    });
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
    assert.deepEqual(node.status(), { online: true, name: "web" });
  });

  it("up refuses when already online", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await assert.rejects(() => node.up("web"), /already online/);
  });

  it("down destroys this node's actor and stops the engine exactly once", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const engine = fakeEngine(state);
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine);
    await node.up("web");
    await node.down();
    assert.deepEqual(state.destroyed, ["actor-web"]);
    assert.equal(state.stopped, 1);
    assert.deepEqual(node.status(), { online: false });
  });

  it("down stops the engine even when the destroy query fails", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const engine = fakeEngine(state);
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine);
    await node.up("web");
    engine.listNodes = async () => { throw new Error("engine gone"); };
    await assert.rejects(() => node.down(), /engine gone/);
    assert.equal(state.stopped, 1);
    assert.deepEqual(node.status(), { online: false });
  });
});

describe("mesh messaging", () => {
  it("send enqueues the full inline payload with id/from/summary/document", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    const { id } = await node.send("phone", { summary: "fix the thing", document: "# Handoff\n\nbody" });
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].target, "phone");
    assert.equal(state.sent[0].message.id, id);
    assert.equal(state.sent[0].message.from, "web");
    assert.equal(state.sent[0].message.to, "phone");
    assert.equal(state.sent[0].message.summary, "fix the thing");
    assert.equal(state.sent[0].message.document, "# Handoff\n\nbody");
  });

  it("send requires being online", async () => {
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] }));
    await assert.rejects(() => node.send("phone", { summary: "s", document: "d" }), /not online/);
  });

  it("list queries the engine live and requires being online", async () => {
    const state: FakeEngineState = { nodes: [{ name: "phone", actorId: "a1" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await assert.rejects(() => node.list(), /not online/);
    await node.up("web");
    const nodes = await node.list();
    assert.deepEqual(nodes, [{ name: "phone", actorId: "a1" }, { name: "web", actorId: "actor-web" }]);
  });
});

describe("mesh inbound delivery", () => {
  it("writes the doc to /tmp and routes it through the local deliver pipeline", async () => {
    const delivered: XferNotifyMessage[] = [];
    const engine = fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] });
    const sink = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine, delivered);
    (sink as unknown as { onHandoff(m: MeshHandoffMessage, selfKey: string): void }).onHandoff({
      id: "mid-1",
      from: "web",
      to: "sink",
      summary: "check auth flow",
      document: "# doc body",
    }, "sink");
    assert.equal(delivered.length, 1);
    const msg = delivered[0];
    assert.equal(msg.type, "xfer-notify");
    assert.equal(msg.msg_id, "mid-1");
    assert.equal(msg.from, "web");
    assert.equal(msg.summary, "check auth flow");
    assert.match(msg.file, /pi-xfer-mid-1\.md$/);
    assert.equal(fs.readFileSync(msg.file, "utf-8"), "# doc body");
    fs.rmSync(msg.file, { force: true });
  });

  it("refuses a handoff addressed to another node instead of delivering it", async () => {
    const delivered: XferNotifyMessage[] = [];
    const sink = makeNode(
      writeConfig({ endpoint: "http://localhost:6420" }),
      fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] }),
      delivered,
    );
    (sink as unknown as { onHandoff(m: MeshHandoffMessage, selfKey: string): void }).onHandoff({
      id: "mid-2",
      from: "web",
      to: "phone",
      summary: "meant for phone",
      document: "# not mine",
    }, "sink");
    assert.equal(delivered.length, 1, "misroute is surfaced, not dropped");
    assert.equal(delivered[0].msg_id, "mid-2");
    assert.equal(delivered[0].from, "web");
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), "pi-xfer-mid-2.md")), "no doc is written for a misrouted handoff");
    assert.match(delivered[0].summary, /misroute/);
  });

  it("delivers a handoff with no `to` for compatibility with older senders", async () => {
    const delivered: XferNotifyMessage[] = [];
    const sink = makeNode(
      writeConfig({ endpoint: "http://localhost:6420" }),
      fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] }),
      delivered,
    );
    (sink as unknown as { onHandoff(m: MeshHandoffMessage, selfKey: string): void }).onHandoff({
      id: "mid-3",
      from: "web",
      summary: "legacy",
      document: "# legacy body",
    }, "sink");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].msg_id, "mid-3");
    assert.equal(fs.readFileSync(delivered[0].file, "utf-8"), "# legacy body");
    fs.rmSync(delivered[0].file, { force: true });
  });
});

describe("mesh runtime bundle", () => {
  it("loads the committed bundle with a createRivetEngine export", async () => {
    const mod = await loadMeshRuntimeBundle();
    assert.equal(typeof mod.createRivetEngine, "function");
    assert.equal(typeof mod.RIVETKIT_VERSION, "string");
  });

  it("reports a rebuild hint when the bundle is missing", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-no-bundle-"));
    try {
      await assert.rejects(() => loadMeshRuntimeBundle(emptyDir), /npm run build/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("the bundle lives next to the extension source", () => {
    assert.ok(fs.existsSync(path.join(import.meta.dirname, MESH_RUNTIME_BUNDLE)));
  });
});
