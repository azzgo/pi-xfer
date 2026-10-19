import { createClient } from "rivetkit/client";
import { HANDOFF_QUEUE, XFER_INSTANCE_ACTOR } from "./mesh-actor.ts";
import type { NodeConfig } from "./node-config.ts";
import type { MeshHandoffMessage } from "./mesh-actor.ts";

/** Where a reply is enqueued: the sender's own `xfer-instance` actor, in whatever pool its machine chose. */
export interface ReplyClient {
  send(target: string, message: MeshHandoffMessage): Promise<void>;
}

/**
 * The reply goes back as an ordinary Handoff into the sender's queue, un-pooled: the sender lives
 * in whatever pool its own machine chose.
 *
 * This module imports the client, not the registry, so a test can drive the whole app on plain Node
 * — the wasm registry is the one thing only workerd can load.
 */
export function engineReplyClient(config: NodeConfig): ReplyClient {
  if (!config.endpoint) throw new Error("no engine endpoint — the reply has nowhere to go");
  const client = createClient({
    endpoint: config.endpoint,
    ...(config.namespace ? { namespace: config.namespace } : {}),
    ...(config.token ? { token: config.token } : {}),
  });
  return {
    send: async (target, message) => {
      // The connection map is untyped on purpose: the actor definition lives in `mesh-actor.ts`, and
      // typing it here would re-import the registry that this module exists to stay away from.
      const actors = client as unknown as {
        get(type: string, key: string[]): { connect(): { send(name: string, body: unknown): Promise<void> } };
      };
      await actors.get(XFER_INSTANCE_ACTOR, [target]).connect().send(HANDOFF_QUEUE, message);
    },
  };
}
