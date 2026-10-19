# Pi Durable agent — a mesh node that costs nothing while idle

> **Experimental, not a supported feature.** No SLA, no network test in CI, no promise across
> rivetkit majors. It is an **example** (`examples/pi-durable-cf/`), not part of the pi-xfer
> extension — and its npm dependencies belong to that directory, not to the extension, which ships
> none. If it breaks on a future rivetkit, pi-xfer is unaffected.

The mesh has always been a set of machines that stay on. This is the first kind that does not: a
**Pi Durable agent** on Cloudflare, reachable as an ordinary mesh node. It wakes when there is work,
answers, and otherwise does not exist — and therefore costs nothing to keep.

The Worker and its `xfer-instance` actor are how that agent joins the mesh. They are the transport,
not the point.

Two things worth knowing before you commit to it:

- **Good destination, poor source.** A serverless node has no read side and no presence while
  asleep. It is the right place to send buffered work to; it is the wrong place to expect an answer
  on demand.
- **The engine must be publicly reachable**, because it calls back into the Worker. That is a
  deployment-shape change, not a flag — see [mesh setup](mesh-setup.md) and
  [ADR 0013](../adr/0013-xfer-mesh-rivetkit-transport.md)'s serverless exception.

## What it is

```
laptop (pi, mesh up)                 Cloudflare
      │                                 ┌────────────────────────────────────┐
      │  handoff queue message          │ Worker                             │
      ├────────────────────────────────▶│  registry.handler()   [wasm]        │
      │                                 │   └─ xfer-instance actor           │
      │                                 │        state ── engine-side SQLite │
      │                                 │        queue ── "handoff"          │
      │                                 │        run ── hands off, no await  │
      │                                 │              │                     │
      │                                 │              ▼                     │
      │                                 │        Durable Object              │
      │                                 │          agent memory (DO storage) │
      │                                 │          answerHandoff()           │
      │                                 │              │                     │
      │  handoff queue message          │              ▼  rivetkit client     │
      ◀─────────────────────────────────┤        enqueue into sender's queue │
      │                                 └────────────────────────────────────┘
```

The Worker itself is a Hono app (`src/app.ts`) with the wasm registry mounted behind `all("*")`:
three routes it owns, and one prefix it hands over. Both Cloudflare entry points — the Worker and the
Durable Object class — run that same app, which is why the answer logic has exactly one
implementation.

Everything on the mesh only ever sees an `xfer-instance` actor, so `/xfer mesh list`,
`/xfer mesh <name>`, `desc` and the adapter daemon all work with it unchanged. No new commands.

Start with `examples/pi-durable-cf/README.md`; this page is the map, that directory is the manual.

## Two persistence layers, never blurred

The easiest thing to get wrong, so it is stated once:

| Layer | Lives | Holds | Survives |
|---|---|---|---|
| **rivetkit actor state** | the engine, in remote SQLite (forced under `runtime: "wasm"`) | the node `description`, the delivered-id dedupe window | node restart, reconnect, actor sleep |
| **Durable Object storage** | Cloudflare | what the *agent* needs — which handoffs it received and what it answered | request boundaries, cold starts |

Nothing on the mesh reads DO storage, and actor state may never stand in for it. The actor belongs
to the transport; the DO belongs to the agent.

## The discipline a serverless actor must follow

1. **Reply on receipt.** The run loop hands the message to the DO and moves on; it never awaits the
   agent. A serverless actor can be torn down the moment the run loop yields, so anything that must
   survive goes through the DO, not a function's stack.
2. **No state across calls.** There is no long-lived process to keep a variable in. Anything needed
   later is written to DO storage when it is learned, not reconstructed later.
3. **Ack means accepted, not answered.** The queue message is acked as soon as it is recorded. If
   the DO then dies, the mesh will **not** redeliver — which is why "accepted but never answered" is
   its own failure mode in `VERIFICATION.md` step 5. A redelivery that *does* arrive is answered from
   the DO's own record, with the id it produced the first time and no second reply.

## Addressing and pools

A node is `actor type + key`: `xfer-instance` plus the node name (`NODE_NAME`, default `cf-node`).
Nothing else. The pool decides *where* the actor is placed.

- The example joins the pool **`cloudflare`** by default — `POOL_NAME` in `wrangler.toml`, read
  through `nodeConfig()`. Rename it freely, but the engine-side runner-config must carry the same name:
  it is the one string that has to match on both sides.
- **No pi-xfer command may be pointed at a serverless pool.** `ensureRunnerPool()` hardcodes
  `{ normal: {} }` and cannot express one, so `/xfer mesh setup` (and the runner-less pools it
  writes) does not apply here: registration is out of band, step 1 of the procedure.
