/**
 * The `xfer-instance` actor, ported to run under the wasm runtime.
 *
 * Shape is deliberately identical to the one in `mesh-engine.ts` (see its
 * `createRivetEngine`): the same state fields, the same `handoff` queue, the
 * same `setDescription`/`getDescription` actions. A mesh node is addressed as
 * actor type + key, so anything else on the mesh — `mesh send`, `/xfer mesh
 * list`, the admin console — keeps working against this node without knowing
 * it is serverless.
 *
 * Two disciplines separate this file from its native twin, and both come from
 * the actor no longer living inside a long-running process:
 *
 * 1. **Reply on receipt.** The run loop hands the message to the bridge and
 *    moves on; it never awaits the agent. A serverless actor may be torn down
 *    the moment the run loop yields, so work that must survive goes through
 *    the Durable Object, not through this function's stack.
 * 2. **No state across calls.** rivetkit's actor state is the engine's — remote
 *    SQLite under wasm — and it holds only what the *mesh* needs (`description`,
 *    the dedupe window). Whatever the agent needs later is the DO's business,
 *    and it is persisted there (see `agent-do.ts`).
 *
 * Experimental: see `examples/cf-actor/README.md`.
 */
import { actor, queue } from "rivetkit";

/** Inline handoff payload carried by the mesh handoff queue (mirror of mesh-engine.ts). */
export interface MeshHandoffMessage {
  id: string;
  from: string;
  /** Intended recipient node name. */
  to?: string;
  summary: string;
  document: string;
}

/** Durable state kept with this node's actor on the engine. */
export interface XferInstanceState {
  description: string;
  delivered?: string[];
}

/** How many delivered handoff ids the receiver remembers — same bound as the extension. */
export const DELIVERED_WINDOW_SIZE = 3;

export function normalizeNodeDescription(value: unknown): string {
  if (typeof value !== "string") throw new Error("description must be a string");
  return value.trim().slice(0, 500);
}

export function isDuplicateMeshHandoff(
  state: XferInstanceState,
  message: Pick<MeshHandoffMessage, "id">,
): boolean {
  return (state.delivered ?? []).includes(message.id);
}

/** Slide one delivered id into the window, after the handoff was handed off. */
export function recordMeshDelivery(state: XferInstanceState, message: Pick<MeshHandoffMessage, "id">): string[] {
  const window = [...(state.delivered ?? []).filter((id) => id !== message.id), message.id];
  state.delivered = window.slice(-DELIVERED_WINDOW_SIZE);
  return state.delivered;
}

/** What the actor hands to the bridge once a message is accepted. */
export type HandoffSink = (message: MeshHandoffMessage, selfKey: string) => void;

export function createXferInstance(sink: HandoffSink) {
  return actor({
    state: { description: "", delivered: [] } satisfies XferInstanceState,
    actions: {
      setDescription: (c, value: unknown) => {
        c.state.description = normalizeNodeDescription(value);
        return c.state.description;
      },
      getDescription: (c) => c.state.description ?? "",
    },
    queues: {
      handoff: queue<MeshHandoffMessage>(),
    },
    run: async (c) => {
      const selfKey = c.key[0] ?? "";
      for await (const message of c.queue.iter()) {
        if (isDuplicateMeshHandoff(c.state, message.body as MeshHandoffMessage)) continue;
        // Hand off, do not await: the run loop must stay free to ack the queue.
        sink(message.body as MeshHandoffMessage, selfKey);
        recordMeshDelivery(c.state, message.body as MeshHandoffMessage);
      }
    },
  });
}
