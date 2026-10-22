import type { AgentStorage } from "./agent-do.ts";
/** The Worker's environment, as Cloudflare hands it to `fetch` and to a Durable Object. */
export interface Env {
  AGENT: DurableObjectNamespace;
  /**
   * Present only inside the Durable Object, which merges its own storage in before handing the
   * request to the app. The Worker never has it, and every route that reads it runs behind the DO.
   */
  AGENT_STORAGE: AgentStorage;
  NODE_NAME?: string;
  POOL_NAME?: string;
  MESH_ENDPOINT?: string;
  MESH_NAMESPACE?: string;
  MESH_TOKEN?: string;
  RIVET_ENDPOINT?: string;
  RIVET_NAMESPACE?: string;
  WORKER_PUBLIC_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

/**
/**
 * The path the mesh registry owns. This used to be three strings that had to agree — the registry's
 * `serverless.basePath`, the Worker's own route, and the pool's callback URL. The first two are now
 * one: the registry routes this path itself, so only the pool record reads it here.
 */
export const SERVERLESS_BASE_PATH = "/api/rivet";

export const DEFAULT_NODE_NAME = "cf-node";
export const DEFAULT_POOL_NAME = "cloudflare";

export interface ModelCredentials {
  apiKey?: string;
  model?: string;
}

export interface NodeConfig {
  /** This node's mesh name — the actor key every other node addresses it by, and the Durable Object instance name. */
  nodeName: string;
  pool: string;
  endpoint: string | undefined;
  namespace: string | undefined;
  token: string | undefined;
  /** Without a trailing slash, so it can be concatenated with a path. */
  workerUrl: string;
  basePath: string;
  model: ModelCredentials;
}

export function nodeConfig(env: Env, requestUrl?: string): NodeConfig {
  return {
    nodeName: env.NODE_NAME ?? DEFAULT_NODE_NAME,
    pool: env.POOL_NAME ?? DEFAULT_POOL_NAME,
    endpoint: env.MESH_ENDPOINT ?? env.RIVET_ENDPOINT,
    namespace: env.MESH_NAMESPACE ?? env.RIVET_NAMESPACE,
    token: env.MESH_TOKEN,
    workerUrl: (env.WORKER_PUBLIC_URL ?? originOf(requestUrl)).replace(/\/+$/, ""),
    basePath: SERVERLESS_BASE_PATH,
    model: { apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL },
  };
}

/** `wrangler dev` and a first deploy have no URL to read before a request arrives; the request's own origin is one. */
function originOf(url: string | undefined): string {
  if (!url) throw new Error("WORKER_PUBLIC_URL is unset and there was no request to read an origin from");
  return new URL(url).origin;
}
