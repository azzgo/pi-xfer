# A Pi Durable agent on Cloudflare, joined to the mesh

> **Experimental, not a supported feature.** No SLA, no network test in CI, no promise across
> rivetkit majors. This `package.json` and its `node_modules/` belong to the example — the
> **pi-xfer extension itself ships no runtime dependencies**, and nothing here sets a precedent for
> adding one. If the example breaks on a future rivetkit, the extension is unaffected.

The mesh has always been a set of machines that stay on. This example adds the first kind that does
not: a **Pi Durable agent** running on Cloudflare, reachable as an ordinary mesh node. It wakes when
there is work, answers, and otherwise costs nothing. The Cloudflare Worker and its `xfer-instance`
actor are how that agent joins the mesh — the transport, not the point.

Two things are worth saying plainly about what that buys and what it costs:

- **Good destination, poor source.** A serverless node has no read side and no presence while asleep.
  It is the right place to send buffered work to; it is the wrong place to expect a question
  answered on demand.
- **The engine must be publicly reachable**, because it calls back into the Worker. That is a
  deployment-shape change, not a flag — ADR 0013's serverless exception accepts it explicitly.

## The shape

```
laptop (pi, mesh up)          Cloudflare
      │                          ┌──────────────────────────────────────┐
      │  handoff queue msg       │ Worker                               │
      ├─────────────────────────▶│  registry.handler()  [wasm]          │
      │                          │   └─ xfer-instance actor             │
      │                          │        state  ── engine-side SQLite  │
      │                          │        queue  ── "handoff"           │
      │                          │        run    ── hands off, never awaits
      │                          │              │                       │
      │                          │              ▼                       │
      │                          │        Durable Object                │
      │                          │          agent memory ── DO storage  │
      │                          │          answerHandoff()            │
      │                          │              │                       │
      │  handoff queue msg       │              ▼  rivetkit client       │
      ◀─────────────────────────┤        enqueue into sender's queue   │
      │                          └──────────────────────────────────────┘
```

