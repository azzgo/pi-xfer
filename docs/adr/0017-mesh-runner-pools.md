# Per-host mesh runner pools

Status: accepted

## Context

The mesh (ADR 0013) is a shared engine with one actor per Node. RivetKit's runner
placement is pool-scoped: a runner joined under a pool only receives actors whose
`runner_name_selector` matches that pool. pi-xfer originally left the pool unset,
so every host's runner joined the engine-wide `default` pool and any host could
receive any actor.

On a single machine that is invisible. On a mixed-fleet mesh — a grok bot, an
issue-tracker box, several dev Macs — it produces a real misroute: the engine
schedules node A's actor onto host B's runner, and handoffs sent to node A are
delivered on host B. A mesh user reported exactly this ("lookback": the handoff
showed up on the wrong machine). "Node name" addresses the actor, but by default
nothing pinned *where* that actor runs.

## Decision

Per-host pools, opt-in via `MeshConfig.pool`:

- `setup()` carries `envoy: { poolName }` when the config sets `pool`, so **this
  host's runner joins its own pool**.
- The self actor's `client.getOrCreate(XFER_INSTANCE_ACTOR, [name], { poolName })`
  carries the pool, so **this Node's actor is created in and resolved from that
  pool** — only this machine can be scheduled to run it.
- Everything that reaches *other* nodes stays un-pooled: `listNodes()` is the
  un-filtered engine listing, and `queueSend`/`getDescription` use `client.get`
  (no create), so a Node in another pool is still discovered and addressable.
  Only the placement of our own actor is pinned.
- `pool` absent reproduces the previous call shape byte-for-byte: no `envoy`
  block, and `getOrCreate` called with name + key only. Default behavior is
  unchanged.
- The adapter daemon exposes the same value as `--pool`, mirroring
  `--engine/--namespace/--token` (ADR 0015).

Pool creation was left un-automated at first: the engine needs a runner-config
per pool before it accepts runners. P1 now automates it (see the amendment
below).
`mesh up` creates the pool's runner-config when the engine does not have it,
and `/xfer mesh setup` does the same check on demand; the manual
`PUT /runner-configs/<pool>?namespace=<ns>` call stays documented in
[docs/guides/mesh-setup.md](../guides/mesh-setup.md).

## API evidence (rivetkit 2.3.26, pinned)

File `node_modules/rivetkit/dist/tsup/config-Cv6pjCt-.d.ts`:

- `setup()` config carries the envoy/runner pool (line 185):
  ```ts
  envoy: z$1.ZodDefault<z$1.ZodOptional<z$1.ZodObject<{
      poolName: z$1.ZodDefault<z$1.ZodString>;
      version: z$1.ZodDefault<z$1.ZodNumber>;
      totalSlots: z$1.ZodDefault<z$1.ZodNumber>;
      envoyKey: z$1.ZodOptional<z$1.ZodString>;
  }, z$1.core.$strip>>>;
  ```
- The public `getOrCreate` accepts per-call pool overrides (line 1742):
  ```ts
  getOrCreate<AD extends AnyActorDefinition>(name: string, key?: string | string[], opts?: GetOrCreateOptions): ActorHandle<AD>;
  ```
- `GetOrCreateOptions.poolName` (lines 1643–1646) / `CreateOptions.poolName`
  (lines 1659–1662):
  ```ts
  /**
   * Name of the envoy pool to select for this actor if it is created.
   * Overrides the client's configured `poolName` for this call.
   */
  poolName?: string;
  ```
- `CreateRequestSchema` carries `poolName` engine-side (line 33), and
  `GetOrCreateWithKeyInput`/`CreateInput` both document `poolName` as
  "Overrides the client's configured pool name for this actor" (lines 559, 569).

File `node_modules/rivetkit/dist/tsup/chunk-LEXBAJ2Q.js` (the engine request the
call becomes) — line 6053:

```js
runner_name_selector: poolName ?? this.#config.poolName,
```

i.e. the per-call `poolName` lands in the create request's
`runner_name_selector`, which is exactly what the runner's `envoy.poolName`
must match. The client config's default `poolName` is `getRivetPool() ?? "default"`
(lines 5156, 5209), confirming the pre-change behavior was the shared `default`
pool.

## Consequences

- A handoff addressed to a Node is delivered on that Node's host, even when
  several hosts share one engine, because the engine can only schedule the actor
  onto a runner in the matching pool.
- The mixed fleet pays one extra one-time `runner-config` per host. That is the
  trade: an extra control-plane object per machine versus correct delivery
  locality.
- Per-host pools are a placement guarantee, not isolation of data or namespaces
  — `namespace` semantics are untouched and orthogonal.
- A pool with no runner-config accepts nothing; the symptom is a Node that
  connects but never starts. Documented in the guide.

## Amendment: `up` ensures the pool (2026-11-23)

The "pool creation is not automated" clause above did not survive contact with a
second namespace. Runner configs are **per namespace and per pool**, so a
namespace created after the first `mesh setup` contains none; the engine then
refuses the runner with

```
no_runner_config: Must create a runner config before connecting an envoy with pool name {pool_name:?}
```

and RivetKit's native runtime answers that refusal by reconnecting on a backoff
with nothing logged at error level. The only thing pi-xfer could see — and the
only thing a user saw — was

```
RivetKit registry did not register with the Engine within 30000ms
```

which names neither the pool nor the namespace and reads like a token or config
problem. Two tokens can be identical and the two commands still differ: `mesh
status` is one REST round that works whether or not a pool exists, while `mesh up`
must complete an envoy registration into a pool. Reproduced on a loopback 2.3.26
engine: fresh namespace, `pool` set, no runner-config → 30 s timeout with no
further message; after the runner-config exists → registration in 170 ms.

So `createRivetEngine.ensureNode` now resolves the pool before it registers:

- `pool` unset: nothing happens (the engine's `default` pool is the fallback).
- `pool` set and its runner-config exists: nothing is written.
- `pool` set and missing: `ensureRunnerPool` creates it, covering **every**
  datacenter the engine lists (`GET /datacenters`), and `mesh.log` records
  `msg="mesh pool" … action=created|exists`.
- creation fails: `up` stops with the pool, the namespace and the failed call,
  instead of burning 30 s on a registration the engine has already refused.

The engine's error is still the reason the client message now carries namespace
and pool and points at `RIVET_LOG_LEVEL=debug`; the endpoint name (`/runner-configs`)
is unchanged, because engines before the `/pools` rename only speak that one.

## References

- ADR 0013 (mesh transport) — the engine and the crash-policy/sleep model.
- ADR 0015 (adapter daemon) — the second host that gets `--pool`.
- `docs/guides/mesh-setup.md` — per-host pool setup.
