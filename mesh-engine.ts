import { HANDOFF_QUEUE, XFER_INSTANCE_ACTOR, deserializeMeshKey, type MeshConfig } from "./mesh-config.ts";
import { MeshRemoteBlockedError, assertEndpointReachable, guardMeshConfig } from "./mesh-guard.ts";
import { createMeshLogSink, logMeshEvent, MESH_LOG_PATH, type MeshLogLevel } from "./mesh-log.ts";
import { ensureNativeRuntimeReady } from "./mesh-native.ts";
import { withTimeout } from "./utils.ts";

/** Inline handoff payload carried by the mesh handoff queue. */
export interface MeshHandoffMessage {
  id: string;
  from: string;
  /** Intended recipient node name. Absent on messages from older senders. */
  to?: string;
  summary: string;
  document: string;
}

/** Durable state kept with each node's actor on the engine (survives reconnect). */
export interface XferInstanceState {
  /** Self-declared capability note: what requests this node handles. Absent = "". */
  description: string;
  /** Handoff ids already delivered, oldest first. Absent on actors that never received one. */
  delivered?: string[];
}

/**
 * How many delivered handoff ids the receiver remembers. The durable queue
 * redelivers a message whose runner died after the delivery and before the ack,
 * and a sender's recovery probe reuses the original id — both land next to the
 * window's live edge, so a short window is enough. 3 rather than 10 unless real
 * logs show edge redelivery is common; revisit the bound then, not speculatively.
 */
export const DELIVERED_WINDOW_SIZE = 3;

/** Upper bound on a node description, in characters. */
export const MAX_NODE_DESCRIPTION = 500;

/**
 * RivetKit writes to this process's stdout, which is right for a standalone
 * server and fatal inside a TUI host: every line it emits displaces a pi
 * redraw, so `mesh up` leaves the welcome banner and native SQLite warnings
 * smeared across the screen. Pin the runtime quiet instead.
 *
 * `RIVET_LOG_LEVEL` is the knob that actually works on 2.3.26 — it filters the
 * JS logger *and* the native subscriber (`logging.level` in the setup config is
 * parsed but unused), and it wins over the deprecated `LOG_LEVEL` fallback.
 * A level the host set explicitly is respected, so `RIVET_LOG_LEVEL=debug pi`
 * stays the way to watch mesh logs on purpose.
 */
export function quietMeshRuntime(): void {
  if (!process.env.RIVET_LOG_LEVEL) process.env.RIVET_LOG_LEVEL = "silent";
}

/**
 * Validate + normalize a description on the way into actor state: strings only,
 * trimmed, capped. Returns what is actually stored, so callers can show back
 * exactly what the actor holds.
 */
export function normalizeNodeDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("description must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NODE_DESCRIPTION) {
    throw new Error(`description is limited to ${MAX_NODE_DESCRIPTION} characters (got ${trimmed.length})`);
  }
  return trimmed;
}


/**
 * Action bodies, kept separate so their semantics are testable without an
 * engine: the actor wires them straight onto `c.state` (the write-through
 * proxy the engine persists with the actor).
 */
export async function applyDescriptionAction(state: XferInstanceState, value: unknown): Promise<string> {
  state.description = normalizeNodeDescription(value);
  return state.description;
}

export async function readDescriptionAction(state: XferInstanceState): Promise<string> {
  return state.description ?? "";
}

/**
 * Receiver-side dedupe, decided before the message's document is written: a hit
 * is a redelivery of work already applied and is dropped, a miss is delivered.
 * The window only changes through {@link recordMeshDelivery}, after the
 * delivery, so a crash repeats work instead of losing a handoff.
 */
export function isDuplicateMeshHandoff(state: XferInstanceState, message: Pick<MeshHandoffMessage, "id">): boolean {
  return (state.delivered ?? []).includes(message.id);
}

/** Slide one delivered handoff id into the window, evicting the oldest past the bound. */
export function recordMeshDelivery(state: XferInstanceState, message: Pick<MeshHandoffMessage, "id">): string[] {
  const window = [...(state.delivered ?? []).filter((id) => id !== message.id), message.id];
  state.delivered = window.slice(-DELIVERED_WINDOW_SIZE);
  return state.delivered;
}

