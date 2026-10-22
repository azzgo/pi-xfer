# A serverless Cloudflare node, joined to the mesh

> **Experimental, not a supported feature.** No SLA, no network test in CI, no promise across
> rivetkit majors. This `package.json` and its `node_modules/` belong to the example — the
> **pi-xfer extension itself ships no runtime dependencies**, and nothing here sets a precedent for
> adding one. If the example breaks on a future rivetkit, the extension is unaffected.

A **serverless mesh node**: it runs on Cloudflare, it is reachable as an ordinary mesh node, it answers
when there is work, and it costs nothing while idle. The Worker and its `xfer-instance` actor are how
it joins the mesh — the transport, not the point.

**The agent behind it is a stub.** Inside the Durable Object, `answerHandoff()` echoes the handoff —
or makes one model call if `DEEPSEEK_API_KEY` is set. No agent framework runs here: this example
proves the *transport* (a node that exists only while there is work), and the agent half is the seam
you replace in your own repository.

Read this file to run it. Read `VERIFICATION.md` before you point it at a real engine.

## Start here: the four files that matter

```
src/worker.ts          the two Cloudflare entry points — the Worker and the Durable Object class
src/app.ts             every route, in Hono; this is the whole HTTP surface
src/agent-do.ts        the agent: answerHandoff(), and the memory that makes redelivery idempotent
src/mesh-registry.ts   the mesh engine (wasm registry) behind `app.all("*")`
```

Everything else is a detail those four lean on:

| File | Role |
|---|---|
| `src/mesh-actor.ts` | the `xfer-instance` actor — the same state, queue and actions the extension runs |
| `src/node-config.ts` | what this node is configured as: every env var name, and the base path |
| `src/pool-config.ts` | the pool record: timing in seconds, one spelling, and the engine's body for the bootstrap curl |
| `src/reply-client.ts` | where a reply is enqueued: the sender's own queue, on the engine |
| `app.test.ts` | every route, driven with Hono's own `app.fetch` — no workerd, no engine |
| `agent-do.test.ts` | the answer: echo, model fallback, redelivery |
| `node-config.test.ts` | the configuration defaults and the pool record both writers spell |

## The shape

```
laptop (pi, mesh up)          Cloudflare
      │                          ┌───────────────────────────────────────┐
      │  handoff queue msg       │ Worker        src/worker.ts            │
      ├─────────────────────────▶│  Hono app     src/app.ts               │
      │                          │    GET  /            what is this node │
      │                          │    GET  /health                        │
      │                          │    POST /agent/answer                  │
      │                          │    ALL  * ──▶ mesh registry [wasm]     │
      │                          │                  └─ xfer-instance     │
      │                          │                       state  ── engine SQLite
      │                          │                       queue  ── "handoff"
      │                          │                       run    ── hands off
      │                          │                              │         │
      │                          │                              ▼         │
      │                          │                    Durable Object      │
      │                          │                      agent memory ── DO storage
      │                          │                      answerHandoff()   │
      │                          │                              │         │
      │  handoff queue msg       │                              ▼  engine │
      ◀─────────────────────────┤                enqueue into sender's queue
      │                          └───────────────────────────────────────┘
```

One app, two entry points. The Worker routes a request through Hono; the Durable Object does the
same, with its own storage merged into the env. That is why the answer logic, the echo, and the
reply path have exactly one implementation: `POST /agent/answer` is the same code in both places.

**Hono is not decoration.** The mesh registry is a single `handler(request)` — a wasm object that
owns a path prefix and nothing else. Hono is what makes "the registry owns `/api/rivet/*`, and I own
three routes next to it" a two-line statement instead of hand-rolled URL matching. Any serverless
platform that takes a `fetch` handler works this way; this example is the smallest version of it.

## The four things worth learning here

1. **Reply on receipt.** The actor's run loop hands the message to the Durable Object and moves on;
   it never awaits the agent. A serverless actor can be torn down the moment the run loop yields, so
   anything that must survive goes through the DO, not through a function's stack.
2. **Two persistence layers, never blurred.** rivetkit's actor state lives in the engine and holds
   the node `description` and the delivered-id window. Durable Object storage lives in Cloudflare and
   holds what the *agent* needs — which handoffs it received and what it answered. Nothing on the
   mesh reads DO storage, and actor state never stands in for it.
3. **Ack means accepted, not answered.** The queue message is acked as soon as it is recorded. If the
   DO then dies, the mesh will not redeliver — which is why `VERIFICATION.md` treats "accepted but
   never answered" as its own failure mode.
