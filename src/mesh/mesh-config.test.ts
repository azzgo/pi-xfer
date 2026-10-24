import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { MeshNode, loadMeshRuntimeBundle, MESH_RUNTIME_BUNDLE } from "./mesh.ts";
import {
  parseMeshConfig,
  resolveMeshConfig,
  runTokenCommand,
  serializeMeshKey,
  deserializeMeshKey,
  XFER_INSTANCE_ACTOR,
} from "./mesh-config.ts";
import {
  ACTOR_READY_TIMEOUT_CODE,
  NO_ENVOYS_ERROR,
  PREFLIGHT_TIMEOUT_MS,
  MeshPreflightError,
  MeshSendError,
  applyDescriptionAction,
  classifyMeshSendFailure,
  createRivetEngine,
  destroyMeshNode,
  deriveActorStatus,
  deriveMeshNodeState,
  ensureRunnerPool,
  listMeshNodes,
  listMeshState,
  meshListing,
  meshPoolName,
  meshPreflightVerdict,
  meshSendFailureText,
  normalizeNodeDescription,
  preflightMeshSend,
  readDescriptionAction,
  sendMeshHandoff,
  type MeshEngine,
  type MeshHandoffMessage,
  type MeshNodeInfo,
  type MeshPreflight,
  type MeshRunnerInfo,
  type RivetEngineDeps,
  type XferInstanceState,
} from "./mesh-engine.ts";
import { MeshRemoteBlockedError } from "./mesh-guard.ts";
import type { MeshLogSink } from "./mesh-log.ts";
import type { XferNotifyMessage } from "../core/types.ts";

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
  /** Live runners the fake engine reports; `null` = `/envoys` did not answer. */
  envoys?: MeshRunnerInfo[] | null;
  preflighted: string[];
  preflightBlocked: string[];
  /** Targets that reached the enqueue, in order — one entry per send attempt. */
  queued: string[];
  /** Error the enqueue rejects with; absent = the enqueue succeeds. */
  enqueueFailure?: unknown;
}

