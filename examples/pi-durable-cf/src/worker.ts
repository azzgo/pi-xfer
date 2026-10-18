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
 * Experimental: see `examples/pi-durable-cf/README.md`.
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
/** Where the engine POSTs `/start`: one string for serverless.basePath, configurePool and the runner-config. */
const SERVERLESS_BASE_PATH = "/api/rivet";

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
  if (!rivetEndpoint(env)) throw new Error("no engine endpoint — the reply has nowhere to go");
  const client = engineClient(env);
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
/** The in-flight self-registration, kept so `fetch` can hand it to `waitUntil`. */
let registered: Promise<unknown> | undefined;

/** RivetKit's own env-var channel, for the code paths that read it directly. */
function rivetEndpoint(env: Env): string | undefined {
  return env.MESH_ENDPOINT ?? env.RIVET_ENDPOINT;
}

function namespace(env: Env): string | undefined {
  return env.MESH_NAMESPACE ?? env.RIVET_NAMESPACE;
}

/** `?namespace=` / `&namespace=` for the engine's HTTP API, which takes it as a query parameter. */
function apiQuery(env: Env, prefix: "?" | "&"): string {
  const name = namespace(env);
  return name ? `${prefix}namespace=${encodeURIComponent(name)}` : "";
}

/** The engine as a plain client: self-registration and the reply path both use it. */
function engineClient(env: Env): ReturnType<typeof createClient> {
  const endpoint = rivetEndpoint(env);
  if (!endpoint) throw new Error("no engine endpoint — set MESH_ENDPOINT (or RIVET_ENDPOINT)");
  const name = namespace(env);
  return createClient({
    endpoint,
    ...(name ? { namespace: name } : {}),
    ...(env.MESH_TOKEN ? { token: env.MESH_TOKEN } : {}),
  });
}

/**
 * Create this node's actor before anything needs it. The engine never wakes a
 * serverless pool on its own, and an actor that exists nowhere appears in no
 * listing — so a Worker that only answered deliveries would be invisible until
 * the first send created it. This runs at most once per isolate, and its failure
 * must not take the route down: the registry serves whatever the engine asks of
 * it either way.
 *
 * Unproven: in the recorded round trip the actor was created by an out-of-band
 * `getOrCreate`, so self-registration has not been shown to make a node appear
 * in a listing — VERIFICATION.md step 3 says so.
 */
function registerSelf(env: Env): Promise<unknown> {
  registered ??= engineClient(env)
    .getOrCreate(XFER_INSTANCE_ACTOR, [selfName(env)], { poolName: poolName(env) })
    .resolve()
    .catch((err) => {
      registered = undefined;
      console.error("self-registration failed — the node stays invisible until it succeeds", err);
    });
  return registered;
}

/**
 * Register this node's pool from inside the Worker as well. RivetKit's own
 * `configurePool` upsert runs when the engine POSTs `/start` — which it cannot
 * do before a runner exists — so on a cold pool it is the out-of-band
 * runner-config that bootstraps it, and a drift between the two shows up only
 * after the first send. Doing it here means the first `/start` already finds
 * the right URL. Failure is logged, not fatal: the engine-side registration may
 * still be correct, and the node can serve the request either way.
 */
