import { actor, queue } from "rivetkit";

/** The actor type and queue every mesh node speaks; the extension's `mesh-config.ts` pins the same pair. */
export const XFER_INSTANCE_ACTOR = "xfer-instance";
export const HANDOFF_QUEUE = "handoff";

/** Upper bound on a node description, in characters. The extension refuses anything longer. */
const MAX_NODE_DESCRIPTION = 500;

/** Handoff ids already delivered, oldest first. Short: a redelivery lands next to the window's live edge. */
const DELIVERED_WINDOW_SIZE = 3;

export interface MeshHandoffMessage {
  id: string;
  from: string;
  to?: string;
  summary: string;
  document: string;
}

interface XferInstanceState {
  description: string;
  delivered?: string[];
}

/** Trim and cap a description the way the extension does, so both kinds of node store the same value. */
function normalizeNodeDescription(value: unknown): string {
  if (typeof value !== "string") throw new Error("description must be a string");
  const trimmed = value.trim();
  if (trimmed.length > MAX_NODE_DESCRIPTION) {
    throw new Error(`description is limited to ${MAX_NODE_DESCRIPTION} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function alreadyDelivered(state: XferInstanceState, id: string): boolean {
  return (state.delivered ?? []).includes(id);
}

function recordDelivery(state: XferInstanceState, id: string): void {
  state.delivered = [...(state.delivered ?? []).filter((seen) => seen !== id), id].slice(-DELIVERED_WINDOW_SIZE);
}

/** What the actor hands to the bridge once a message is accepted. */
export type HandoffSink = (message: MeshHandoffMessage, selfKey: string) => void;

/**
 * This node's `xfer-instance` actor: the same state, queue and actions the extension's mesh engine
 * runs. The run loop hands a message to `sink` and moves on — it never awaits the agent, because a
 * serverless actor can be torn down the moment it yields.
 */
export function createXferInstance(sink: HandoffSink) {
  return actor({
    state: { description: "", delivered: [] } satisfies XferInstanceState,
    actions: {
      setDescription: (c, value: unknown) => (c.state.description = normalizeNodeDescription(value)),
      getDescription: (c) => c.state.description ?? "",
    },
    queues: {
      [HANDOFF_QUEUE]: queue<MeshHandoffMessage>(),
    },
    run: async (c) => {
      for await (const message of c.queue.iter()) {
        const { body } = message as { body: MeshHandoffMessage };
        if (alreadyDelivered(c.state, body.id)) continue;
        sink(body, c.key[0] ?? "");
        recordDelivery(c.state, body.id);
      }
    },
  });
}
