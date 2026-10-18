# A Cloudflare Worker as one mesh node

> **Experimental, not a supported feature.** No SLA, no network test in CI, no promise across
> rivetkit majors. This `package.json` and its `node_modules/` belong to the example — the
> **pi-xfer extension itself ships no runtime dependencies**, and nothing here sets a precedent for
> adding one. If the example breaks on a future rivetkit, the extension is unaffected.

The mesh has always been a set of machines that stay on. This example adds the first kind that does
not: a Worker hosting one `xfer-instance` actor, bridged to a Durable Object that runs the agent. It
wakes when there is work, answers, and otherwise costs nothing.

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
| `src/agent-do.ts` | the Durable Object: the agent's memory, the echo, the DeepSeek seam |
| `src/worker.ts` | the Worker: registry in wasm, the actor, the DO, the reply path |
| `agent-do.test.ts` | the only part under `npm test` — echo, redelivery, model fallback |
| `VERIFICATION.md` | the manual closed-loop procedure (the one live-deployment exception) |
| `wrangler.toml` | DO binding, migration, the vars and secrets |

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

## Run it

1. Read `VERIFICATION.md` and decide whether to run it — it reaches a real deployment, which is a
   human decision every time.
2. `npm install && npx wrangler deploy`
3. Set the secrets it lists, then register the serverless pool out of band. The pool is named
   `cloudflare` by default (`POOL_NAME` in `wrangler.toml`, read through `poolName()`); rename it in
   that one place and the register command must carry the same name. **No pi-xfer command may be
   pointed at it**: `ensureRunnerPool()` hardcodes `{ normal: {} }` and cannot create a serverless one.
4. Follow `VERIFICATION.md` from step 3.

With no `DEEPSEEK_API_KEY` the node echoes. That is not a stub — it is how the mesh path gets proven
before any credential exists.

## Why this is worth having at all

Not because it is reachable — plenty of things are. Because it is the first mesh node whose
existence does not need to be paid for: it is absent until there is work, then present, then absent
again. The scheduling and what the agent actually does belong to your own agent repository, which is
why this example stops at the round trip.
