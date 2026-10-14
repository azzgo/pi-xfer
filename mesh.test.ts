import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { MeshNode, loadMeshRuntimeBundle, MESH_RUNTIME_BUNDLE } from "./mesh.js";
import { parseMeshConfig, serializeMeshKey, deserializeMeshKey, XFER_INSTANCE_ACTOR } from "./mesh-config.js";
import {
  applyDescriptionAction,
  createRivetEngine,
  deriveActorStatus,
  ensureRunnerPool,
  normalizeNodeDescription,
  readDescriptionAction,
  type MeshEngine,
  type MeshHandoffMessage,
  type MeshNodeInfo,
  type RivetEngineDeps,
  type XferInstanceState,
} from "./mesh-engine.js";
import type { MeshLogSink } from "./mesh-log.js";
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
      const existing = state.nodes.find((n) => n.name === name);
      if (existing) {
        // Adoption: the same actor re-resolves in this process and goes Running.
        state.nodes = state.nodes.map((n) => (n.name === name ? { ...n, status: "Running" } : n));
      } else {
        state.nodes.push({ name, actorId: `actor-${name}`, status: "Running" });
      }
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

/** A per-test mesh log path, so no test ever touches the real `<xfer-dir>/mesh.log`. */
function meshLogPath(label = "mesh"): string {
  return path.join(tmpDir, `${label}-${Math.random().toString(36).slice(2)}.log`);
}

