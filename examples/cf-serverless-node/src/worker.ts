import type { AgentStorage } from "./agent-do.ts";
import { createApp } from "./app.ts";
import { createMeshHandler } from "./mesh-registry.ts";
import { nodeConfig, type Env } from "./node-config.ts";

export interface WorkerEntry {
  fetch(request: Request): Promise<Response>;
}

/**
 * The whole serverless node as one object, built once per isolate. The mesh registry is expensive to
 * build and must not be rebuilt per request; nothing else here is cached.
 *
 * `env` is only read through here, never captured: `WORKER_PUBLIC_URL` may be absent, in which case
 * every URL is the request's own origin.
 */
export function application(env: Env): WorkerEntry {
  return app ??= buildApplication(env);
}

let app: WorkerEntry | undefined;

function buildApplication(env: Env): WorkerEntry {
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const mesh = async (request: Request): Promise<Response> => {
    handler ??= createMeshHandler(nodeConfig(env, request.url), () => env);
    return handler(request);
  };
  const hono = createApp({ mesh });
  return { fetch: async (request) => hono.fetch(request, env) };
}

export default {
  fetch: (request: Request, env: Env) => application(env).fetch(request),
};

/**
 * The Durable Object as Wrangler instantiates it, bound by the name `wrangler.toml` freezes in its
 * migration. It is a storage adapter and nothing else: it merges its own storage into the env and
 * hands the request to the same app the Worker runs, so the answer logic and the reply path have
 * exactly one implementation. Renaming the class is a new migration tag.
 */
export class AgentDurableObjectEntry {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    const withStorage: Env = { ...this.env, AGENT_STORAGE: this.state.storage as unknown as AgentStorage };
    return application(withStorage).fetch(request);
  }
}