- Unlike a per-host pool ([mesh setup](mesh-setup.md#per-host-runner-pools-mixed-fleets)), this pool
  holds no runner of its own: the engine starts the Worker on demand.

## Deploying it

The full procedure is
[`examples/pi-durable-cf/VERIFICATION.md`](../../examples/pi-durable-cf/VERIFICATION.md) — seven
steps, and the only place in this repository whose verification touches a live deployment (a
Durable Object has no local stand-in). **It is a human decision every time; nothing in it runs from
CI, a test, or a script here.**

Prerequisites, condensed — each one fails as something that looks unrelated:

| Need | Why it bites otherwise |
|---|---|
| Engine pinned to **`rivetdev/engine:2.3.26`** | `:latest` and rivetkit `2.3.26` disagreed on the serverless start payload (empty body, `payload too short`) |
| Engine `topology.datacenters[].public_url` = its public hostname | at `/start` the engine checks what it advertises against its own endpoint; unset means `endpoint_mismatch`. Nested `topology` cannot come from env vars — mount a config file |
| A Worker URL **reachable from the engine** (a custom domain) | `*.workers.dev` timed out from an engine on a mainland-China network, and it is the engine that calls the Worker |
| Runner-config with **`request_lifespan`** | without it the engine applies its own default and a short lifespan is refused |
| **`drain_grace_period` explicit and strictly smaller** | the engine's default grace is 1800 s; omit it and a lower lifespan is rejected as an *illegal config* |
| No DeepSeek key on the first pass | the echo path must be proven before any credential exists |

Two traps worth repeating here because they cost real time:

- **`wrangler.toml` is TOML.** Every top-level key must come *above* the first `[table]` header — a
  `routes` block written after `[vars]` becomes an ordinary variable named `routes` and the custom
  domain silently never exists. `npm run check` prints the resolved vars; read them.
- **The pool timing is one constant, in seconds** (`SERVERLESS_POOL_TIMING` in
  `src/pool-config.ts`) shared by `configurePool` and the out-of-band curl — two writers, one number
  system, no `_MS` anywhere. `runnerConfigBody()` prints the bootstrap JSON from the same constant.

## Troubleshooting

Six of the most common rows from
[the full table](../../examples/pi-durable-cf/VERIFICATION.md#when-it-does-not-work); every one was
hit for real.

| Signal | Cause | Fix |
|---|---|---|
| Engine answers `endpoint_mismatch` when starting the runner | `topology.public_url` missing, or not the hostname clients use | mount the config file from the prerequisites and restart the engine |
| `serverless start payload too short` (empty body) | the pool's `url` points at the **engine**, so the engine POSTs `/start` to itself | `url` must be `<WORKER_PUBLIC_URL>/api/rivet` — in the runner-config *and* `configurePool` |
| `failed to resolve host`, or the engine never reaches the Worker | `*.workers.dev` (unreachable from some networks), or the custom domain was never created | custom domain; verify the route in the dashboard, not from the deploy output |
| 400 `drain_grace_period must be less than request_lifespan` | the pool body omitted the grace period (engine default 1800 s) or set one ≥ the lifespan | keep `drainGracePeriod < requestLifespan` in `SERVERLESS_POOL_TIMING`, then redeploy |
| Actor stuck on an `error` no restart clears | the actor record's `error` is sticky — it is not cleared when a runner appears | destroy and recreate: `DELETE /actors/<id>?namespace=<ns>`, then `getOrCreate` again (step 4's client does it) |
| Pool wedged: node listed, sends hang or `no runner in pool "cloudflare"` | the engine's view of the pool is stale or has no runner | re-`PUT` the runner-config (step 1) to re-register it, then send from a bare client to wake it |

## Boundaries

- **Nothing here is about your agent's behaviour.** The example answers with a fixed echo (or a
  DeepSeek call, if you configure a key) so the transport can be proven before any credential
  exists. What the agent actually does — read a repo, update a ticket, summarise — belongs in your
  own agent repository, driven from `answerHandoff()`.
- **The example may carry npm dependencies; the extension may not.** `examples/pi-durable-cf/` has
  its own `package.json` and `node_modules`. Nothing there sets a precedent for pi-xfer, and
  rivetkit stays out of the extension's dependency list.
- **Documented scope stops at the round trip:** send in, answer, arrive back, verified by hand. Cron
  wake-ups, batching, cross-node summarising and scheduled work are platform-specific and not
  covered — a serverless actor is a poor source by design.
- **The Worker never creates its own actor.** A serverless pool has no runner to host one until
  something is enqueued, so the first delivery is what brings the row up. Treat a row in
  `/xfer mesh list` as presence, never as proof the node can receive.

If those limits fit how you want to use it, the procedure is short and the payoff is a node that
exists only when someone needs it.
