import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { MeshNode } from "./mesh.js";
import { parseMeshConfig, serializeMeshKey, deserializeMeshKey } from "./mesh-config.js";
import type { MeshEngine, MeshHandoffMessage, MeshNodeInfo } from "./mesh-engine.js";
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

describe("mesh node lifecycle", () => {
  it("up connects under the given name after a conflict check", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
    assert.deepEqual(node.status(), { online: true, name: "web" });
  });

  it("up refuses when a node with the same name already exists", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web" }], ensured: [], stopped: 0, destroyed: [], sent: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await assert.rejects(() => node.up("web"), /already exists/);
    assert.deepEqual(state.ensured, []);
    assert.deepEqual(node.status(), { online: false });
  });

  it("up surfaces config errors with the config path", async () => {
    const node = makeNode(path.join(tmpDir, "does-not-exist.config.json"), fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] }));
    await assert.rejects(() => node.up("web"), /mesh not configured/);
  });

  it("up refuses when already online", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await assert.rejects(() => node.up("web"), /already online/);
  });

  it("down destroys this node's actor and stops the engine exactly once", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] };
    const engine = fakeEngine(state);
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine);
    await node.up("web");
    await node.down();
    assert.deepEqual(state.destroyed, ["actor-web"]);
    assert.equal(state.stopped, 1);
    assert.deepEqual(node.status(), { online: false });
  });

  it("down stops the engine even when the destroy query fails", async () => {
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] };
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
    const state: FakeEngineState = { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    const { id } = await node.send("phone", { summary: "fix the thing", document: "# Handoff\n\nbody" });
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].target, "phone");
    assert.equal(state.sent[0].message.id, id);
    assert.equal(state.sent[0].message.from, "web");
    assert.equal(state.sent[0].message.summary, "fix the thing");
    assert.equal(state.sent[0].message.document, "# Handoff\n\nbody");
  });

  it("send requires being online", async () => {
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] }));
    await assert.rejects(() => node.send("phone", { summary: "s", document: "d" }), /not online/);
  });

  it("list queries the engine live and requires being online", async () => {
    const state: FakeEngineState = { nodes: [{ name: "phone", actorId: "a1" }], ensured: [], stopped: 0, destroyed: [], sent: [] };
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
    const engine = fakeEngine({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [] });
    const sink = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine, delivered);
    (sink as unknown as { onHandoff(m: MeshHandoffMessage): void }).onHandoff({
      id: "mid-1",
      from: "web",
      summary: "check auth flow",
      document: "# doc body",
    });
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
});