function fakeState(): FakeEngineState {
  return { nodes: [], ensured: [], stopped: 0, destroyed: [], sent: [], descriptions: {}, unreachable: [], preflighted: [], preflightBlocked: [], queued: [] };
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
    async state() { return meshListing(state.nodes, state.envoys); },
    async preflight(target) {
      state.preflighted.push(target);
      const node = state.nodes.find((candidate) => candidate.name === target);
      if (!node) {
        state.preflightBlocked.push(target);
        throw new MeshPreflightError(target, "(none)", `mesh: no mesh node named "${target}" on the engine. Nothing was sent`);
      }
      const view = deriveMeshNodeState(node, state.envoys);
      const verdict = meshPreflightVerdict(view, node);
      if (verdict.blocked) {
        state.preflightBlocked.push(target);
        throw new MeshPreflightError(target, meshPoolName(node.pool), `${verdict.blocked}. Nothing was sent`);
      }
      return { target, state: view, pool: meshPoolName(node.pool), warning: verdict.warning };
    },
    async destroyNode(actorId) {
      state.destroyed.push(actorId);
      state.nodes = state.nodes.filter((n) => n.actorId !== actorId);
    },
    queueSend: (async (target: string, message: MeshHandoffMessage, verified?: MeshPreflight | null) => {
      state.queued.push(target);
      if (!verified) await fakeEngine(state).preflight(target);
      if (state.enqueueFailure !== undefined) throw state.enqueueFailure;
      state.sent.push({ target, message });
    }) as MeshEngine["queueSend"],
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

  it("refuses URL auth and hands back the migrated shape", () => {
    // The old form looks valid, so the message has to carry the whole fix.
    assert.throws(
      () => parseMeshConfig({ endpoint: "http://default:sk_abc@engine.example.com:6420/", pool: "laptop" }),
      (err: any) =>
        /no longer supported/.test(err.message) &&
        /"endpoint": "http:\/\/engine\.example\.com:6420\/"/.test(err.message) &&
        /"namespace": "default"/.test(err.message) &&
        /"pool": "laptop"/.test(err.message) &&
        /\$MESH_TOKEN/.test(err.message) &&
        /!pass show mesh-token/.test(err.message),
    );
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

  it("refuses URL auth even when the explicit fields are also present", () => {
    assert.throws(
      () => parseMeshConfig({ endpoint: "https://ns:token@example.com:6420", namespace: "ns", token: "token" }),
      /no longer supported/,
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

describe("mesh config: values that are not literals (pi models.json semantics)", () => {
  const base = { endpoint: "http://localhost:6420" };
  const env = { MESH_TOKEN: "from-env", NS: "prod", PART_A: "ab", PART_B: "cd" } as Record<string, string | undefined>;

  it("leaves a literal token alone and resolves nothing", async () => {
    const config = parseMeshConfig({ ...base, token: "sk_plain" });
    assert.equal(config.token, "sk_plain");
    assert.equal("tokenExpression" in config, false);
    assert.equal(await resolveMeshConfig(config), config, "the literal path costs nothing and spawns nothing");
  });

  it("records interpolation as an expression instead of evaluating it at parse time", () => {
    const config = parseMeshConfig({ ...base, token: "${MESH_TOKEN}" });
    assert.equal("token" in config, false, "parsing must not read the environment — that would run at load");
    assert.equal(config.tokenExpression, "${MESH_TOKEN}");
  });

  it("expands $NAME and ${NAME} the way pi does", async () => {
    for (const written of ["$MESH_TOKEN", "${MESH_TOKEN}"]) {
      const resolved = await resolveMeshConfig(parseMeshConfig({ ...base, token: written }), { env });
      assert.equal(resolved.token, "from-env", `${written} must interpolate`);
    }
  });

  it("concatenates literals around a reference, as pi's template does", async () => {
    const resolved = await resolveMeshConfig(parseMeshConfig({ ...base, token: "sk_${PART_A}${PART_B}" }), { env });
    assert.equal(resolved.token, "sk_abcd");
  });

  it("unescapes $$ and $! exactly as pi does", async () => {
    // pi unescapes even with nothing to interpolate, so the two agree byte for byte.
    assert.equal((await resolveMeshConfig(parseMeshConfig({ ...base, token: "$$literal" }), { env })).token, "$literal");
    assert.equal((await resolveMeshConfig(parseMeshConfig({ ...base, token: "$!bang" }), { env })).token, "!bang");
    assert.equal((await resolveMeshConfig(parseMeshConfig({ ...base, token: "$$${PART_A}" }), { env })).token, "$ab");
  });

  it("names the missing variable rather than sending an empty token", async () => {
    await assert.rejects(
      () => resolveMeshConfig(parseMeshConfig({ ...base, token: "$NOT_SET_ANYWHERE" }), { env }),
      (err: any) => /\$NOT_SET_ANYWHERE/.test(err.message) && /not set/.test(err.message) && /!pass show/.test(err.message),
    );
  });

  it("runs a !command through a shell, exactly as pi does, and trims it", async () => {
    const resolved = await resolveMeshConfig(parseMeshConfig({ ...base, token: "!printf 'secret-token\\n'" }), { env });
    assert.equal(resolved.token, "secret-token", "a trailing newline must not travel into the Authorization header");
  });

  it("gives !command the shell's quoting and pipelines, because pi's does", async () => {
    const resolved = await resolveMeshConfig(parseMeshConfig({ ...base, token: '!printf "%s-%s" "${PART_A}" "${PART_B}"' }), { env });
    assert.equal(resolved.token, "ab-cd");
  });

  it("re-resolves a command on every call instead of caching it", async () => {
    // pi runs model-config commands per request and promises no caching; a rotated
    // token must be picked up rather than frozen for the session.
    const config = parseMeshConfig({ ...base, token: '!date +%s%N' });
    const first = await resolveMeshConfig(config);
    const second = await resolveMeshConfig(config);
    assert.notEqual(first.token, second.token);
  });

  it("reports a command that fails, with its exit code and own stderr", async () => {
    await assert.rejects(
      () => resolveMeshConfig(parseMeshConfig({ ...base, token: "!echo 'vault is sealed' >&2; exit 3" })),
      (err: any) => /exit code 3/.test(err.message) && /vault is sealed/.test(err.message),
    );
  });

  it("reports an empty command output rather than passing a blank token", async () => {
    await assert.rejects(
      () => resolveMeshConfig(parseMeshConfig({ ...base, token: "!printf '  \\n'" })),
      /produced an empty token/,
    );
  });

  it("runs a !command in the caller's cwd, and says so in the error when that breaks it", async () => {
    // The bug this pins: one config, two repositories, two answers — a relative
    // path inside the command resolves against wherever pi happens to be running.
    // That stays the semantics (it is the shell's), but it must never be silent.
    const withScript = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-cwd-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-cwd-other-"));
    try {
      fs.writeFileSync(path.join(withScript, "get-token.sh"), "printf relative-token\n", { mode: 0o755 });
      const config = parseMeshConfig({ ...base, token: "!./get-token.sh" });

      const fromHere = await resolveMeshConfig(config, { cwd: withScript });
      assert.equal(fromHere.token, "relative-token", "the command runs in the cwd it was given");

      await assert.rejects(
        () => resolveMeshConfig(config, { cwd: elsewhere }),
        (err: any) =>
          /mesh config "token"/.test(err.message) &&
          /!\.\/get-token\.sh/.test(err.message) &&
          err.message.includes(elsewhere) &&
          /absolute path or \$HOME/.test(err.message),
        "a cwd-dependent failure must name the command, the cwd, and the remedy",
      );
    } finally {
      fs.rmSync(withScript, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reports the cwd even when the command fails for a reason unrelated to paths", async () => {
    await assert.rejects(
      () => runTokenCommand("exit 7", 5_000, process.env as Record<string, string | undefined>, "/tmp"),
      (err: any) => /exit code 7/.test(err.message) && /cwd "\/tmp"/.test(err.message),
    );
  });

  it("names the cwd and the stderr when a command exits 0 with no stdout", async () => {
    await assert.rejects(
      () => runTokenCommand("echo 'wrong vault' >&2; true", 5_000, process.env as Record<string, string | undefined>, "/tmp"),
      (err: any) =>
        /produced an empty token/.test(err.message) &&
        /wrong vault/.test(err.message) &&
        /cwd "\/tmp"/.test(err.message),
    );
  });

  it("kills a command that overruns its budget", async () => {
    // The timeout is injected: waiting out the real 10 s would make this a stall.
    await assert.rejects(
      () => resolveMeshConfig(parseMeshConfig({ ...base, token: "!sleep 30" }), { timeoutMs: 150 }),
      /did not finish within 150 ms/,
    );
  });

  it("interpolates a namespace but refuses to run a command for one", async () => {
    const resolved = await resolveMeshConfig(parseMeshConfig({ ...base, namespace: "$NS" }), { env });
    assert.equal(resolved.namespace, "prod");
    assert.throws(() => parseMeshConfig({ ...base, namespace: "!echo ns" }), /takes a literal or \$ENV_VAR/);
  });

  it("rejects a token that is neither a string nor usable", () => {
    assert.throws(() => parseMeshConfig({ ...base, token: 42 }), /mesh config/);
  });

  it("never interpolates the endpoint", () => {
    const config = parseMeshConfig({ ...base, token: "$MESH_TOKEN" });
    assert.equal(config.endpoint, "http://localhost:6420", "a URL is not a template");
  });
});

describe("mesh config schema", () => {
  const schemaPath = path.join(import.meta.dirname, "mesh.config.schema.json");
  const readSchema = () => JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

  it("ignores a $schema key, so an editor hint cannot break a config", async () => {
    // Every user of the schema puts this key in the file; parsing must shrug.
    const config = parseMeshConfig({
      $schema: "https://raw.githubusercontent.com/azzgo/pi-xfer/main/mesh.config.schema.json",
      endpoint: "http://localhost:6420",
      namespace: "default",
      token: "!echo the-real-token",
      pool: "laptop",
    });
    assert.equal("$schema" in config, false, "an editor hint must not become config state");
    assert.equal(config.endpoint, "http://localhost:6420");
    assert.equal(config.tokenExpression, "!echo the-real-token");
    // And it still evaluates: a command token survives the extra key untouched.
    assert.equal((await resolveMeshConfig(config, { env: {} })).token, "the-real-token");
  });

  it("is a valid draft 2020-12 schema describing exactly the fields the parser accepts", () => {
    const schema = readSchema();
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.deepEqual(schema.required, ["endpoint"]);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ["$schema", "endpoint", "namespace", "pool", "token"],
    );
    for (const field of ["$schema", "endpoint", "namespace", "token", "pool"]) {
      assert.equal(schema.properties[field].type, "string", `${field} is a string in the parser too`);
    }
  });

  it("allows $schema under additionalProperties: false", () => {
    // The schema forbids unknown keys; if it forgot $schema, pointing a config at
    // it would produce a validation error on the very key that enabled completion.
    const schema = readSchema();
    assert.equal(schema.additionalProperties, false);
    assert.ok("$schema" in schema.properties, "$schema must be explicitly allowed");
  });

  it("parses the parser's whole surface, so schema and code cannot drift apart", async () => {
    const schema = readSchema();
    const config = parseMeshConfig({
      $schema: schema.$id,
      endpoint: "http://localhost:6420",
      namespace: "default",
      token: "sk_literal",
      pool: "laptop",
    });
    for (const key of Object.keys(config)) {
      assert.ok(
        key in schema.properties || ["tokenExpression", "namespaceExpression"].includes(key),
        `parser produced "${key}", which the schema does not describe`,
      );
    }
  });

  it("stays out of the npm package (a repository asset, not a runtime file)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../..", "package.json"), "utf-8"));
    assert.equal(pkg.files.includes("mesh.config.schema.json"), false);
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
    const stub = stubDelivery("phone", [{ pool_name: "host-b", envoy_key: "e1", last_ping_ts: 9 }]);
    try {
      await engine.queueSend("phone", handoff);
    } finally { stub.restore(); }
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
  const fresh = fakeState;

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

  it("reads a runner-less actor as Idle, not Crashed", () => {
    assert.equal(deriveActorStatus({ error: NO_ENVOYS_ERROR, sleep_ts: 5 }), "Idle");
    assert.equal(deriveActorStatus({ error: { message: NO_ENVOYS_ERROR } }), "Idle");
    assert.equal(deriveActorStatus({ connectable_ts: 1, error: NO_ENVOYS_ERROR }), "Idle");
  });

  it("still calls a real engine error a crash", () => {
    assert.equal(deriveActorStatus({ error: "runner crashed" }), "Crashed");
    assert.equal(deriveActorStatus({ error: { message: "runner crashed" } }), "Crashed");
    assert.equal(deriveActorStatus({ error: "no_envoy" }), "Crashed", "no near-miss matches the engine's exact code");
    assert.equal(deriveActorStatus({ error: { message: `${NO_ENVOYS_ERROR}: pool gone`, code: 500 } }), "Crashed");
  });

  it("keeps destroy ahead of the runner-less reading", () => {
    assert.equal(deriveActorStatus({ destroy_ts: 9, error: NO_ENVOYS_ERROR }), "Destroyed");
  });
});

interface EngineActorRow {
  actor_id: string;
  key: string;
  runner_name_selector?: string | null;
  [field: string]: unknown;
}

interface EngineEnvoyRow {
  pool_name: string;
  envoy_key?: string;
  last_ping_ts?: number;
  stop_ts?: number | null;
}

/** Stub the engine REST surface both the listing and the pre-send check read. */
function stubEngineRest(
  actors: EngineActorRow[],
  envoys: EngineEnvoyRow[] | { fail: string },
  options: { actorsFail?: string; delayMs?: number } = {},
) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (url.pathname === "/actors") {
      if (options.actorsFail) throw new Error(options.actorsFail);
      return new Response(JSON.stringify({ actors }), { status: 200 });
    }
    if (url.pathname === "/envoys") {
      if ("fail" in envoys) throw new Error(envoys.fail);
      return new Response(JSON.stringify({ envoys, pagination: {} }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Actors + envoys for one send target: "phone" asleep in pool "host-b". */
function stubDelivery(target: string, envoys: EngineEnvoyRow[], pool = "host-b") {
  return stubEngineRest(
    [{ actor_id: "a1", key: serializeMeshKey([target]), runner_name_selector: pool, sleep_ts: 5 }],
    envoys,
  );
}

describe("mesh node listing", () => {
  interface ActorRow {
    actor_id: string;
    key: string;
    runner_name_selector?: string | null;
    [field: string]: unknown;
  }

  function stubActors(rows: ActorRow[]) {
    const calls: Array<{ method: string; url: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", url: url.pathname + url.search });
      return new Response(JSON.stringify({ actors: rows }), { status: 200 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  const config = { endpoint: "http://localhost:6420" };

  it("carries each actor's pool through, so the listing can be joined with /envoys", async () => {
    const stub = stubActors([
      { actor_id: "a1", key: serializeMeshKey(["laptop"]), runner_name_selector: "host-a" },
      { actor_id: "a2", key: serializeMeshKey(["phone"]) },
    ]);
    try {
      const nodes = await listMeshNodes(config);
      assert.deepEqual(nodes, [
        { name: "laptop", actorId: "a1", status: "Pending", pool: "host-a" },
        { name: "phone", actorId: "a2", status: "Pending" },
      ]);
      assert.equal("pool" in nodes[1]!, false, "an unpooled actor stays field-absent (default pool)");
    } finally { stub.restore(); }
  });

  it("maps the live states off the same raw fields, and drops destroyed actors", async () => {
    const stub = stubActors([
      { actor_id: "a1", key: serializeMeshKey(["running"]), connectable_ts: 1, start_ts: 1 },
      { actor_id: "a2", key: serializeMeshKey(["asleep"]), sleep_ts: 5 },
      { actor_id: "a3", key: serializeMeshKey(["idle"]), error: NO_ENVOYS_ERROR, sleep_ts: 5, runner_name_selector: "host-b" },
      { actor_id: "a4", key: serializeMeshKey(["broken"]), error: { message: "boom" } },
      { actor_id: "a5", key: serializeMeshKey(["gone"]), destroy_ts: 9 },
    ]);
    try {
      const nodes = await listMeshNodes(config);
      assert.deepEqual(nodes.map((n) => [n.name, n.status, n.pool ?? null]), [
        ["running", "Running", null],
        ["asleep", "Sleeping", null],
        ["idle", "Idle", "host-b"],
        ["broken", "Crashed", null],
      ]);
      assert.equal(stub.calls[0]?.url, `/actors?name=${encodeURIComponent(XFER_INSTANCE_ACTOR)}`);
    } finally { stub.restore(); }
  });

  it("MeshNode.list() reports the same pool as the observing listing", async () => {
    const stub = stubActors([{ actor_id: "a1", key: serializeMeshKey(["laptop"]), runner_name_selector: "host-a", sleep_ts: 1 }]);
    try {
      const engine = createRivetEngine(config, () => {});
      assert.deepEqual(await engine.listNodes(), await listMeshNodes(config));
      assert.deepEqual(await engine.listNodes(), [{ name: "laptop", actorId: "a1", status: "Sleeping", pool: "host-a" }]);
    } finally { stub.restore(); }
  });
});

describe("mesh node destruction", () => {
  const config = { endpoint: "http://localhost:6420" };

  /**
   * Destroying the actor is the only way to release a name on the engine. A
   * host whose daemon died leaves its actor behind, and the next `up` is then
   * refused with "already Running elsewhere" — a failure that reads like
   * another machine stole the name.
   */
  it("DELETEs the actor by id", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await destroyMeshNode(config, "actor-7");
      assert.deepEqual(calls, ["DELETE /actors/actor-7"]);
    } finally { globalThis.fetch = original; }
  });

  it("fails loudly when the engine refuses the destroy", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 409 })) as typeof fetch;
    try {
      await assert.rejects(() => destroyMeshNode(config, "actor-7"), /409/);
    } finally { globalThis.fetch = original; }
  });
});

describe("mesh node lifecycle", () => {
  it("up connects under the given name after a conflict check", async () => {
    const state: FakeEngineState = fakeState();
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
    const node = makeNode(path.join(tmpDir, "does-not-exist.config.json"), fakeEngine(fakeState()));
    await assert.rejects(() => node.up("web"), /mesh not configured/);
  });

  it("up awaits an async engineFactory (default bundle-loading path)", async () => {
    const state: FakeEngineState = fakeState();
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
    const state: FakeEngineState = fakeState();
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await assert.rejects(() => node.up("web"), /already online/);
  });

  it("down destroys this node's actor and stops the engine exactly once", async () => {
    const state: FakeEngineState = fakeState();
    const engine = fakeEngine(state);
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine);
    await node.up("web");
    await node.down();
    assert.deepEqual(state.destroyed, ["actor-web"]);
    assert.equal(state.stopped, 1);
    assert.deepEqual(node.status(), { online: false });
  });

  it("down stops the engine even when the destroy query fails", async () => {
    const state: FakeEngineState = fakeState();
    const engine = fakeEngine(state);
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), engine);
    await node.up("web");
    engine.listNodes = async () => { throw new Error("engine gone"); };
    await assert.rejects(() => node.down(), /engine gone/);
    assert.equal(state.stopped, 1);
    assert.deepEqual(node.status(), { online: false });
  });
});

describe("mesh send failure triage", () => {
  const message: MeshHandoffMessage = { id: "mvbsq4ja-5dnpgd", from: "web", to: "phone", summary: "s", document: "d" };

  /** An engine 503 as rivetkit surfaces it: the code rides in the message, sometimes in `code`. */
  function actorReadyTimeout(): Error {
    return new Error("guard.actor_ready_timeout: actor did not become ready within 30000ms");
  }

  /** What `AbortSignal.timeout` produces when the client's own wait expires. */
  function clientWaitExpired(): Error {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    return err;
  }

  it("reads the engine code, not the elapsed time: actor_ready_timeout is not delivered", () => {
    const triage = classifyMeshSendFailure(actorReadyTimeout());
    assert.equal(triage.kind, "not-delivered");
    assert.equal(triage.code, ACTOR_READY_TIMEOUT_CODE);
    assert.match(triage.detail, /actor did not become ready/);
  });

  it("reads the code off a structured rivetkit error and off its cause", () => {
    assert.equal(classifyMeshSendFailure({ code: ACTOR_READY_TIMEOUT_CODE, message: "not ready" }).kind, "not-delivered");
    assert.equal(classifyMeshSendFailure({ data: { code: ACTOR_READY_TIMEOUT_CODE } }).kind, "not-delivered");
    const wrapped = new Error("request failed");
    wrapped.cause = actorReadyTimeout();
    assert.equal(classifyMeshSendFailure(wrapped).kind, "not-delivered");
  });

  it("treats a client wait that expired as unknown — the engine never said it was refused", () => {
    assert.equal(classifyMeshSendFailure(clientWaitExpired()).kind, "unknown");
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(classifyMeshSendFailure(abort).kind, "unknown");
    assert.equal(classifyMeshSendFailure(new Error("timed out after 30000ms")).kind, "unknown");
  });

  it("leaves every other error an ordinary failure, reported as it came", () => {
    const triage = classifyMeshSendFailure(new Error("connect ECONNREFUSED 127.0.0.1:6420"));
    assert.equal(triage.kind, "failed");
    assert.equal(triage.detail, "connect ECONNREFUSED 127.0.0.1:6420");
    assert.equal(classifyMeshSendFailure("plain string failure").kind, "failed");
    assert.equal(classifyMeshSendFailure(undefined).kind, "failed");
  });

  it("never says 'not delivered' or 'retry' about an unknown outcome, and names it unknown", () => {
    const err = new MeshSendError("phone", message, classifyMeshSendFailure(clientWaitExpired()));
    assert.equal(err.kind, "unknown");
    assert.equal(err.handoffId, message.id);
    assert.match(err.message, /UNKNOWN/);
    assert.match(err.message, /may have accepted it and may still deliver it/);
    assert.doesNotMatch(err.message, /not delivered|nothing was sent|retry/i);
    assert.match(err.recovery, /recovery probe/);
    assert.match(err.recovery, /not a fix/);
  });

  it("says nothing was sent only when the engine refused the enqueue", () => {
    const err = new MeshSendError("phone", message, classifyMeshSendFailure(actorReadyTimeout()));
    assert.match(err.message, /no runner is serving the target's pool/);
    assert.match(err.message, /never entered its queue and nothing was sent/);
    assert.doesNotMatch(err.message, /retry when the engine|target may be offline or stuck/);
  });

  it("reuses the original handoff id wherever a resend is named", () => {
    for (const err of [
      new MeshSendError("phone", message, classifyMeshSendFailure(clientWaitExpired())),
      new MeshSendError("phone", message, classifyMeshSendFailure(actorReadyTimeout())),
      new MeshSendError("phone", message, classifyMeshSendFailure(new Error("boom"))),
    ]) {
      assert.match(err.recovery, new RegExp(`id ${message.id}`));
      assert.match(err.recovery, /probe|duplicate/, `"${err.kind}" explains why the id is reused`);
    }
  });

  it("is a plain Error carrying its own verdict, so a caller can rethrow it without rewording", () => {
    const err = new MeshSendError("phone", message, classifyMeshSendFailure(clientWaitExpired()));
    assert.ok(err instanceof Error);
    assert.equal(err.name, "MeshSendError");
    assert.ok(!/failed to send/i.test(err.message), "the message is the whole verdict, not a fragment to re-prefix");
  });
  /** A connected engine whose enqueue rejects with the given failure. */
  async function engineWithFailingEnqueue(err: unknown): Promise<MeshEngine> {
    const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, () => {}, {
      ensureRuntimeReady: async () => {},
      importRivetkit: async () => ({
        actor: (definition: unknown) => ({ definition }),
        queue: () => ({}),
        setup: () => ({ startAndWait: async () => {}, shutdown: async () => {} }),
      }),
      importClient: async () => ({
        createClient: () => ({
          getOrCreate: () => ({ resolve: async () => {} }),
          get: () => ({ send: async () => { throw err; }, action: async () => "" }),
        }),
      }),
    });
    await engine.ensureNode("web");
    return engine;
  }

  it("triages what queueSend throws: the engine's code classes the enqueue", async () => {
    const verified: MeshPreflight = { target: "phone", state: "Sleeping", pool: "host-b", warning: null };
    const refused = await engineWithFailingEnqueue(actorReadyTimeout());
    await assert.rejects(
      () => refused.queueSend("phone", message, verified),
      (err: any) => err instanceof MeshSendError && err.kind === "not-delivered" && /nothing was sent/.test(err.message),
    );
    const expired = await engineWithFailingEnqueue(clientWaitExpired());
    await assert.rejects(
      () => expired.queueSend("phone", message, verified),
      (err: any) =>
        err instanceof MeshSendError &&
        err.kind === "unknown" &&
        /UNKNOWN/.test(err.message) &&
        !/not delivered|nothing was sent|retry/i.test(err.message),
    );
  });

  it("the daemon's one-shot send triages with the same function, since both sites funnel into it", () => {
    const failure = classifyMeshSendFailure(actorReadyTimeout());
    assert.equal(new MeshSendError("phone", message, failure).message, `mesh: ${meshSendFailureText("phone", message, failure)}`);
    assert.equal(classifyMeshSendFailure(clientWaitExpired()).kind, "unknown");
  });

  it("records the verdict in the mesh log, so an error line is diagnosable later", async () => {
    const logPath = meshLogPath("triage");
    const state: FakeEngineState = {
      ...fakeState(),
      nodes: [{ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" }],
      envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }],
      enqueueFailure: actorReadyTimeout(),
    };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state), [], logPath);
    await node.up("web");
    await assert.rejects(() => node.send("phone", { summary: "s", document: "d" }), /guard\.actor_ready_timeout/);
    const log = fs.readFileSync(logPath, "utf-8");
    assert.match(log, /msg="mesh send failed".*verdict=not-delivered/);
    assert.match(log, new RegExp(`code=${ACTOR_READY_TIMEOUT_CODE}`));
    assert.ok(!log.includes('msg="mesh send"'), "a failed send is not recorded as a success");
  });
});
describe("mesh messaging", () => {
  it("send enqueues the full inline payload with id/from/summary/document", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
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
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(fakeState()));
    await assert.rejects(() => node.send("phone", { summary: "s", document: "d" }), /not online/);
  });

  it("re-sends under the original id, so a recovery probe cannot read as a new handoff", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    const first = await node.send("phone", { summary: "s", document: "d" });
    const probe = await node.send("phone", { summary: "s", document: "d" }, first.id);
    assert.equal(probe.id, first.id, "the probe carries the id the receiver deduplicates on");
    assert.deepEqual(state.sent.map((s) => s.message.id), [first.id, first.id]);
    const fresh = await node.send("phone", { summary: "s", document: "d" });
    assert.notEqual(fresh.id, first.id, "an unrelated send still mints its own id");
  });

  it("refuses a send whose target's pool has no runner, and never enqueues it", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Idle", pool: "host-b" }], envoys: [] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await assert.rejects(
      () => node.send("phone", { summary: "s", document: "d" }),
      (err: any) => err instanceof MeshPreflightError && /no runner in pool "host-b"/.test(err.message),
    );
    assert.deepEqual(state.sent, [], "a refused send never reaches the queue");
    assert.deepEqual(state.preflightBlocked, ["phone"]);
  });

  it("sends with a warning when the actor record and the pool's runners disagree", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Idle", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    const { warning } = await node.send("phone", { summary: "s", document: "d" });
    assert.match(warning ?? "", /reads idle \(no runner\) in its actor record while pool "host-b" does hold a live runner/);
    assert.equal(state.sent.length, 1, "engine truth wins — the send goes through");
  });

  it("sends without a warning when the target's pool has a live runner", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    assert.equal((await node.send("phone", { summary: "s", document: "d" })).warning, null);
  });

  it("runs exactly one pre-send check per send, not one per layer", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    await node.send("phone", { summary: "s", document: "d" });
    assert.deepEqual(state.preflighted, ["phone"], "one engine round, however many layers ask");
    assert.deepEqual(state.queued, ["phone"]);
    assert.equal(state.sent.length, 1);
  });

  it("still checks exactly once on the warning path", async () => {
    const state: FakeEngineState = { ...fakeState(), nodes: [{ name: "phone", actorId: "a1", status: "Idle", pool: "host-b" }], envoys: [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }] };
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state));
    await node.up("web");
    const { warning } = await node.send("phone", { summary: "s", document: "d" });
    assert.match(warning ?? "", /does hold a live runner/);
    assert.deepEqual(state.preflighted, ["phone"], "the warning comes from that same round");
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
    const engine = fakeEngine(fakeState());
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
      fakeEngine(fakeState()),
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
      fakeEngine(fakeState()),
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
    assert.ok(fs.existsSync(path.join(import.meta.dirname, "../..", MESH_RUNTIME_BUNDLE)));
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
  const fresh = fakeState;

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
    const state = fresh();
    state.nodes.push({ name: "phone", actorId: "a1", status: "Sleeping", pool: "host-b" });
    state.envoys = [{ pool: "host-b", envoyKey: "e1", lastPingTs: 1 }];
    const node = makeNode(writeConfig({ endpoint: "http://localhost:6420" }), fakeEngine(state), delivered, logPath);
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

