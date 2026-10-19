import { setup } from "rivetkit";
import * as wasmBindings from "@rivetkit/rivetkit-wasm";
import wasmModule from "@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm";
import { createXferInstance, HANDOFF_QUEUE, XFER_INSTANCE_ACTOR, type MeshHandoffMessage } from "./mesh-actor.ts";
import type { Env, NodeConfig } from "./node-config.ts";
import { poolRegistration } from "./pool-config.ts";

export type MeshHandler = (request: Request) => Promise<Response>;

/**
 * The mesh engine, built once per isolate and shared by every request: a fresh registry per request
 * would rebuild the actor definitions, and `configurePool` would run on every call instead of once.
 *
 * Handing a message to the agent is the one thing the actor needs an `env` for — the Durable Object
 * binding. It is read on demand rather than captured, so this module never sees a request.
 */
export function createMeshHandler(config: NodeConfig, env: () => Env): MeshHandler {
  let handler: MeshHandler | undefined;
  return (request) => {
    handler ??= buildRegistry(config, env);
    return handler(request);
  };
}

function buildRegistry(config: NodeConfig, env: () => Env): MeshHandler {
  const { endpoint, namespace, token, pool, workerUrl, basePath } = config;
  const registry = setup({
    use: { [XFER_INSTANCE_ACTOR]: createXferInstance((message) => forwardToAgent(config, env(), message)) },
    runtime: "wasm",
    wasm: { bindings: wasmBindings as never, initInput: wasmModule },
    ...(endpoint ? { endpoint } : {}),
    ...(namespace ? { namespace } : {}),
    ...(token ? { token } : {}),
    serverless: { publicEndpoint: workerUrl, basePath },
    ...(endpoint ? { configurePool: poolRegistration({ pool, workerUrl, basePath }) } : {}),
    sqlite: { backend: "remote" },
    noWelcome: true,
    logging: { level: "info" },
  });
  return (request) => registry.handler(request);
}

/** Fire-and-forget: the queue message is acked as soon as the handoff is handed over, and the Durable Object owns it after that. Not awaited, and not awaited *by the actor* either. */
function forwardToAgent(config: NodeConfig, env: Env, message: MeshHandoffMessage): void {
  void env.AGENT.get(env.AGENT.idFromName(config.nodeName))
    .fetch("https://agent/answer", { method: "POST", body: JSON.stringify(message) })
    .catch((err) => console.error("agent receive failed", err));
}
