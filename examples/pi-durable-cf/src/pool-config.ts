import type { NodeConfig } from "./node-config.ts";

/**
 * The pool's timing, in seconds — the engine's unit in a runner-config and RivetKit's in
 * `requestLifespan` / `drainGracePeriod`. Three writers must agree on it: this pool's registration,
 * the registry's `configurePool`, and the out-of-band curl in VERIFICATION.md §1.
 */
export const SERVERLESS_POOL_TIMING = { requestLifespan: 30000, drainGracePeriod: 600 } as const;

if (SERVERLESS_POOL_TIMING.drainGracePeriod >= SERVERLESS_POOL_TIMING.requestLifespan) {
  throw new Error("drainGracePeriod must be strictly below requestLifespan — the engine refuses the pool");
}

/** This node's serverless pool, in both the spellings the engine and RivetKit expect. */
export interface PoolRegistration {
  name: string;
  url: string;
  requestLifespan: number;
  drainGracePeriod: number;
}

export function poolRegistration(config: Pick<NodeConfig, "pool" | "workerUrl" | "basePath">): PoolRegistration {
  return {
    name: config.pool,
    url: `${config.workerUrl}${config.basePath}`,
    requestLifespan: SERVERLESS_POOL_TIMING.requestLifespan,
    drainGracePeriod: SERVERLESS_POOL_TIMING.drainGracePeriod,
  };
}

/**
 * Make the engine hold this node's pool, writing only when what it holds differs.
 *
 * The engine cannot start a serverless runner until this record exists, and its own `configurePool`
 * upsert cannot run before one does — so this is the Worker side of a bootstrap that has to exist on
 * both sides. One attempt per isolate, never retried: a rejected body is refused the same way every
 * time, so a retry loop spends the invocation's subrequest budget to be told "no" again.
 */
export async function ensurePoolRegistered(
  config: Pick<NodeConfig, "endpoint" | "namespace" | "token"> & Parameters<typeof poolRegistration>[0],
  fetcher: typeof fetch = fetch,
): Promise<"wrote" | "already correct"> {
  const registration = poolRegistration(config);
  const { endpoint, namespace, token } = config;
  if (!endpoint) throw new Error("no engine endpoint — the pool has nowhere to register");

  const base = endpoint.replace(/\/+$/, "");
  const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const poolPath = `${base}/runner-configs/${encodeURIComponent(registration.name)}${query}`;

  const existing = await fetcher(poolPath, { headers });
  if (existing.ok && matchesStoredPool(await existing.json().catch(() => null), registration)) {
    return "already correct";
  }

  const datacenters = await fetcher(`${base}/datacenters${query}`, { headers });
  if (!datacenters.ok) throw new Error(`GET /datacenters ${datacenters.status}`);
  const names = ((await datacenters.json()) as { datacenters?: Array<{ name: string }> }).datacenters ?? [];

  const written = await fetcher(poolPath, {
    method: "PUT",
    headers,
    body: JSON.stringify({ datacenters: Object.fromEntries(names.map((dc) => [dc.name, { serverless: serverlessBody(registration, token), metadata: {} }])) }),
  });
  if (!written.ok) throw new Error(`PUT /runner-configs ${written.status} ${await written.text().catch(() => "")}`);
  return "wrote";
}

function serverlessBody(registration: PoolRegistration, token: string | undefined): Record<string, unknown> {
  return {
    url: registration.url,
    headers: token ? { "x-rivet-token": token } : {},
    request_lifespan: registration.requestLifespan,
    drain_grace_period: registration.drainGracePeriod,
  };
}

/** Every datacenter carries the same serverless body, so one entry that differs is a mismatch. */
function matchesStoredPool(config: unknown, registration: PoolRegistration): boolean {
  const stored = (config as { datacenters?: Record<string, { serverless?: Record<string, unknown> }> } | null)?.datacenters ?? {};
  const names = Object.keys(stored);
  if (names.length === 0) return false;
  return names.every((name) => {
    const serverless = stored[name]?.serverless;
    return (
      serverless?.url === registration.url &&
      serverless?.request_lifespan === registration.requestLifespan &&
      serverless?.drain_grace_period === registration.drainGracePeriod
    );
  });
}