function makeNode(
  configPath: string,
  engine: MeshEngine,
  delivered: XferNotifyMessage[] = [],
  logPath: string = meshLogPath(),
): MeshNode {
  return new MeshNode({
    configPath,
    deliver: (msg) => delivered.push(msg),
    engineFactory: () => engine,
    logPath,
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

  it("passes a non-empty pool through, trimmed", () => {
    const config = parseMeshConfig({ endpoint: "http://localhost:6420", pool: "  host-a  " });
    assert.equal(config.pool, "host-a");
    assert.deepEqual(config, { endpoint: "http://localhost:6420", pool: "host-a" });
  });

  it("rejects an empty or non-string pool", () => {
    assert.throws(() => parseMeshConfig({ endpoint: "http://localhost:6420", pool: "" }), /"pool" must be a non-empty string/);
    assert.throws(() => parseMeshConfig({ endpoint: "http://localhost:6420", pool: "   " }), /"pool" must be a non-empty string/);
    assert.throws(() => parseMeshConfig({ endpoint: "http://localhost:6420", pool: 42 }), /"pool" must be a non-empty string/);
  });

  it("rejects credentials set twice (URL userinfo + explicit fields)", () => {
    assert.throws(
      () => parseMeshConfig({ endpoint: "https://ns:token@example.com:6420", namespace: "ns", token: "token" }),
      /credentials twice/,
    );
    assert.throws(
      () => parseMeshConfig({ endpoint: "https://placeholder:placeholder@example.com:6420", namespace: "ns" }),
      /credentials twice/,
    );
  });

  it("omits pool entirely when absent (backward-compatible parse)", () => {
    const config = parseMeshConfig({ endpoint: "http://localhost:6420" });
    assert.equal("pool" in config, false);
  });

  it("round-trips actor keys", () => {
    assert.equal(serializeMeshKey(["web"]), "web");
    assert.deepEqual(deserializeMeshKey("web"), ["web"]);
    assert.deepEqual(deserializeMeshKey("/"), []);
    assert.deepEqual(deserializeMeshKey(serializeMeshKey(["a/b", "c\\d"])), ["a/b", "c\\d"]);
  });
});

describe("rivet engine wiring", () => {
  interface Recorded {
    runtimeReady: number;
    started: number;
    stopped: number;
    resolved: number;
    setup?: Record<string, unknown>;
    clientConfig?: Record<string, unknown>;
    getOrCreate: unknown[][];
    gets: unknown[][];
  }
  const fresh = (): Recorded => ({ runtimeReady: 0, started: 0, stopped: 0, resolved: 0, getOrCreate: [], gets: [] });

  function fakeDeps(record: Recorded): RivetEngineDeps {
    return {
      ensureRuntimeReady: async () => { record.runtimeReady += 1; },
      importRivetkit: async () => ({
        actor: (definition: unknown) => ({ definition }),
        queue: () => ({}),
        setup: (config: Record<string, unknown>) => {
          record.setup = config;
          return {
            startAndWait: async () => { record.started += 1; },
            shutdown: async () => { record.stopped += 1; },
          };
        },
      }),
      importClient: async () => ({
        createClient: (config: Record<string, unknown>) => {
          record.clientConfig = config;
          return {
            getOrCreate: (...args: unknown[]) => {
              record.getOrCreate.push(args);
              return { resolve: async () => { record.resolved += 1; } };
            },
            get: (...args: unknown[]) => {
              record.gets.push(args);
              return { send: async () => {}, action: async () => "" };
            },
          };
        },
      }),
    };
  }

  const handoff: MeshHandoffMessage = { id: "1", from: "web", to: "phone", summary: "s", document: "d" };

  it("pins setup's envoy and the self-actor create to the configured pool", async () => {
    const record = fresh();
    const engine = createRivetEngine({ endpoint: "http://localhost:6420", pool: "host-a" }, () => {}, fakeDeps(record));
    await engine.ensureNode("web");
    assert.equal(record.runtimeReady, 1);
    assert.deepEqual(record.setup?.envoy, { poolName: "host-a" });
    assert.deepEqual(record.getOrCreate, [[XFER_INSTANCE_ACTOR, ["web"], { poolName: "host-a" }]]);
    assert.equal(record.resolved, 1);
    assert.equal(record.started, 1);
  });

  it("omits every pool field when no pool is configured (backward-compatible call shape)", async () => {
    const record = fresh();
    const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, () => {}, fakeDeps(record));
    await engine.ensureNode("web");
    assert.equal("envoy" in (record.setup ?? {}), false, "setup carries no envoy block");
    assert.deepEqual(record.getOrCreate, [[XFER_INSTANCE_ACTOR, ["web"]]], "getOrCreate takes name + key only");
  });

  it("keeps queueSend and describe un-pooled so remote pools stay addressable", async () => {
    const record = fresh();
    const engine = createRivetEngine({ endpoint: "http://localhost:6420", pool: "host-a" }, () => {}, fakeDeps(record));
    await engine.ensureNode("web");
    await engine.queueSend("phone", handoff);
    await engine.getDescription("phone");
    assert.deepEqual(record.gets, [
      [XFER_INSTANCE_ACTOR, ["phone"]],
      [XFER_INSTANCE_ACTOR, ["phone"]],
    ]);
  });

  it("silences the runtime and the welcome banner on ensureNode", async () => {
    const record = fresh();
    const saved = process.env.RIVET_LOG_LEVEL;
    delete process.env.RIVET_LOG_LEVEL;
    try {
      const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, () => {}, fakeDeps(record));
      await engine.ensureNode("web");
      assert.equal(process.env.RIVET_LOG_LEVEL, "silent", "the native + JS loggers are pinned quiet");
      assert.equal(record.setup?.noWelcome, true, "the RivetKit welcome banner stays off the host stdout");
    } finally {
      if (saved === undefined) delete process.env.RIVET_LOG_LEVEL;
      else process.env.RIVET_LOG_LEVEL = saved;
    }
  });

  it("respects a level the host set explicitly", async () => {
    const record = fresh();
    const saved = process.env.RIVET_LOG_LEVEL;
    process.env.RIVET_LOG_LEVEL = "debug";
    try {
      const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, () => {}, fakeDeps(record));
      await engine.ensureNode("web");
      assert.equal(process.env.RIVET_LOG_LEVEL, "debug");
    } finally {
      if (saved === undefined) delete process.env.RIVET_LOG_LEVEL;
      else process.env.RIVET_LOG_LEVEL = saved;
    }
  });

  it("routes rivetkit's own logger into the mesh log instead of the host stdout", async () => {
    const record = fresh();
    const logPath = meshLogPath("sink");
    const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, () => {}, fakeDeps(record), { logPath });
    await engine.ensureNode("web");
    const sink = (record.setup?.logging as { baseLogger?: MeshLogSink } | undefined)?.baseLogger;
    assert.equal(typeof sink?.warn, "function", "setup receives a pino-shaped base logger");
    sink?.child({ actorName: "web" }).warn({ attribute: 1 }, "something happened");
    assert.match(fs.readFileSync(logPath, "utf-8"), /msg="something happened" actorName=web attribute=1/);
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

describe("mesh actor status", () => {
  it("derives the four live states from raw engine timestamps", () => {
    assert.equal(deriveActorStatus({ connectable_ts: 1, start_ts: 1 }), "Running");
    assert.equal(deriveActorStatus({ sleep_ts: 5 }), "Sleeping");
    assert.equal(deriveActorStatus({ error: { message: "boom" } }), "Crashed");
    assert.equal(deriveActorStatus({}), "Pending");
    assert.equal(deriveActorStatus({ start_ts: 1 }), "Pending");
    assert.equal(deriveActorStatus({ destroy_ts: 9 }), "Destroyed");
  });

  it("prefers destroy > error > sleep > running", () => {
    assert.equal(deriveActorStatus({ destroy_ts: 9, error: 1, sleep_ts: 1, connectable_ts: 1 }), "Destroyed");
    assert.equal(deriveActorStatus({ error: 1, sleep_ts: 1, connectable_ts: 1 }), "Crashed");
    assert.equal(deriveActorStatus({ sleep_ts: 1, connectable_ts: 1 }), "Sleeping");
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

  it("up adopts a Sleeping actor of the same name without destroying it", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status: "Sleeping" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
    assert.deepEqual(state.destroyed, [], "adoption never destroys the actor");
    assert.equal(state.nodes[0]?.status, "Running");
    assert.deepEqual(node.status(), { online: true, name: "web" });
  });

  it("up adopts Crashed and Pending actors too", async () => {
    for (const status of ["Crashed", "Pending"] as const) {
      const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
      const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
      await node.up("web");
      assert.deepEqual(state.ensured, ["web"]);
      assert.deepEqual(state.destroyed, []);
    }
  });

  it("up refuses to adopt an actor placed in a different pool than the config targets", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status: "Sleeping", pool: "old-host" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420", pool: "new-host" }), fakeEngine(state));
    await assert.rejects(() => node.up("web"), /placed in "old-host" but this config targets "new-host"/);
    assert.deepEqual(state.ensured, []);
    assert.deepEqual(node.status(), { online: false });
  });

  it("up adopts when the actor's pool matches the configured pool", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status: "Sleeping", pool: "host-a" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420", pool: "host-a" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
  });

  it("up treats a missing pool on either side as the default pool", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status: "Sleeping" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.deepEqual(state.ensured, ["web"]);
  });

  it("up refuses when a Running actor of the same name exists on another host", async () => {
    const state: FakeEngineState = { nodes: [{ name: "web", actorId: "actor-web", status: "Running" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await assert.rejects(() => node.up("web"), /already Running on another host/);
    assert.deepEqual(state.ensured, []);
    assert.deepEqual(state.destroyed, []);
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
      logPath: meshLogPath("async-factory"),
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
    const state: FakeEngineState = { nodes: [{ name: "phone", actorId: "a1", status: "Running" }], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await assert.rejects(() => node.list(), /not online/);
    await node.up("web");
    const nodes = await node.list();
    assert.deepEqual(nodes, [
      { name: "phone", actorId: "a1", status: "Running" },
      { name: "web", actorId: "actor-web", status: "Running" },
    ]);
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

describe("ensureRunnerPool", () => {
  const config = (pool?: string) => ({ endpoint: "http://localhost:6420", ...(pool ? { pool } : {}) });

  function stubFetch(responses: Array<{ method: string; path: string; status: number; body?: unknown }>) {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", url: url.pathname + url.search, body: init?.body ? JSON.parse(init.body) : undefined });
      const match = responses.find((r) => r.method === calls.at(-1)!.method && url.pathname === r.path);
      if (!match) throw new Error(`unexpected ${calls.at(-1)!.method} ${url.pathname}`);
      return new Response(match.body === undefined ? "" : JSON.stringify(match.body), { status: match.status });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  after(() => { /* individual tests restore */ });

  it("creates the runner-config when the engine does not have it", async () => {
    const stub = stubFetch([
      { method: "GET", path: "/runner-configs", status: 200, body: { runner_configs: {} } },
      { method: "PUT", path: "/runner-configs/host-a", status: 200, body: {} },
    ]);
    try {
      const result = await ensureRunnerPool(config("host-a"));
      assert.deepEqual(result, { pool: "host-a", existed: false });
      assert.deepEqual(stub.calls[1]?.body, { datacenters: { default: { normal: {} } } });
    } finally { stub.restore(); }
  });

  it("leaves an existing runner-config untouched", async () => {
    const stub = stubFetch([
      { method: "GET", path: "/runner-configs", status: 200, body: { runner_configs: { "host-a": { datacenters: {} } } } },
    ]);
    try {
      const result = await ensureRunnerPool(config("host-a"));
      assert.deepEqual(result, { pool: "host-a", existed: true });
      assert.equal(stub.calls.length, 1, "no PUT when the config already exists");
    } finally { stub.restore(); }
  });

  it("refuses when the config has no pool", async () => {
    await assert.rejects(() => ensureRunnerPool(config()), /no "pool"/);
  });
});

describe("mesh log", () => {
  const fresh = (): FakeEngineState => ({ nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [] });

  it("up records the session context, the pool, and whether it adopted an actor", async () => {
    const logPath = meshLogPath("up");
    const state = fresh();
    state.nodes.push({ name: "web", actorId: "actor-web", status: "Sleeping", pool: "host-a" });
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420", pool: "host-a" }), fakeEngine(state), [], logPath);
    await node.up("web");
    const line = fs.readFileSync(logPath, "utf-8").trim();
    assert.match(line, / msg="mesh up"/);
    assert.match(line, /node=web/);
    assert.match(line, /endpoint=http:\/\/localhost:6420/);
    assert.match(line, /namespace=default/);
    assert.match(line, /pool=host-a/);
    assert.match(line, /adopted=Sleeping/);
  });

  it("records a refusal and a failure, so a later reader sees why the node never came up", async () => {
    const refused = meshLogPath("refused");
    const running = fresh();
    running.nodes.push({ name: "web", actorId: "actor-web", status: "Running" });
    const taken = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(running), [], refused);
    await assert.rejects(() => taken.up("web"), /already Running/);
    assert.match(fs.readFileSync(refused, "utf-8"), /msg="mesh up refused — node is Running elsewhere".* owner=\(default\)/);

    const failed = meshLogPath("failed");
    const broken = fresh();
    broken.upFail = true;
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(broken), [], failed);
    await assert.rejects(() => node.up("web"), /engine unreachable/);
    assert.match(fs.readFileSync(failed, "utf-8"), /msg="mesh up failed".* error="engine unreachable"/);
  });

  it("records down with the actor it destroyed", async () => {
    const logPath = meshLogPath("down");
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(fresh()), [], logPath);
    await node.up("web");
    await node.down();
    assert.match(fs.readFileSync(logPath, "utf-8"), /msg="mesh down" node=web actor=actor-web/);
  });

  it("journals send, inbound, and misroute as metadata only — never the handoff body", async () => {
    const logPath = meshLogPath("flow");
    const delivered: XferNotifyMessage[] = [];
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(fresh()), delivered, logPath);
    await node.up("web");
    await node.send("phone", { summary: "s", document: "SECRET-BODY" });
    const inbound = node as unknown as { onHandoff(m: MeshHandoffMessage, selfKey: string): void };
    inbound.onHandoff({ id: "mid-1", from: "grok", to: "web", summary: "s", document: "SECRET-BODY" }, "web");
    inbound.onHandoff({ id: "mid-2", from: "grok", to: "phone", summary: "s", document: "SECRET-BODY" }, "web");
    const log = fs.readFileSync(logPath, "utf-8");
    assert.match(log, /msg="mesh send" from=web to=phone id=\S+ bytes=11/);
    assert.match(log, /msg="mesh inbound" id=mid-1 from=grok to=web bytes=11/);
    assert.match(log, /msg="mesh misroute" id=mid-2 from=grok to=phone reached=web/);
    assert.ok(!log.includes("SECRET-BODY"), "handoff bodies stay out of the log");
    fs.rmSync(path.join(os.tmpdir(), "pi-xfer-mid-1.md"), { force: true });
  });
});
