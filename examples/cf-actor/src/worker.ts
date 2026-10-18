/**
 * Cloudflare Worker entry: a mesh node that costs nothing to keep alive.
 *
 * Three things meet here, and the wiring between them is the whole example:
 *
 * 1. **rivetkit's registry in wasm** (`runtime: "wasm"` + `registry.handler`).
 *    The bare wasm path is the only one available: npm ships the `--target web`
 *    binding, `@rivetkit/cloudflare-workers` is not a 2.3.26 dependency, and the
 *    `pkg-cloudflare` target is a build script rather than an artifact. The
 *    binding is injected statically because rivetkit resolves it through a
 *    deliberately opaque dynamic specifier — see README "Bundling".
 * 2. **The mesh actor** (`createXferInstance`) — byte-for-byte the shape the
 *    extension runs, so this node is addressable by every existing surface.
 * 3. **The Durable Object** (`AgentDurableObject`) — the agent's memory, which
 *    the actor explicitly does not hold.
 *
 * Reply path: the actor hands a message to `forwardToAgent`, which calls into
 * the DO; the DO answers and enqueues the answer into the sender's `handoff`
 * queue with a rivetkit client. Nothing in that chain waits for a model before
 * the queue message is acked.
 *
 * Experimental: see `examples/cf-actor/README.md`.
 */
import { createClient } from "rivetkit/client";
import { setup } from "rivetkit";
import * as wasmBindings from "@rivetkit/rivetkit-wasm";
import wasmModule from "@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm";
import { AgentDurableObject, poolName, type AgentReply, type AgentStorage, type Env } from "./agent-do.ts";
import { createXferInstance, type MeshHandoffMessage } from "./mesh-actor.ts";

/** Actor type and queue the extension uses; keep these in lockstep with mesh-config.ts. */
const XFER_INSTANCE_ACTOR = "xfer-instance";
const HANDOFF_QUEUE = "handoff";

/** This node's mesh name — the actor key every other node addresses it by. */
function selfName(env: Env): string {
  return env.NODE_NAME ?? "cf-node";
}

/**
 * Enqueue the answer into the sender's queue. The client is un-pooled on
 * purpose: the sender lives in whatever pool its own machine put it in, and a
 * cross-pool send is what makes this node a peer rather than a leaf.
 */
async function sendReply(env: Env, target: string, reply: AgentReply): Promise<void> {
  if (!env.MESH_ENDPOINT) throw new Error("MESH_ENDPOINT is not set — the reply has nowhere to go");
  const client = createClient({
    endpoint: env.MESH_ENDPOINT,
    ...(env.MESH_NAMESPACE ? { namespace: env.MESH_NAMESPACE } : {}),
    ...(env.MESH_TOKEN ? { token: env.MESH_TOKEN } : {}),
  });
  const message: MeshHandoffMessage = {
    id: reply.replyId,
    from: selfName(env),
    to: target,
    summary: `echo of ${reply.inReplyTo}`,
    document: reply.document,
  };
  await client.get(XFER_INSTANCE_ACTOR, [target]).send(HANDOFF_QUEUE, message);
}

/** One DO instance per node name: the agent's memory is per node, like the actor's key. */
function agentStub(env: Env): DurableObjectStub {
  return env.AGENT.get(env.AGENT.idFromName(selfName(env)));
}

/**
 * The actor's sink. It must not block the run loop, so the DO call is fired
 * without awaiting: the queue message is acked as soon as the handoff is
 * recorded, and the DO owns everything after that.
 */
function forwardToAgent(env: Env, message: MeshHandoffMessage): void {
  const stub = agentStub(env);
  void stub
    .fetch("https://agent/receive", { method: "POST", body: JSON.stringify(message) })
    .catch((err) => console.error("agent receive failed", err));
}

/**
 * Built once per isolate, not once per request. `setup()` installs the actor
 * definitions and the runtime; a fresh registry on every fetch would rebuild
 * that on each invocation, and the engine's callbacks would land on a different
 * one than the request that created it.
 */
let registry: ReturnType<typeof setup> | undefined;

export function createRegistry(env: Env) {
  if (registry) return registry;
  const instance = createXferInstance((message) => forwardToAgent(env, message));
  registry = setup({
    use: { [XFER_INSTANCE_ACTOR]: instance },
    runtime: "wasm",
    wasm: { bindings: wasmBindings as never, initInput: wasmModule },
    // Serverless: the engine calls back into this Worker, so it must know the
    // public URL. basePath must match the route the Worker answers below.
    serverless: {
      publicEndpoint: env.WORKER_PUBLIC_URL,
      basePath: "/api/rivet",
    },
    // Join this named serverless pool rather than the engine default, so the
    // node is addressable as a pool of its own. The engine-side runner-config
    // for that name is registered out of band (VERIFICATION.md step 1) —
    // nothing here creates it, and no pi-xfer command may point at it.
    ...(env.MESH_ENDPOINT
      ? { configurePool: { name: poolName(env), url: env.MESH_ENDPOINT } }
      : {}),
    // wasm forces the engine-side SQLite; a local one does not exist here.
    sqlite: { backend: "remote" },
    noWelcome: true,
    logging: { level: "info" },
  });
  return registry;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/rivet")) {
      return createRegistry(env).handler(request);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, node: selfName(env) });
    }
    return new Response("not found", { status: 404 });
  },
};

/**
 * The DO as Wrangler instantiates it. Storage and the reply path are injected
 * here, so `AgentDurableObject`'s logic stays runnable against a stand-in —
 * which is how its echo behaviour is checked without a deployment.
 */
export class AgentDurableObjectEntry {
  private readonly agent: AgentDurableObject;

  constructor(state: { storage: AgentStorage }, env: Env) {
    this.agent = new AgentDurableObject(
      { storage: state.storage },
      (target, reply) => sendReply(env, target, reply),
      env,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const message = (await request.json()) as MeshHandoffMessage;
    return Response.json(await this.agent.receive(message));
  }
}
