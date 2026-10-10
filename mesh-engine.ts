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

/** One mesh node as seen by the engine. */
export interface MeshNodeInfo {
  name: string;
  actorId: string;
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
}

/** Bound on queue enqueue so a stuck/unreachable target errors instead of hanging. */
const QUEUE_SEND_TIMEOUT_MS = 30_000;

export function createRivetEngine(config: MeshConfig, onHandoff: (message: MeshHandoffMessage, selfKey: string) => void): MeshEngine {
  let registry: { shutdown(): Promise<void> } | null = null;
  let client: any = null;

  const engine: MeshEngine = {
    async ensureNode(name: string) {
      await ensureNativeRuntimeReady();
      const { actor, queue, setup } = await import("rivetkit");
      const xferInstance = actor({
        state: {},
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
      });
      const regAny = reg as unknown as { startAndWait(): Promise<void>; shutdown(): Promise<void> };
      await regAny.startAndWait();
      registry = regAny;
      const { createClient } = await import("rivetkit/client");
      client = createClient({ endpoint: config.endpoint, namespace: config.namespace, token: config.token });
      const handle = client.getOrCreate(XFER_INSTANCE_ACTOR, [name]);
      await handle.resolve();
    },

    async stop() {
      if (registry) {
        await registry.shutdown();
        registry = null;
        client = null;
      }
    },

    async listNodes() {
      const actors = await engineApi<{ actors: any[] }>(config, "GET", "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR));
      return actors.actors
        .filter((a) => a.destroy_ts === undefined || a.destroy_ts === null)
        .map((a) => ({ name: deserializeKeyString(a.key), actorId: a.actor_id }));
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
  };
  return engine;
}

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

function deserializeKeyString(serialized: unknown): string {
  const parts = deserializeMeshKey(typeof serialized === "string" ? serialized : undefined);
  return parts[0] ?? "";
}
