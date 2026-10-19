import { createClient } from "rivetkit/client";
import { setup } from "rivetkit";
import * as wasmBindings from "@rivetkit/rivetkit-wasm";
import wasmModule from "@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm";
import { AgentDurableObject, type AgentReply, type AgentStorage } from "./agent-do.ts";
import { createXferInstance, HANDOFF_QUEUE, XFER_INSTANCE_ACTOR, type MeshHandoffMessage } from "./mesh-actor.ts";
import { nodeConfig, type Env, type NodeConfig } from "./node-config.ts";
import { ensurePoolRegistered, poolRegistration } from "./pool-config.ts";

interface NodeRegistry {
  handler: (request: Request) => Promise<Response>;
  /** Started once per isolate, because the isolate cancels it the moment a response returns without it. */
  registering: Promise<unknown>;
}

let cached: NodeRegistry | undefined;

function nodeRegistry(env: Env): NodeRegistry {
  if (cached) return cached;
  const config = nodeConfig(env);
  const registering = config.endpoint
    ? ensurePoolRegistered(config).catch((err) =>
        console.error("in-Worker pool registration failed — not retried in this isolate", err),
      )
    : Promise.resolve();
  cached = { handler: buildRegistry(env, config), registering };
  return cached;
}

/** Built once per isolate, not once per request: a fresh registry per fetch would rebuild the actor definitions. */
function buildRegistry(env: Env, config: NodeConfig): (request: Request) => Promise<Response> {
  const { endpoint, namespace, token, workerUrl, basePath } = config;
  return setup({
    use: { [XFER_INSTANCE_ACTOR]: createXferInstance((message) => forwardToAgent(env.AGENT, config, message)) },
    runtime: "wasm",
    wasm: { bindings: wasmBindings as never, initInput: wasmModule },
    ...(endpoint ? { endpoint } : {}),
    ...(namespace ? { namespace } : {}),
    ...(token ? { token } : {}),
    serverless: { publicEndpoint: workerUrl, basePath },
    ...(endpoint ? { configurePool: poolRegistration(config) } : {}),
    sqlite: { backend: "remote" },
    noWelcome: true,
    logging: { level: "info" },
  }).handler;
}

/** Fire-and-forget: the queue message is acked as soon as the handoff is handed over, and the Durable Object owns it after that. */
function forwardToAgent(agent: DurableObjectNamespace, config: NodeConfig, message: MeshHandoffMessage): void {
  void agent
    .get(agent.idFromName(config.nodeName))
    .fetch("https://agent/receive", { method: "POST", body: JSON.stringify(message) })
    .catch((err) => console.error("agent receive failed", err));
}

/** The answer goes back as an ordinary Handoff into the sender's queue, un-pooled: the sender lives in whatever pool its own machine chose. */
async function sendReply(config: NodeConfig, target: string, reply: AgentReply): Promise<void> {
  if (!config.endpoint) throw new Error("no engine endpoint — the reply has nowhere to go");
  const client = createClient({
    endpoint: config.endpoint,
    ...(config.namespace ? { namespace: config.namespace } : {}),
    ...(config.token ? { token: config.token } : {}),
  });
  const message: MeshHandoffMessage = {
    id: reply.replyId,
    from: config.nodeName,
    to: target,
    summary: `echo of ${reply.inReplyTo}`,
    document: reply.document,
  };
  await client.get(XFER_INSTANCE_ACTOR, [target]).send(HANDOFF_QUEUE, message);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(nodeConfig(env).basePath)) {
      const { handler, registering } = nodeRegistry(env);
      ctx.waitUntil(registering);
      try {
        return await handler(request);
      } catch (err) {
        return new Response(`${err instanceof Error ? err.message : err}`, { status: 500 });
      }
    }
    if (url.pathname === "/health") {
      const { nodeName, endpoint } = nodeConfig(env);
      return Response.json({ ok: true, node: nodeName, engine: Boolean(endpoint) });
    }
    return new Response("not found", { status: 404 });
  },
};

/**
 * The Durable Object as Wrangler instantiates it, bound by the name `wrangler.toml` freezes in its
 * migration. It injects storage and the reply path, so the agent's logic stays runnable against a
 * stand-in. It lives here rather than beside that logic because wrangler constructs it with no way to
 * inject the client — moving it would drag rivetkit into `agent-do.ts`, which `npm test` imports.
 */
export class AgentDurableObjectEntry {
  private readonly agent: AgentDurableObject;

  constructor(state: { storage: AgentStorage }, env: Env) {
    const config = nodeConfig(env);
    this.agent = new AgentDurableObject(
      { storage: state.storage },
      (target, reply) => sendReply(config, target, reply),
      env,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const message = (await request.json()) as MeshHandoffMessage;
    return Response.json(await this.agent.receive(message));
  }
}