describe("mesh pre-send check", () => {
  const config = { endpoint: "http://localhost:6420" };

  it("reads the two engine facts in one round and joins them per node", async () => {
    const stub = stubEngineRest(
      [
        { actor_id: "a1", key: serializeMeshKey(["running"]), runner_name_selector: "host-a", connectable_ts: 1 },
        { actor_id: "a2", key: serializeMeshKey(["idle"]), runner_name_selector: "host-b", error: NO_ENVOYS_ERROR, sleep_ts: 5 },
        { actor_id: "a3", key: serializeMeshKey(["defaulted"]), sleep_ts: 5 },
      ],
      [{ pool_name: "host-a", envoy_key: "e1" }, { pool_name: "default", envoy_key: "e2" }],
    );
    try {
      const listing = await listMeshState(config);
      assert.deepEqual(stub.calls.sort(), ["/actors", "/envoys"]);
      assert.deepEqual(listing.nodes.map((n) => deriveMeshNodeState(n, listing.envoys)), [
        "Running",
        "NoRunner",
        "Sleeping",
      ]);
      assert.deepEqual(listing.envoys?.map((e) => e.pool), ["host-a", "default"]);
    } finally { stub.restore(); }
  });

  it("ignores a stopped runner — a stopped envoy is not a live one", async () => {
    const stub = stubEngineRest(
      [{ actor_id: "a1", key: serializeMeshKey(["phone"]), runner_name_selector: "host-b", sleep_ts: 5 }],
      [{ pool_name: "host-b", envoy_key: "gone", stop_ts: 7 }],
    );
    try {
      const listing = await listMeshState(config);
      assert.deepEqual(listing.envoys, []);
      assert.equal(deriveMeshNodeState(listing.nodes[0]!, listing.envoys), "NoRunner");
    } finally { stub.restore(); }
  });

  it("treats a missing /envoys answer as unknown, not as an absence of nodes", async () => {
    const stub = stubEngineRest(
      [{ actor_id: "a1", key: serializeMeshKey(["phone"]), runner_name_selector: "host-b", sleep_ts: 5 }],
      { fail: "envoys 500" },
    );
    try {
      const listing = await listMeshState(config);
      assert.equal(listing.envoys, null);
      assert.equal(listing.nodes.length, 1, "the actor listing still renders");
      assert.equal(deriveMeshNodeState(listing.nodes[0]!, listing.envoys), "Unknown");
      await assert.rejects(
        () => preflightMeshSend(config, "phone"),
        (err: any) => err instanceof MeshPreflightError && /did not answer \/envoys/.test(err.message),
      );
    } finally { stub.restore(); }
  });

  it("refuses when the target's pool holds no runner, naming the pool", async () => {
    const stub = stubEngineRest(
      [
        { actor_id: "a1", key: serializeMeshKey(["phone"]), runner_name_selector: "host-b", error: NO_ENVOYS_ERROR, sleep_ts: 5 },
        { actor_id: "a2", key: serializeMeshKey(["laptop"]), runner_name_selector: "host-a", sleep_ts: 5 },
      ],
      [{ pool_name: "host-a", envoy_key: "e1" }],
    );
    try {
      await assert.rejects(
        () => preflightMeshSend(config, "phone"),
        (err: any) =>
          err instanceof MeshPreflightError &&
          err.pool === "host-b" &&
          /"phone" is online but cannot receive: no runner in pool "host-b"/.test(err.message) &&
          /start a runner for pool "host-b" on that machine/.test(err.message) &&
          /Nothing was sent/.test(err.message),
      );
      const allowed = await preflightMeshSend(config, "laptop");
      assert.deepEqual(allowed, { target: "laptop", state: "Sleeping", pool: "host-a", warning: null });
    } finally { stub.restore(); }
  });

  it("refuses a target the engine does not list at all", async () => {
    const stub = stubEngineRest([], []);
    try {
      await assert.rejects(
        () => preflightMeshSend(config, "ghost"),
        (err: any) => err instanceof MeshPreflightError && /no mesh node named "ghost"/.test(err.message) && /Nothing was sent/.test(err.message),
      );
    } finally { stub.restore(); }
  });

  it("fails closed on a timeout: nothing is sent rather than waiting out the 30 s enqueue", async () => {
    const stub = stubEngineRest(
      [{ actor_id: "a1", key: serializeMeshKey(["phone"]), runner_name_selector: "host-b", sleep_ts: 5 }],
      [],
      { delayMs: 200 },
    );
    try {
      await assert.rejects(
        () => preflightMeshSend(config, "phone", 20),
        (err: any) =>
          err instanceof MeshPreflightError &&
          /engine did not answer \/actors \+ \/envoys within 20 ms/.test(err.message) &&
          /Nothing was sent; the check is deliberately fail-closed/.test(err.message) &&
          /--no-preflight/.test(err.message),
      );
    } finally { stub.restore(); }
  });

  it("propagates a failed actor listing instead of calling the engine empty", async () => {
    const stub = stubEngineRest([], [], { actorsFail: "connect ECONNREFUSED" });
    try {
      await assert.rejects(() => listMeshState(config), /connect ECONNREFUSED/);
      await assert.rejects(() => preflightMeshSend(config, "phone"), (err: any) => err instanceof MeshPreflightError);
    } finally { stub.restore(); }
  });

  it("defaults to a six-second budget on the delivery hot path", () => {
    assert.equal(PREFLIGHT_TIMEOUT_MS, 6_000);
  });

  it("verdicts name the pool for a runner-less node and warn on a record/pool disagreement", () => {
    assert.match(
      meshPreflightVerdict("NoRunner", { name: "phone", pool: "host-b" }).blocked ?? "",
      /no runner in pool "host-b"/,
    );
    assert.equal(meshPreflightVerdict("NoRunner", { name: "phone" }).warning, null);
    const mismatch = meshPreflightVerdict("Mismatch", { name: "phone", pool: "host-b" });
    assert.equal(mismatch.blocked, null);
    assert.match(mismatch.warning ?? "", /pool "host-b" does hold a live runner/);
    assert.deepEqual(meshPreflightVerdict("Running", { name: "phone", pool: "host-b" }), { blocked: null, warning: null });
  });
});

