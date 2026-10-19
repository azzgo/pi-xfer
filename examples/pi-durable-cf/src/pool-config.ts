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

/** This node's serverless pool, in the one spelling RivetKit's `configurePool` expects. */
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
 * The engine's own spelling of the same record, for the out-of-band bootstrap: a cold pool has no
 * runner to run `configurePool` in, so this body is what the human writes first.
 */
export function runnerConfigBody(
  registration: PoolRegistration,
  token: string | undefined,
  datacenters: string[],
): Record<string, unknown> {
  const serverless = {
    url: registration.url,
    headers: token ? { "x-rivet-token": token } : {},
    request_lifespan: registration.requestLifespan,
    drain_grace_period: registration.drainGracePeriod,
  };
  return { datacenters: Object.fromEntries(datacenters.map((name) => [name, { serverless, metadata: {} }])) };
}