/** The one `mesh duplicate` record a dropped redelivery writes. */
export function meshDuplicateLogLine(
  write: (level: MeshLogLevel, message: string, fields: Record<string, unknown>) => void,
  message: Pick<MeshHandoffMessage, "id" | "from">,
  selfKey: string,
): void {
  write("info", "mesh duplicate", { id: message.id, from: message.from, to: selfKey || "(unknown)" });
}

/**
 * Engine-visible lifecycle of one actor, derived from its timestamps.
 * `Destroyed` actors are filtered out of listings, so callers see the
 * adoptable-or-busy states: Running / Sleeping / Idle / Crashed / Pending.
 *
 * `Idle` is an actor that is alive on the engine but has no runner (envoy) in
 * its pool, which the engine reports as `error: "no_envoys"`. It is online but
 * cannot receive a handoff, which is emphatically not a crash.
 */
export type MeshActorStatus = "Running" | "Sleeping" | "Idle" | "Crashed" | "Pending" | "Destroyed";

/** Engine error text for "the actor is alive, but nothing in its pool can run it". */
export const NO_ENVOYS_ERROR = "no_envoys";

function isNoEnvoys(error: unknown): boolean {
  if (typeof error === "string") return error === NO_ENVOYS_ERROR;
  return Boolean(error) && typeof error === "object" && (error as { message?: unknown }).message === NO_ENVOYS_ERROR;
}

/** Derive an actor's lifecycle status from the engine's raw timestamp fields. */
export function deriveActorStatus(actor: {
  destroy_ts?: number | null;
  error?: unknown;
  sleep_ts?: number | null;
  start_ts?: number | null;
  connectable_ts?: number | null;
}): MeshActorStatus {
  if (actor.destroy_ts !== undefined && actor.destroy_ts !== null) return "Destroyed";
  if (isNoEnvoys(actor.error)) return "Idle";
  if (actor.error !== undefined && actor.error !== null) return "Crashed";
  if (actor.sleep_ts !== undefined && actor.sleep_ts !== null) return "Sleeping";
  if (actor.connectable_ts !== undefined && actor.connectable_ts !== null) return "Running";
  return "Pending";
}

/** One mesh node as seen by the engine. */
export interface MeshNodeInfo {
  name: string;
  actorId: string;
  /** Lifecycle state; drives status-aware adoption in `MeshNode.up()`. */
  status: MeshActorStatus;
  /** Runner pool the actor was placed in (engine `runner_name_selector`); "" = default pool. */
  pool?: string;
}

/**
 * Engine-facing surface of the mesh transport. Tests inject a fake; production
 * uses {@link createRivetEngine}, which dynamic-imports rivetkit so the module
 * stays unloaded until the mesh is brought up.
 */
export interface MeshEngine {
  /** Create the node's actor and connect to the engine (registry start). */
  ensureNode(name: string): Promise<void>;
  /** Disconnect the registry from the engine. */
  stop(): Promise<void>;
  /** Live engine query: all nodes for the xfer-instance actor type. */
  listNodes(): Promise<MeshNodeInfo[]>;
  /** Same listing with the runner side (`/envoys`), for delivery-verdict surfaces. */
  state(): Promise<MeshListing>;
  /** Permanently destroy one actor. */
  destroyNode(actorId: string): Promise<void>;
  /**
   * Fire-and-forget enqueue of an inline handoff to the target node.
   *
   * `verified` is a verdict the caller already paid for — passing it is what
   * keeps a send at one engine round. Omitted (or `null`) means the check runs
   * here, so a caller that never checked still cannot enqueue blind.
   */
  queueSend(target: string, message: MeshHandoffMessage, verified?: MeshPreflight | null): Promise<void>;
  /** Pre-send check: rejects with {@link MeshPreflightError} when the target cannot receive. */
  preflight(target: string): Promise<MeshPreflight>;
  /** Set this node's own description; resolves with the stored (normalized) value. */
  setDescription(value: string): Promise<string>;
  /** Read one node's description by name; rejects when the node is unreachable. */
  getDescription(target: string): Promise<string>;
}

/** Bound on queue enqueue so a stuck/unreachable target errors instead of hanging. */
const QUEUE_SEND_TIMEOUT_MS = 30_000;