| File | Role |
|---|---|
| `src/mesh-actor.ts` | the `xfer-instance` actor — the same state, queue and actions the extension runs |
| `src/agent-do.ts` | the Durable Object (the agent's memory, the echo, the DeepSeek seam) and the `Env` |
| `src/worker.ts` | the Worker: registry in wasm, the actor, the DO, the reply path, pool registration |
| `src/pool-config.ts` | the pool body and timing (seconds) — dependency-free so it is testable |
| `agent-do.test.ts` | the answer logic: echo, redelivery, model fallback |
| `pool-registration.test.ts` | the pool body: grace period below lifespan, no re-write when it matches |
| `VERIFICATION.md` | the manual closed-loop procedure (the one live-deployment exception) |
| `wrangler.toml` | DO binding, migration, `routes`, the vars and secrets |

## Two persistence layers, never blurred

This is the part that is easy to get wrong, so it is stated once and then obeyed:

| Layer | Lives | Holds | Survives |
|---|---|---|---|
| **rivetkit actor state** | the engine, in remote SQLite (forced under wasm) | the node `description`, the delivered-id dedupe window | node restart, reconnect, actor sleep |
| **Durable Object storage** | Cloudflare | what the *agent* needs — which handoffs it received and what it answered | request boundaries, cold starts |

Nothing on the mesh reads DO storage, and actor state may never stand in for it. The actor is the
transport's; the DO is the agent's.

## The discipline a serverless actor must follow

1. **Reply on receipt.** The run loop hands the message to the DO and moves on; it never awaits the
   agent. A serverless actor can be torn down the moment the run loop yields, so anything that must
   survive goes through the DO, not through a function's stack.
2. **No state across calls.** There is no long-lived process to keep a variable in. Anything needed
   later is written to DO storage at the time it is learned, not reconstructed later.
3. **Ack means accepted, not answered.** The actor has acked the queue message as soon as it is
   recorded. If the DO then dies, the mesh will not redeliver — which is why `VERIFICATION.md`
   treats "accepted but never answered" as its own failure mode.

## Bundling: what is actually required

This was the untested risk in the design, so it is written down concretely. `runtime: "wasm"` with
`registry.handler()` is the only path — npm ships the `--target web` binding, and the
`pkg-cloudflare` target in that package is a build script rather than a published artifact. What the
build needs:

- **Inject the wasm binding yourself.** rivetkit resolves it through a deliberately opaque specifier
  (`["@rivetkit","rivetkit-wasm"].join("/")`, so bundlers never capture it). Pass it explicitly:

  ```ts
  import * as wasmBindings from "@rivetkit/rivetkit-wasm";
  import wasmModule from "@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm";
  setup({ runtime: "wasm", wasm: { bindings: wasmBindings, initInput: wasmModule }, /* … */ });
  ```

  The default loader does `fetch(new URL(…_bg.wasm, import.meta.url))`, which a Worker cannot do;
  `initInput` takes the module instead and skips that fetch.
- **`compatibility_flags: ["nodejs_compat"]`.** rivetkit's logger (pino) imports Node builtins at
  module scope even under wasm. Without the flag the bundle fails to resolve `node:events`,
  `node:path`, `fs`, and friends.
- **Two specifiers stay external** if you bundle by hand (`wrangler` handles this for you):
  `async_hooks` and `module` are reachable only from rivetkit's *native* path, which wasm never
  executes.

A plain esbuild pass that produces a working bundle:

```bash
npx esbuild src/worker.ts --bundle --format=esm --platform=neutral --target=es2022 \
  --conditions=workerd,worker,browser --main-fields=browser,module,main \
  --external:async_hooks --external:module --external:'*.wasm' --outfile=dist/worker.js
```

And what the *config* needs, which the bundle will not tell you — the first four are what a live run
taught, and each one fails as something else:

- **`endpoint`** (plus `namespace`/`token`) on the registry config. `configurePool` cannot register
  without it, and `parseConfig` rejects the whole config on the first request — a Zod error at the
  edge, not at deploy time.
- **`configurePool.url` is the Worker's own URL** — `<WORKER_PUBLIC_URL>/api/rivet`, the address the
  engine POSTs `/start` to. Pointing it at the engine makes the engine call itself and fail as an
  empty `serverless start payload`.
- **`serverless.basePath` and that URL path are one string** (`SERVERLESS_BASE_PATH` in
  `src/worker.ts`): the Worker only routes what starts with it, and the engine only treats
  `<basePath>/start` as a start.
- **Everything time-sensitive goes under `ctx.waitUntil`.** `registerSelf` and the in-Worker pool PUT
  are background IO; without it the isolate cancels them the moment the response returns — and
  background work must also be **finite**: the registration attempts once per isolate and never
  retries, because a rejected config is answered with the same 400 forever, and 41 attempts spent
  the whole subrequest budget on a live run.
- `RIVET_ENDPOINT`/`RIVET_NAMESPACE` exist because parts of the wasm runtime read the engine through
  RivetKit's env-var fallback (`getRivetEndpoint`) rather than the config object. They must agree
  with the secrets; drift shows up as an actor the registry cannot see.
- **Pool timing is one constant, in seconds** (`SERVERLESS_POOL_TIMING` in `src/pool-config.ts`),
  because three writers carry it: `configurePool`, the Worker's own runner-config PUT, and the
  out-of-band curl. It is not a `wrangler` var for exactly that reason — a unit slip between them is
  refused as an illegal config (`drain_grace_period must be less than request_lifespan`), not as a
  mistake. `pool-registration.test.ts` pins the invariant.

## Run it

Proven once on a real deployment — see `VERIFICATION.md` for the recorded result and the nine
corrections that came out of it. The order below is the order that works; every step marked 🔴
reaches a real deployment, which is a human decision each time.

1. **Pin the engine.** `rivetdev/engine:2.3.26`, matching this example's rivetkit. `:latest` and
   `2.3.26` disagreed on the serverless start payload (empty body, `payload too short`). Mount
   `/etc/rivet/config.json` with `topology.datacenters[].public_url` set to your engine's public
   hostname, or the engine answers `endpoint_mismatch` when it starts a runner.
2. 🔴 **Register the pool out of band, before the first deploy.** The pool is named `cloudflare` by
   default (`POOL_NAME` in `wrangler.toml`, read through `poolName()`); rename it in that one place
   and the register command must carry the same name. The body points at the **Worker**, never the
   engine, and carries **both** timing fields:
   `{"datacenters":{"default":{"serverless":{"url":"https://<worker-domain>/api/rivet","headers":{},"request_lifespan":30000,"drain_grace_period":600}}}}`.
   Both are in **seconds**, and `drain_grace_period` must be present and strictly smaller than
   `request_lifespan` — omitted, the engine applies its 1800 s default and refuses the pool with
   `drain_grace_period must be less than request_lifespan`. The numbers live in one place,
   `SERVERLESS_POOL_TIMING` (`src/pool-config.ts`), which the Worker's own registration uses too.
   **No pi-xfer command may be pointed at a serverless pool**: `ensureRunnerPool()` hardcodes
   `{ normal: {} }` and cannot create one.
3. **Give the Worker a domain the engine can reach.** `*.workers.dev` is unreachable from an engine
   on a mainland-China network, and it is the engine that calls the Worker. Set `routes` (a
   top-level TOML key, **above** `[vars]`), `WORKER_PUBLIC_URL`, and the runner-config `url` to the
   same host. `npm run check` prints the resolved vars — read them; a `routes` block placed after
   `[vars]` silently becomes a variable and the domain never exists.
4. **Configure and deploy.** `MESH_ENDPOINT` (secret) is the engine; `RIVET_ENDPOINT` and
   `RIVET_NAMESPACE` in `[vars]` are the same engine on RivetKit's own env-var fallback channel, so
   they must agree. Then `npm install && npm run check && npx wrangler deploy`, and
   `curl https://<worker-domain>/health` → `{"ok":true,"node":"cf-node","engine":true}`.
5. 🔴 **First send from a bare rivetkit client.** The engine starts a serverless runner only when
   there is something to deliver, so on a cold pool the target always reads `○ no runner` — and
   `xfer-adapterd mesh send`'s pre-check refuses exactly that, by design. `VERIFICATION.md` step 4
   has the `node -e` script (create-or-get, then enqueue). `mesh send` is the path for a warm pool.

The Worker also registers its own pool (`configurePool`, and an explicit PUT on its first call) so
the record cannot drift from the out-of-band one — but that only runs once a runner exists, which is
why step 2 comes first. Its `registerSelf` (`getOrCreate` under `ctx.waitUntil`) is **unproven**: in
the recorded run the actor was created out of band, so a node in a listing does not yet prove the
Worker self-registered.

With no `DEEPSEEK_API_KEY` the node echoes. That is not a stub — it is how the mesh path gets proven
before any credential exists.

## Why this is worth having at all

Not because it is reachable — plenty of things are. Because it is the first mesh node whose
existence does not need to be paid for: it is absent until there is work, then present, then absent
again. The scheduling and what the agent actually does belong to your own agent repository, which is
why this example stops at the round trip.