describe("mesh guard: the real transport paths refuse to leave the machine in a test run", () => {
  const REMOTE = { endpoint: "https://engine.example.com" };
  const save = { context: process.env.NODE_TEST_CONTEXT, allow: process.env.XFER_ALLOW_REMOTE };

  const arm = () => { process.env.NODE_TEST_CONTEXT = "child-v8"; delete process.env.XFER_ALLOW_REMOTE; };
  const disarm = () => {
    if (save.context === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = save.context;
    if (save.allow === undefined) delete process.env.XFER_ALLOW_REMOTE; else process.env.XFER_ALLOW_REMOTE = save.allow;
  };

  it("blocks the REST listing before any fetch happens", async () => {
    arm();
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch;
    try {
      await assert.rejects(() => listMeshNodes(REMOTE), MeshRemoteBlockedError);
      await assert.rejects(() => listMeshState(REMOTE), MeshRemoteBlockedError);
      assert.equal(fetched, 0, "the guard runs before the network, not after");
    } finally { globalThis.fetch = original; disarm(); }
  });

  it("blocks the pre-send check and the one-shot send, so a test cannot enqueue to a deployment", async () => {
    arm();
    try {
      await assert.rejects(() => preflightMeshSend(REMOTE, "phone"), MeshRemoteBlockedError);
      await assert.rejects(
        () => sendMeshHandoff(REMOTE, "phone", { id: "1", from: "web", to: "phone", summary: "s", document: "d" }),
        MeshRemoteBlockedError,
      );
    } finally { disarm(); }
  });

  it("still lets a loopback fixture through, so hermetic tests keep working", async () => {
    arm();
    const stub = stubEngineRest([{ actor_id: "a1", key: serializeMeshKey(["phone"]), sleep_ts: 5 }], []);
    try {
      assert.deepEqual((await listMeshNodes({ endpoint: "http://127.0.0.1:6420" })).map((n) => n.name), ["phone"]);
      assert.deepEqual(stub.calls.sort(), ["/actors"]);
    } finally { stub.restore(); disarm(); }
  });
});