/**
 * Injection seam for the RivetKit runtime, so pool wiring is unit-testable
 * without the native addon. Production callers omit it; the default thunks keep
 * the literal dynamic imports esbuild bundles.
 */
export interface RivetEngineDeps {
  ensureRuntimeReady?: () => Promise<void>;
  importRivetkit?: () => Promise<any>;
  importClient?: () => Promise<any>;
}

/**
 * Where the mesh log of this engine goes. Only tests set it — production takes
 * the default `<xfer-dir>/mesh.log`, keeping the log hermetic per test process.
 */
export interface RivetEngineOptions {
  logPath?: string;
}

export function createRivetEngine(
  config: MeshConfig,
  onHandoff: (message: MeshHandoffMessage, selfKey: string) => void,
  deps: RivetEngineDeps = {},
  options: RivetEngineOptions = {},
): MeshEngine {
  let registry: { shutdown(): Promise<void> } | null = null;
  let client: any = null;
  let selfHandle: any = null;

  const engine: MeshEngine = {
    async ensureNode(name: string) {
      quietMeshRuntime();
      await (deps.ensureRuntimeReady ?? ensureNativeRuntimeReady)();
      const { actor, queue, setup } = await (deps.importRivetkit ?? (() => import("rivetkit")))();
      const xferInstance = actor({
        // Written through the state proxy, so the note lives with the actor on
        // the engine: it survives node restart/reconnect and stays readable
        // while this node is offline.
        state: { description: "", delivered: [] } satisfies XferInstanceState,
        actions: {
          setDescription: (c, value: unknown) => applyDescriptionAction(c.state, value),
          getDescription: (c) => readDescriptionAction(c.state),
        },
        queues: {
          [HANDOFF_QUEUE]: queue<MeshHandoffMessage>(),
        },
        run: async (c) => {
          const selfKey = c.key[0] ?? "";
          for await (const message of c.queue.iter()) {
            if (isDuplicateMeshHandoff(c.state, message.body)) {
              meshDuplicateLogLine(
                (level, event, fields) => logMeshEvent(options.logPath ?? MESH_LOG_PATH, level, event, fields),
                message.body,
                selfKey,
              );
              continue;
            }
            onHandoff(message.body, selfKey);
            recordMeshDelivery(c.state, message.body);
          }
        },
      });
      const reg = setup({
        use: { [XFER_INSTANCE_ACTOR]: xferInstance },
        endpoint: config.endpoint,
        namespace: config.namespace,
        token: config.token,
        runtime: "native",
        noWelcome: true,
        logging: { baseLogger: createMeshLogSink({ path: options.logPath }) },
        ...(config.pool ? { envoy: { poolName: config.pool } } : {}),
      });
      const regAny = reg as unknown as { startAndWait(): Promise<void>; shutdown(): Promise<void> };
      await regAny.startAndWait();
      registry = regAny;
      const { createClient } = await (deps.importClient ?? (() => import("rivetkit/client")))();
      client = createClient(guardMeshConfig({ endpoint: config.endpoint, namespace: config.namespace, token: config.token }));
      // Pin only OUR actor's creation to our pool. `get`/list stay un-pooled so
      // queueSend and describe still address actors living in other pools.
      selfHandle = config.pool
        ? client.getOrCreate(XFER_INSTANCE_ACTOR, [name], { poolName: config.pool })
        : client.getOrCreate(XFER_INSTANCE_ACTOR, [name]);
      await selfHandle.resolve();
    },

    async stop() {
      if (registry) {
        await registry.shutdown();
        registry = null;
        client = null;
        selfHandle = null;
      }
    },

    async listNodes() {
      return fetchMeshNodes(config);
    },

    async state() {
      return listMeshState(config);
    },

    async destroyNode(actorId: string) {
      await engineApi(config, "DELETE", `/actors/${encodeURIComponent(actorId)}`);
    },

    async preflight(target: string): Promise<MeshPreflight> {
      return preflightMeshSend(config, target);
    },

    async queueSend(target: string, message: MeshHandoffMessage, verified?: MeshPreflight | null) {
      if (!client) throw new Error("mesh is not online — run /xfer mesh up first");
      if (!verified) await preflightMeshSend(config, target);
      const handle = client.get(XFER_INSTANCE_ACTOR, [target]);
      try {
        await handle.send(HANDOFF_QUEUE, message, { signal: AbortSignal.timeout(QUEUE_SEND_TIMEOUT_MS) });
      } catch (err) {
        throw new Error(
          `mesh: enqueue to "${target}" failed — ${err instanceof Error ? err.message : String(err)} ` +
          `(target may be offline or stuck; the durable queue buffers only after the actor is reachable)`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    },
    async setDescription(value: string) {
      if (!client || !selfHandle) throw new Error("mesh is not online — run /xfer mesh up first");
      const stored = await selfHandle.action({ name: "setDescription", args: [value] });
      return typeof stored === "string" ? stored : "";
    },

    async getDescription(target: string) {
      if (!client) throw new Error("mesh is not online — run /xfer mesh up first");
      const description = await client
        .get(XFER_INSTANCE_ACTOR, [target])
        .action({ name: "getDescription", args: [] });
      return typeof description === "string" ? description : "";
    },
  };
  return engine;
}

/**
 * One-shot mesh send without joining: a transient client enqueues directly to
 * the target actor. Used by send-only hosts (the adapter daemon's `mesh send`),
 * which must not need a daemon or a registered node of their own.
 */
export async function sendMeshHandoff(
  config: MeshConfig,
  target: string,
  message: MeshHandoffMessage,
  timeoutMs: number = QUEUE_SEND_TIMEOUT_MS,
  options: { preflight?: boolean } = {},
): Promise<MeshPreflight | null> {
  quietMeshRuntime();
  const preflight = options.preflight === false ? null : await preflightMeshSend(config, target);
  const { createClient } = await import("rivetkit/client");
  const client = createClient(guardMeshConfig({ endpoint: config.endpoint, namespace: config.namespace, token: config.token }));
  const handle = client.get(XFER_INSTANCE_ACTOR, [target]);
  try {
    await handle.send(HANDOFF_QUEUE, message, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(
      `mesh: enqueue to "${target}" failed — ${err instanceof Error ? err.message : String(err)} ` +
      `(target may be offline or stuck; the durable queue buffers only after the actor is reachable)`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
  return preflight;
}

/** Engine REST call (snake_case responses), mirroring rivetkit's internal apiCall. */
async function engineApi<T>(config: MeshConfig, method: string, path: string, body?: unknown): Promise<T> {
  assertEndpointReachable(config.endpoint);
  const url = new URL(path, config.endpoint);
  if (config.namespace) url.searchParams.set("namespace", config.namespace);
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    throw new Error(`mesh engine ${method} ${url.pathname} failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
  return (await response.json()) as T;
}

/**
 * Live engine query without joining: the same REST listing MeshNode.list()
 * uses, for readers that only observe (the admin console) rather than
 * participate as a node.
 */
/**
 * Make sure the configured pool actually has a runner-config on the engine.
 * Without one, actors pinned to the pool queue forever — the node looks online
 * but nothing ever picks it up. Idempotent: an existing config is left as-is.
 * A config without `pool` is a no-op (the engine default runner-config covers it).
 */
export async function ensureRunnerPool(config: MeshConfig): Promise<{ pool: string; existed: boolean }> {
  if (!config.pool) {
    throw new Error('mesh config has no "pool" — nothing to ensure (unset pool uses the engine default runner-config)');
  }
  const pool = config.pool;
  const existing = await engineApi<{ runner_configs: Record<string, unknown> }>(
    config,
    "GET",
    `/runner-configs?runner_name=${encodeURIComponent(pool)}`,
  );
  if (Object.keys(existing.runner_configs ?? {}).includes(pool)) return { pool, existed: true };
  await engineApi(config, "PUT", `/runner-configs/${encodeURIComponent(pool)}`, {
    datacenters: { default: { normal: {} } },
  });
  return { pool, existed: false };
}

export function listMeshNodes(config: MeshConfig): Promise<MeshNodeInfo[]> {
  return fetchMeshNodes(config);
}

/**
 * One node's verdict, from two engine facts rather than one: what the actor
 * record says about the actor, and whether its pool holds a live runner. The
 * record alone cannot be trusted for "can this node receive a handoff" — a
 * runner-less actor keeps reading `no_envoys` after its pool gained a runner,
 * and a `no_envoys` actor may yet be placed. No engine runner data (`envoys` is
 * null) yields `Unknown`; it is never rendered as "offline" or "no nodes".
 */
export type MeshNodeState = "Running" | "Sleeping" | "NoRunner" | "Mismatch" | "Crashed" | "Pending" | "Unknown";

/** One live runner in an engine pool (`GET /envoys`). */
export interface MeshRunnerInfo {
  pool: string;
  envoyKey: string;
  /** Engine clock timestamp — not comparable with a local `Date.now()` delta. */
  lastPingTs: number;
}

export interface MeshListing {
  nodes: MeshNodeInfo[];
  /** Live runners by pool name; `null` = the engine did not answer `/envoys`. */
  envoys: MeshRunnerInfo[] | null;
}

/** Engine pool of an actor/node: an absent selector means the engine's default pool. */
export function meshPoolName(pool: string | undefined): string {
  return pool || "default";
}

/** Join one actor with the runners its pool holds. */
export function deriveMeshNodeState(
  node: Pick<MeshNodeInfo, "status" | "pool">,
  envoys: readonly MeshRunnerInfo[] | null,
): MeshNodeState {
  if (envoys === null) return "Unknown";
  if (node.status === "Destroyed") return "Unknown";
  const live = envoys.some((envoy) => envoy.pool === meshPoolName(node.pool));
  if (node.status === "Idle") return live ? "Mismatch" : "NoRunner";
  if (node.status === "Running" || node.status === "Sleeping" || node.status === "Pending") return live ? node.status : "NoRunner";
  return node.status;
}

/** Engine verdict for a whole listing: one engine round, both facts. */
export function meshListing(
  nodes: MeshNodeInfo[],
  envoys: readonly MeshRunnerInfo[] | null,
): MeshListing {
  return { nodes, envoys: envoys === null ? null : [...envoys] };
}

/** Read both engine facts at once: actor records plus live runners. Either may fail independently. */
export async function listMeshState(config: MeshConfig): Promise<MeshListing> {
  const [nodes, envoys] = await Promise.allSettled([fetchMeshNodes(config), fetchMeshEnvoys(config)]);
  if (nodes.status === "rejected") throw nodes.reason;
  return meshListing(nodes.value, envoys.status === "fulfilled" ? envoys.value : null);
}

/** Live runners on the engine, filtered to those a pool can actually run work on. */
export async function listMeshRunners(config: MeshConfig): Promise<MeshRunnerInfo[]> {
  return fetchMeshEnvoys(config);
}

async function fetchMeshEnvoys(config: MeshConfig): Promise<MeshRunnerInfo[]> {
  const response = await engineApi<{ envoys: any[] }>(config, "GET", "/envoys");
  return (response.envoys ?? []).filter(isLiveRunner).map(toMeshRunnerInfo);
}

function isLiveRunner(envoy: any): boolean {
  return envoy.stop_ts === undefined || envoy.stop_ts === null;
}

function toMeshRunnerInfo(envoy: any): MeshRunnerInfo {
  return { pool: envoy.pool_name ?? "default", envoyKey: envoy.envoy_key ?? "", lastPingTs: envoy.last_ping_ts ?? 0 };
}

/** One `GET /actors` listing mapped to nodes — the single mapping both listing paths share. */
async function fetchMeshNodes(config: MeshConfig): Promise<MeshNodeInfo[]> {
  const actors = await engineApi<{ actors: any[] }>(
    config,
    "GET",
    "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR),
  );
  return actors.actors.filter(isLiveActor).map(toMeshNodeInfo);
}

function isLiveActor(actor: any): boolean {
  return actor.destroy_ts === undefined || actor.destroy_ts === null;
}

function toMeshNodeInfo(actor: any): MeshNodeInfo {
  const deserialized = deserializeMeshKey(typeof actor.key === "string" ? actor.key : undefined);
  return {
    name: deserialized[0] ?? "",
    actorId: actor.actor_id,
    status: deriveActorStatus(actor),
    ...(actor.runner_name_selector ? { pool: actor.runner_name_selector } : {}),
  };
}

/** The node one send targets, or `null` when the engine lists no such node. */
export function findMeshNode(nodes: readonly MeshNodeInfo[], target: string): MeshNodeInfo | null {
  return nodes.find((node) => node.name === target) ?? null;
}

/**
 * Timeout policy for the pre-send check: a timeout is **a failed precheck**, not
 * a silent pass. A send into a pool with no runner costs 30 s and reads as
 * "failed" about a message that may still arrive (P0-B's ambiguity); refusing
 * for one second of uncertainty is the cheap side of that trade. It never
 * implies the message was sent, and it says how to skip the check.
 */
export const PREFLIGHT_TIMEOUT_MS = 6_000;

/**
 * Refuse an enqueue whose target cannot receive it. Engine truth beats the
 * actor record: a pool with no live runner at all blocks, a runner-less actor
 * whose pool does hold a runner is only a warning.
 */
export function meshPreflightVerdict(
  state: MeshNodeState,
  node: Pick<MeshNodeInfo, "name" | "pool">,
): { blocked: string | null; warning: string | null } {
  const pool = meshPoolName(node.pool);
  if (state === "NoRunner") {
    return {
      blocked: `"${node.name}" is online but cannot receive: no runner in pool "${pool}"`,
      warning: null,
    };
  }
  if (state === "Mismatch") {
    return {
      blocked: null,
      warning:
        `"${node.name}" reads idle (no runner) in its actor record while pool "${pool}" does hold a live runner — ` +
        `the engine places it on the next send`,
    };
  }
  return { blocked: null, warning: null };
}

/** Raised by the pre-send check so callers can present a refusal apart from a transport failure. */
export class MeshPreflightError extends Error {
  readonly target: string;
  readonly pool: string;
  constructor(target: string, pool: string, message: string) {
    super(message);
    this.name = "MeshPreflightError";
    this.target = target;
    this.pool = pool;
  }
}

export interface MeshPreflight {
  target: string;
  state: MeshNodeState;
  pool: string;
  warning: string | null;
}

/**
 * Blocking pre-send check: one engine round (actors + envoys, `PREFLIGHT_TIMEOUT_MS`)
 * before the enqueue. Throws {@link MeshPreflightError} when the target cannot
 * receive, so the caller reports "not sent" instead of a 30 s enqueue timeout.
 */
export async function preflightMeshSend(
  config: MeshConfig,
  target: string,
  timeoutMs: number = PREFLIGHT_TIMEOUT_MS,
): Promise<MeshPreflight> {
  let listing: MeshListing;
  try {
    listing = await withTimeout(listMeshState(config), timeoutMs);
  } catch (err) {
    if (err instanceof MeshRemoteBlockedError) throw err;
    throw new MeshPreflightError(
      target,
      "(unknown)",
      `mesh: could not check "${target}" before sending — engine did not answer /actors + /envoys within ${timeoutMs} ms ` +
        `(${err instanceof Error ? err.message : String(err)}). Nothing was sent; the check is deliberately fail-closed so a ` +
        `runner-less pool cannot turn into a 30 s "maybe delivered" timeout. Retry when the engine is reachable, ` +
        `or send without the check via the adapter CLI's --no-preflight`,
    );
  }
  if (listing.envoys === null) {
    throw new MeshPreflightError(
      target,
      "(unknown)",
      `mesh: could not check "${target}" before sending — the engine did not answer /envoys, so whether its pool has a runner ` +
        `is unknown. Nothing was sent; verify with /xfer mesh list, or send without the check via the adapter CLI's --no-preflight`,
    );
  }
  const node = findMeshNode(listing.nodes, target);
  if (!node) {
    throw new MeshPreflightError(
      target,
      "(none)",
      `mesh: no mesh node named "${target}" on the engine — it was never brought up there (/xfer mesh up on that machine) ` +
        `or its actor was destroyed. Nothing was sent`,
    );
  }
  const state = deriveMeshNodeState(node, listing.envoys);
  const pool = meshPoolName(node.pool);
  const verdict = meshPreflightVerdict(state, node);
  if (verdict.blocked) throw new MeshPreflightError(target, pool, `${verdict.blocked}. Nothing was sent — ${preflightRemedy(pool)}`);
  return { target, state, pool, warning: verdict.warning };
}

/** What to do about a refused send, worded for the person holding the other machine. */
export function preflightRemedy(pool: string): string {
  return `start a runner for pool "${pool}" on that machine (open pi there) and retry`;
}