4. **Idempotent by id, not by luck.** A redelivered handoff is answered with the id it produced the
   first time and *no second reply is sent* (`Answer.first`). That is one line in `app.ts`, and it is
   tested.

`answerHandoff()` in `src/agent-do.ts` is the one function to replace. Without a `DEEPSEEK_API_KEY`
it echoes — that echo is how the mesh path gets proven before any credential exists.

## Run it locally, with no account

```bash
cd examples/cf-serverless-node
npm install
npm test                     # 18 tests, hermetic: no workerd, no engine, no network
npx wrangler dev             # local workerd
curl localhost:8787/         # {"node":"cf-node","mesh":"/api/rivet","routes":[...]}
curl localhost:8787/health   # {"ok":true,"node":"cf-node","engine":false}
```

`engine: false` is honest: no `MESH_ENDPOINT` is set, so nothing talks to an engine. The mesh path
(`/api/rivet/*`) answers 503 `Serverless pool is not configured` until an engine can be reached — that
is the registry's own refusal, not a bug in this Worker.

## Run it on the mesh

Proven once on a real deployment — `VERIFICATION.md` has the recorded result and the nine corrections
that came out of it. The order below is the order that works; every step marked 🔴 reaches real
infrastructure, which is a human decision each time.

1. **Pin the engine.** `rivetdev/engine:2.3.26`, matching this example's rivetkit, with
   `topology.datacenters[].public_url` set to the engine's public hostname (a config file; it cannot
   come from env vars). Unpinned, the serverless start payload disagrees; unset, the engine answers
   `endpoint_mismatch`.
2. 🔴 **Register the pool out of band, before the first deploy.** The pool is named `cloudflare` by
   default (`POOL_NAME`); the body points at the **Worker**, never the engine, and carries both
   timing fields in **seconds**:
   `{"datacenters":{"default":{"serverless":{"url":"https://<worker-domain>/api/rivet","headers":{},"request_lifespan":30000,"drain_grace_period":600}}}}`.
   Those numbers live in `SERVERLESS_POOL_TIMING` (`src/pool-config.ts`), which is also what the
   registry's `configurePool` writes — `runnerConfigBody()` gives you the exact JSON.
3. **Give the Worker a domain the engine can reach.** `*.workers.dev` is unreachable from an engine
   on a mainland-China network, and it is the engine that calls the Worker. Uncomment `routes` in
   `wrangler.toml` — a top-level key, **above** `[vars]` — and set `WORKER_PUBLIC_URL` to the same
   host. Unset, every URL is the request's own origin, which works but cannot be predicted by a cold
   engine.
4. **Configure and deploy.** `npx wrangler secret put MESH_ENDPOINT` (the engine), keep
   `RIVET_ENDPOINT`/`RIVET_NAMESPACE` in `[vars]` agreeing with it, then `npm run check &&
   npx wrangler deploy`, then `curl https://<worker-domain>/health` → `{"ok":true,...,"engine":true}`.
5. 🔴 **First send from a bare rivetkit client.** The engine starts a serverless runner only when
   there is something to deliver, so a cold pool always reads `○ no runner`, and `mesh send`'s
   pre-check refuses exactly that. `VERIFICATION.md` step 4 has the `node -e` script; `mesh send` is
   the path for a warm pool.

The node's actor is created by the first delivery, never by the Worker on its own — a serverless pool
has no runner to host it until something is enqueued. An empty `/xfer mesh list` before step 5 is
expected, not a symptom.

## Bundling, which a plain `wrangler deploy` already handles

The parts that are not obvious, in case you bundle yourself:

- **Inject the wasm binding.** rivetkit resolves it through a deliberately opaque specifier so
  bundlers never capture it; `setup({ wasm: { bindings, initInput } })` passes it explicitly, and
  `initInput` (the imported `.wasm`, a `WebAssembly.Module` under wrangler) is what a Worker needs
  instead of the default `fetch(new URL(...))`.
- **`compatibility_flags: ["nodejs_compat"]`.** rivetkit's logger (pino) imports Node builtins at
  module scope even under wasm.
- **`async_hooks` and `module` stay external** if you bundle by hand; wrangler does this for you.

## Why this is worth having at all

Not because it is reachable — plenty of things are. Because it is the first mesh node whose existence
does not need to be paid for: it is absent until there is work, then present, then absent again. The
scheduling and what the agent actually does belong to your own agent repository, which is why this
example stops at the round trip.
