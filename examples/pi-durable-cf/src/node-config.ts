/** The Worker's environment, as Cloudflare hands it to `fetch` and to a Durable Object. */
export interface Env {
  AGENT: DurableObjectNamespace;
  NODE_NAME?: string;
  POOL_NAME?: string;
  MESH_ENDPOINT?: string;
  MESH_NAMESPACE?: string;
  MESH_TOKEN?: string;
  RIVET_ENDPOINT?: string;
  RIVET_NAMESPACE?: string;
  WORKER_PUBLIC_URL: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

/** One string in three places: the registry's `serverless.basePath`, the route this Worker answers, and the pool's callback URL. Change it and all three move together. */
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

export function nodeConfig(env: Env): NodeConfig {
  return {
    nodeName: env.NODE_NAME ?? DEFAULT_NODE_NAME,
    pool: env.POOL_NAME ?? DEFAULT_POOL_NAME,
    endpoint: env.MESH_ENDPOINT ?? env.RIVET_ENDPOINT,
    namespace: env.MESH_NAMESPACE ?? env.RIVET_NAMESPACE,
    token: env.MESH_TOKEN,
    workerUrl: env.WORKER_PUBLIC_URL.replace(/\/+$/, ""),
    basePath: SERVERLESS_BASE_PATH,
    model: { apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL },
  };
}
