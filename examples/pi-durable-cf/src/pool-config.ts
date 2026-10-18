/**
 * The serverless pool registration this Worker writes, kept free of rivetkit and
 * of the Worker runtime so it can be checked without a wasm bundle or a
 * deployment. A live run proved why that matters: a unit slip here is rejected
 * by the engine as an *illegal config* (not as a mistake), and retrying the
 * rejection burned the invocation's whole subrequest budget — 41 attempts — and
 * dragged the engine's actor wake-up scheduling down with it.
 */

/**
 * The pool's timing, in **seconds**. That is the engine's unit in a
 * runner-config and RivetKit's unit in `requestLifespan`/`drainGracePeriod`, so
 * there is exactly one number system and no conversion anywhere.
 *
 * `drainGracePeriod` must be **strictly less** than `requestLifespan`: the
 * engine's default grace period is 1800 s, and a configured lifespan below that
 * without an explicit grace period is refused outright with
 * `drain_grace_period must be less than request_lifespan`.
 */
export const SERVERLESS_POOL_TIMING = { requestLifespan: 30000, drainGracePeriod: 600 } as const;

/** The `serverless` object the engine stores in a runner-config. */
export function poolServerlessBody(env: { WORKER_PUBLIC_URL: string; MESH_TOKEN?: string }, basePath: string): Record<string, unknown> {
  return {
    url: `${env.WORKER_PUBLIC_URL}${basePath}`,
    headers: env.MESH_TOKEN ? { "x-rivet-token": env.MESH_TOKEN } : {},
    request_lifespan: SERVERLESS_POOL_TIMING.requestLifespan,
    drain_grace_period: SERVERLESS_POOL_TIMING.drainGracePeriod,
  };
}

interface StoredServerless {
  url?: string;
  lifespan?: number;
  grace?: number;
}

/** A runner-config's stored `datacenter → serverless` map, normalized for comparison. */
function storedDatacenters(config: unknown): Record<string, StoredServerless> {
  const datacenters =
    (config as { datacenters?: Record<string, { serverless?: Record<string, unknown> }> } | null)?.datacenters ?? {};
  return Object.fromEntries(
    Object.entries(datacenters).map(([name, dc]) => [
      name,
      {
        url: dc?.serverless?.url as string | undefined,
        lifespan: dc?.serverless?.request_lifespan as number | undefined,
        grace: dc?.serverless?.drain_grace_period as number | undefined,
      },
    ]),
  );
}

/**
 * Whether a runner-config already says what this Worker would write — the
 * check that makes a warm pool cost one GET per isolate instead of a write on
 * every `/start`. Every datacenter carries the same serverless body, so a single
 * entry that differs is a mismatch: a half-correct config is exactly the drift
 * this exists to catch. `datacenterNames` lets the caller insist on the set it
 * is about to write; passing none accepts whatever the engine has.
 */
export function poolRegistrationMatches(
  config: unknown,
  serverless: Record<string, unknown>,
  datacenterNames: string[] = [],
): boolean {
  const stored = storedDatacenters(config);
  const names = datacenterNames.length > 0 ? datacenterNames : Object.keys(stored);
  if (names.length === 0 || Object.keys(stored).length !== names.length) return false;
  return names.every((name) => {
    const entry = stored[name];
    return (
      entry !== undefined &&
      entry.url === serverless.url &&
      entry.lifespan === serverless.request_lifespan &&
      entry.grace === serverless.drain_grace_period
    );
  });
}

/** The runner-config body the engine stores: the same serverless object per datacenter. */
export function poolRegistrationBody(serverless: Record<string, unknown>, datacenterNames: string[]): Record<string, unknown> {
  return {
    datacenters: Object.fromEntries(datacenterNames.map((name) => [name, { serverless, metadata: {} }])),
  };
}

/** A timing pair the engine accepts — the invariant, stated once, for callers and tests. */
export function timingIsLegal(timing: { requestLifespan: number; drainGracePeriod: number }): boolean {
  return (
    Number.isFinite(timing.requestLifespan) &&
    Number.isFinite(timing.drainGracePeriod) &&
    timing.requestLifespan > 0 &&
    timing.drainGracePeriod >= 0 &&
    timing.drainGracePeriod < timing.requestLifespan
  );
}