async function configurePoolSelf(env: Env): Promise<void> {
  const token = env.MESH_TOKEN;
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  // The engine API is the endpoint root (RivetKit appends paths to it directly)
  // and the namespace is a query parameter on every call.
  const base = rivetEndpoint(env)!.replace(/\/+$/, "");
  const query = apiQuery(env, "?");
  try {
    const datacentersResponse = await fetch(`${base}/datacenters${query}`, { headers });
    if (!datacentersResponse.ok) throw new Error(`GET /datacenters ${datacentersResponse.status}`);
    const { datacenters } = (await datacentersResponse.json()) as { datacenters: Array<{ name: string }> };
    const serverless = {
      url: `${env.WORKER_PUBLIC_URL}${SERVERLESS_BASE_PATH}`,
      headers: token ? { "x-rivet-token": token } : {},
      request_lifespan: env.SERVERLESS_REQUEST_LIFESPAN_MS ?? 30000,
    };
    const pool = await fetch(`${base}/runner-configs/${encodeURIComponent(poolName(env))}${query}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        datacenters: Object.fromEntries(datacenters.map((dc) => [dc.name, { serverless, metadata: {} }])),
      }),
    });
    if (!pool.ok) throw new Error(`PUT /runner-configs ${pool.status} ${await pool.text().catch(() => "")}`);
  } catch (err) {
    console.error("in-Worker pool registration failed — the out-of-band runner-config stands", err);
  }
}

/** Work started on the first cold call, for `fetch` to hand to `waitUntil`. */
const pending: Promise<unknown>[] = [];
let poolConfigured = false;

export function createRegistry(env: Env) {
  if (registry) return registry;
  const instance = createXferInstance((message) => forwardToAgent(env, message));
  const endpoint = rivetEndpoint(env);
  const ns = namespace(env);
  registry = setup({
    use: { [XFER_INSTANCE_ACTOR]: instance },
    runtime: "wasm",
    wasm: { bindings: wasmBindings as never, initInput: wasmModule },
    // The engine this node belongs to. configurePool (below) needs it too:
    // without an endpoint the pool has nowhere to register, and parseConfig
    // rejects the whole config on the first request.
    ...(endpoint ? { endpoint } : {}),
    ...(ns ? { namespace: ns } : {}),
    ...(env.MESH_TOKEN ? { token: env.MESH_TOKEN } : {}),
    // Serverless: the engine calls back into this Worker, so it must know the
    // public URL. basePath must match the route the Worker answers below.
    serverless: {
      publicEndpoint: env.WORKER_PUBLIC_URL,
      basePath: SERVERLESS_BASE_PATH,
    },
    // Join this named serverless pool rather than the engine default, so the
    // node is addressable as a pool of its own. `url` is THIS Worker's public
    // address — the one the engine POSTs /start to — never the engine's
    // endpoint: pointing it at the engine makes the engine call itself, which
    // fails as an empty `serverless start payload`. The same registration is
    // done out of band (VERIFICATION.md step 1) to bootstrap a cold pool, so
    // both sides must carry the same URL.
    ...(endpoint
      ? {
          configurePool: {
            name: poolName(env),
            url: `${env.WORKER_PUBLIC_URL}${SERVERLESS_BASE_PATH}`,
            ...(env.SERVERLESS_REQUEST_LIFESPAN_MS
              ? { requestLifespan: env.SERVERLESS_REQUEST_LIFESPAN_MS / 1000 }
              : {}),
          },
        }
      : {}),
    // wasm forces the engine-side SQLite; a local one does not exist here.
    sqlite: { backend: "remote" },
    noWelcome: true,
    logging: { level: "info" },
  });
  if (endpoint) {
    // Both are background IO on a cold isolate; neither may hold the first
    // response open, and both are safe to repeat.
    if (!registered) pending.push(registerSelf(env));
    if (!poolConfigured) {
      poolConfigured = true;
      pending.push(configurePoolSelf(env));
    }
  }
  return registry;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(SERVERLESS_BASE_PATH)) {
      const registry = createRegistry(env);
      // Without waitUntil the isolate cancels the pending calls the moment this
      // response returns.
      for (const work of pending.splice(0)) ctx.waitUntil(work);
      try {
        return await registry.handler(request);
      } catch (err) {
        // A config or protocol error should name itself at the edge, not
        // surface as an empty 500 — this is how a Zod rejection was found.
        return new Response(`${err instanceof Error ? err.message : err}`, { status: 500 });
      }
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, node: selfName(env), engine: Boolean(rivetEndpoint(env)) });
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
