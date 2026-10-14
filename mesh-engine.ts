import { HANDOFF_QUEUE, XFER_INSTANCE_ACTOR, deserializeMeshKey, type MeshConfig } from "./mesh-config.ts";
import { ensureNativeRuntimeReady } from "./mesh-native.ts";

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
}

/** Upper bound on a node description, in characters. */
export const MAX_NODE_DESCRIPTION = 500;

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
 * Engine-visible lifecycle of one actor, derived from its timestamps.
 * `Destroyed` actors are filtered out of listings, so callers see the four
 * adoptable-or-busy states: Running / Sleeping / Crashed / Pending.
 */
export type MeshActorStatus = "Running" | "Sleeping" | "Crashed" | "Pending" | "Destroyed";

/** Derive an actor's lifecycle status from the engine's raw timestamp fields. */
export function deriveActorStatus(actor: {
  destroy_ts?: number | null;
  error?: unknown;
  sleep_ts?: number | null;
  start_ts?: number | null;
  connectable_ts?: number | null;
}): MeshActorStatus {
  if (actor.destroy_ts !== undefined && actor.destroy_ts !== null) return "Destroyed";
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
  /** Permanently destroy one actor. */
  destroyNode(actorId: string): Promise<void>;
  /** Fire-and-forget enqueue of an inline handoff to the target node. */
  queueSend(target: string, message: MeshHandoffMessage): Promise<void>;
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

export function createRivetEngine(
  config: MeshConfig,
  onHandoff: (message: MeshHandoffMessage, selfKey: string) => void,
  deps: RivetEngineDeps = {},
): MeshEngine {
  let registry: { shutdown(): Promise<void> } | null = null;
  let client: any = null;
  let selfHandle: any = null;

  const engine: MeshEngine = {
    async ensureNode(name: string) {
      await (deps.ensureRuntimeReady ?? ensureNativeRuntimeReady)();
      const { actor, queue, setup } = await (deps.importRivetkit ?? (() => import("rivetkit")))();
      const xferInstance = actor({
        // Written through the state proxy, so the note lives with the actor on
        // the engine: it survives node restart/reconnect and stays readable
        // while this node is offline.
        state: { description: "" } satisfies XferInstanceState,
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
            onHandoff(message.body, selfKey);
          }
        },
      });
      const reg = setup({
        use: { [XFER_INSTANCE_ACTOR]: xferInstance },
        endpoint: config.endpoint,
        namespace: config.namespace,
        token: config.token,
        runtime: "native",
        ...(config.pool ? { envoy: { poolName: config.pool } } : {}),
      });
      const regAny = reg as unknown as { startAndWait(): Promise<void>; shutdown(): Promise<void> };
      await regAny.startAndWait();
      registry = regAny;
      const { createClient } = await (deps.importClient ?? (() => import("rivetkit/client")))();
      client = createClient({ endpoint: config.endpoint, namespace: config.namespace, token: config.token });
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
      const actors = await engineApi<{ actors: any[] }>(config, "GET", "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR));
      return actors.actors
        .filter((a) => a.destroy_ts === undefined || a.destroy_ts === null)
        .map((a) => ({
          name: deserializeKeyString(a.key),
          actorId: a.actor_id,
          status: deriveActorStatus(a),
          ...(a.runner_name_selector ? { pool: a.runner_name_selector } : {}),
        }));
    },

    async destroyNode(actorId: string) {
      await engineApi(config, "DELETE", `/actors/${encodeURIComponent(actorId)}`);
    },

    async queueSend(target: string, message: MeshHandoffMessage) {
      if (!client) throw new Error("mesh is not online — run /xfer mesh up first");
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
): Promise<void> {
  const { createClient } = await import("rivetkit/client");
  const client = createClient({ endpoint: config.endpoint, namespace: config.namespace, token: config.token });
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
}

/** Engine REST call (snake_case responses), mirroring rivetkit's internal apiCall. */
/** Engine REST call (snake_case responses), mirroring rivetkit's internal apiCall. */
async function engineApi<T>(config: MeshConfig, method: string, path: string): Promise<T> {
  const url = new URL(path, config.endpoint);
  if (config.namespace) url.searchParams.set("namespace", config.namespace);
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const response = await fetch(url, { method, headers });
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
export function listMeshNodes(config: MeshConfig): Promise<MeshNodeInfo[]> {
  return engineApi<{ actors: any[] }>(config, "GET", "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR)).then(
    (actors) =>
      actors.actors
        .filter((a) => a.destroy_ts === undefined || a.destroy_ts === null)
        .map((a) => ({ name: deserializeKeyString(a.key), actorId: a.actor_id, status: deriveActorStatus(a) })),
  );
}

function deserializeKeyString(serialized: unknown): string {
  const parts = deserializeMeshKey(typeof serialized === "string" ? serialized : undefined);
  return parts[0] ?? "";
}
