# Verify the loop, by hand

**This is the one place in the repository where verification touches a live deployment**, and it
is a deliberate, recorded exception (`AGENTS.md` — "Never test against a live deployment"). A
Durable Object has no local stand-in, so the round trip cannot be proven by `npm test` or by a
script. It is proven once, by a human, reading the output.

Read the whole section before running anything. **Nothing below runs from CI, from a test, or from
a script in this repository.** Steps marked 🔴 reach real infrastructure.

What `npm test` *does* cover: the Durable Object's answer logic (`agent-do.test.ts`) — echo,
redelivery, the model fallback — against in-memory storage. That is the code that would silently
send two answers or none. Everything else here is the mesh path itself.

> **Recorded result (2026-10-18).** The loop was closed once, against rivetkit `2.3.26`, engine
> `rivetdev/engine:2.3.26` behind a Cloudflare Tunnel, Worker on a custom domain:
> `mesh.log` carried `mesh inbound id=mvprobe03-cfround-echo from=cf-node`, and the local pi
> session rendered the echo. Every correction below came out of that run — the commands here are the
> ones that actually worked, not the ones that looked right first.

---

## 0. Prerequisites

| Need | Why |
|---|---|
| A mesh engine reachable over **public HTTPS** | the engine calls back into the Worker; a `localhost` engine cannot |
| **Engine pinned to `rivetdev/engine:2.3.26`** | `:latest` and rivetkit `2.3.26` disagreed on the serverless start payload (empty body, `payload too short`); pinning removed it. See the troubleshooting table |
| Engine `topology.public_url` set to the public hostname | at `/start` the engine checks the identity it advertises against its own endpoint and answers `endpoint_mismatch` otherwise. Config file below |
| A Worker URL reachable **from the engine** (a custom domain) | `*.workers.dev` timed out from an engine on a mainland-China network. See §2 |
| A local pi node already online (`/xfer mesh up`) | it is the sender whose reply you will read |
| A Cloudflare account + `wrangler login` | deploy the Worker |
| **No DeepSeek key** for the first pass | the echo path must be proven before any credential exists |

The engine being public is the deployment-shape change ADR 0013's serverless exception accepts. See
`docs/guides/mesh-setup.md` for the transport-security posture.

**Engine topology.** The engine advertises its own identity when a serverless runner starts. Nested
`topology` cannot be set through environment variables (the engine author confirmed it), so mount a
config file — for the compose file, `-v /etc/rivet/config.json:/etc/rivet/config.json:ro`:

```json
{
  "topology": {
    "datacenter_label": 1,
    "datacenters": [
      {
        "name": "default",
        "datacenter_label": 1,
        "is_leader": true,
        "peer_url": "http://127.0.0.1:6421",
        "public_url": "https://<engine-host>"
      }
    ]
  }
}
```

`public_url` is what the runner compares the engine's advertised endpoint against — it must be the
hostname clients use, scheme included, no trailing slash. Leaving it unset is the usual cause of
`endpoint_mismatch` on the first send.

## 1. Register the pool, out of band 🔴

`ensureRunnerPool()` hardcodes `{ normal: {} }`, so it **cannot** create a serverless pool — and no
`pi-xfer` command may be pointed at one. Register it with the engine's own API, once:

The example joins the pool `cloudflare` by default — that value lives in `wrangler.toml` as
`POOL_NAME`, and the Worker reads it from there (`poolName` in `src/agent-do.ts`). To use a different
name, change it in `wrangler.toml` **and** below: this runner-config name is the one string that has
to match on both sides.

```bash
# Replace the engine host/token and the Worker's public URL; <pool> only if you renamed POOL_NAME.
# POOL_NAME defaults to: cloudflare
curl -sS -X PUT "https://<engine-host>/runner-configs/cloudflare?namespace=<ns>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"serverless":{
        "url":"https://<worker-domain>/api/rivet",
        "headers":{},
        "request_lifespan":30000,
        "drain_grace_period":600}}}}'
```

Four things about that body:

- **`url` is the Worker's public URL plus `/api/rivet`** — the address the engine POSTs `/start`
  to. It is *not* the engine's endpoint. The Worker's own `configurePool` carries the same value, so
  keep them identical; a Worker that points at the engine makes the engine call itself, and the
  attempt fails as an empty `serverless start payload`.
- **Both fields are in seconds** — the engine's unit, and RivetKit's unit in
  `requestLifespan`/`drainGracePeriod`. There is no milliseconds anywhere: `30000` means
  thirty thousand seconds. Both numbers live in one place, `SERVERLESS_POOL_TIMING` in
  `src/pool-config.ts`, and the Worker's own registration uses them verbatim.
- **`drain_grace_period` must be present and strictly less than `request_lifespan`.** Omitted, the
  engine applies its default of 1800 s, and a lifetime below that is refused with
  `drain_grace_period must be less than request_lifespan` — an *illegal config*, not a slow start.
  `600` is the example's value; anything under `30000` and ≥ 0 is accepted.
- **Register first, then deploy.** The out-of-band config is what bootstraps a cold pool; the
  registry's own `configurePool` upsert only runs when the engine starts a runner, which needs a
  runner to exist. Both write the same record, and the Worker only re-writes it when what the
  engine holds differs from what it would write — one GET per isolate on a warm pool.

Then confirm the engine holds it (a read against the deployment — also 🔴):

```bash
curl -sS "https://<engine-host>/runner-configs/cloudflare?namespace=<ns>" \
  -H "Authorization: Bearer <token>" | jq .
```

`pi-xfer` itself never needs to learn the pool name; the actor is placed in it when the registry
starts.

## 2. Deploy the Worker 🔴

Before deploying, `npm run check` runs `wrangler deploy --dry-run`: it parses `wrangler.toml`,
resolves the Durable Object binding and vars, and builds the bundle locally — nothing is uploaded. A
config typo surfaces there instead of halfway through the real deploy.

**Read the bindings it prints.** `wrangler.toml` is **TOML**, so every top-level key must come before
the first `[table]` header: a `routes` block written after `[vars]` becomes an ordinary variable
named `routes` and the custom domain is never created — with no warning at all.

```bash
cd examples/pi-durable-cf
npm install
npm run check                             # local config + build check, no upload
npx wrangler secret put MESH_ENDPOINT     # https://<engine-host>
npx wrangler secret put MESH_NAMESPACE    # if your engine uses one
npx wrangler secret put MESH_TOKEN        # if your engine requires one
npx wrangler deploy
```

`RIVET_ENDPOINT` / `RIVET_NAMESPACE` in `[vars]` are the same engine, published on RivetKit's own
env-var channel — parts of the wasm runtime read that instead of the config object, so the two must
agree. The pool's timing is deliberately **not** a var: it lives in `SERVERLESS_POOL_TIMING` in
`src/pool-config.ts` so the in-Worker registration, `configurePool` and this step's curl cannot drift
apart. Change it there and in step 1 together.

**A custom domain, not `workers.dev`.** An engine on a mainland-China network cannot connect to
`*.workers.dev` (the connection times out), and it is the engine that must reach this Worker. Put the
Worker on a domain in your Cloudflare account and set:

- `routes = [{ pattern = "<your-domain>", custom_domain = true }]` in `wrangler.toml`
- `WORKER_PUBLIC_URL = "https://<your-domain>"` (no trailing slash)
- the runner-config `url` from step 1 — `https://<your-domain>/api/rivet`

All three are the same host. If a domain you expected is missing after a deploy, wrangler 4.0.0 does
not always report it: check it directly (dashboard → Workers → your Worker → Settings → Domains &
Routes, or `PUT /accounts/<id>/workers/domains` on the Cloudflare API) and look for the pattern
above being present but *not* enabled.

Set `WORKER_PUBLIC_URL` to the URL Wrangler printed, then deploy once more so
`serverless.publicEndpoint` matches reality. A mismatch shows up as the engine never reaching the
node, which looks identical to "the node does not exist".

Healthy check (no mesh involvement — note it prints `engine`):

```bash
curl -sS https://<your-domain>/health
# {"ok":true,"node":"cf-node","engine":true}
```

## 3. Prove the node is on the mesh 🔴

From the local machine with the mesh up:

```bash
/xfer mesh list
```

**Pass**: a row for `cf-node` appears, and its state is not `○ no runner` — the serverless pool holds
the Worker.

**If no row appears at all**, the actor does not exist yet, and nothing in this example can be
trusted to have created it. The Worker's `registerSelf` (a `getOrCreate` fired under
`ctx.waitUntil` on its first call) is **unproven** — in the recorded run the actor was created by the
out-of-band call in step 4, so its presence in the listing proved nothing about self-registration.
Run step 4's client once (`getOrCreate` creates the actor as a side effect), then look again. A row
that appears *only* after that is a row step 4 created.

**A `○ no runner` row** means step 1's pool was not registered where the actor was placed — check the
pool name on both sides. **A `wrangler tail` with no `/api/rivet` requests** during any of this means
the engine never reached the Worker: go back to §2's custom-domain check.

## 4. Send a handoff into it 🔴

The engine only starts a serverless runner when there is something to deliver. **On a cold pool the
first send therefore has to come from a bare rivetkit client** — the `xfer-adapterd mesh send` path
does a fail-closed pre-check that refuses a target whose pool has no live runner (`○ no runner`, by
design, no override). The client below creates the actor if it does not exist and enqueues the
handoff; the actor's arrival is what makes the engine start the runner.

```bash
cd examples/pi-durable-cf          # for rivetkit 2.3.26 on disk
cat > /tmp/cf-probe.md <<'EOF'
# Round-trip probe

Confirm you received this and reply with the handoff id.
EOF

MESH_ENDPOINT=https://<engine-host> MESH_NAMESPACE=<ns> MESH_TOKEN=<token> \
node --input-type=module -e '
const { createClient } = await import("rivetkit/client");
const fs = await import("node:fs");
const id = `probe-${Date.now()}`;
const client = createClient({
  endpoint: process.env.MESH_ENDPOINT,
  ...(process.env.MESH_NAMESPACE ? { namespace: process.env.MESH_NAMESPACE } : {}),
  ...(process.env.MESH_TOKEN ? { token: process.env.MESH_TOKEN } : {}),
});
await client.getOrCreate("xfer-instance", ["cf-node"], { poolName: "cloudflare" }).resolve();
await client.get("xfer-instance", ["cf-node"]).send("handoff", {
  id,
  from: "<your-local-node-name>",
  to: "cf-node",
  summary: "round-trip probe",
  document: fs.readFileSync("/tmp/cf-probe.md", "utf-8"),
});
console.log(id);
'
```

That prints the handoff id it minted. **Write it down** — step 5 confirms it.

Once the runner is warm, the ordinary path is `xfer-adapterd mesh send`:

```bash
xfer-adapterd mesh send cf-node /tmp/cf-probe.md "round-trip probe" --kind task
```

Its pre-check passes only while the pool has a live runner, so this is the *second* send in a
session, not the first. `--no-preflight` skips the check but not the cold-pool problem: with no
runner the enqueue waits up to 30 s and reports failure, which says nothing about whether it will be
delivered.

## 5. Read the reply, and pair the ids

Two places to look, and both matter:

```bash
# The local mesh log: the inbound line carries the reply's id and the sender.
tail -n 20 ~/.pi/xfer/mesh.log | grep "mesh inbound"
```

**Pass — the loop closed.** An inbound line whose `id` is `<the id from step 4>-echo`, whose `from`
is `cf-node`, and whose `to` is your local node. In the local pi session the handoff appears as an
incoming notification carrying the echo document.

**Pass — the agent layer, if you want to see it.** `wrangler tail` shows the DO call; the echo text
contains `In reply to: handoff <the id from step 4>`.

**Fail — accepted but never answered.** The send reported success, `wrangler tail` shows no DO call.
That is `forwardToAgent` losing the handoff, not the mesh: the actor acked the queue message before
the DO recorded it.

**Fail — answered twice.** Two inbound lines for one probe. The DO's own dedupe should make this
impossible; seeing it means the DO was serving two instances (check `NODE_NAME` is constant and the
DO migration is `new_sqlite_classes`).

## 6. Optionally, the model branch 🔴

Only after step 5 passes. Set the key and repeat step 4 (with `mesh send` — the runner is warm now):

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DEEPSEEK_MODEL   # optional, defaults to deepseek-chat
npx wrangler deploy
```

The reply is now the model's answer instead of the echo. A model failure still answers — with the
echo plus a line naming the failure — because an unanswered handoff reads on the mesh as lost.

**This costs money per handoff.** It is the last step on purpose.

## 7. Record the result

Note the date, the rivetkit version, the engine image tag, the Worker's domain shape (custom domain
vs `workers.dev`), and which steps passed. The framing that will churn is rivetkit's serverless
interface, so a later reader needs to know exactly what was proven and against what.

## When it does not work

Every row below was hit for real during the recorded run; the signal column is what you actually
see, not what you would expect.

| Signal | Cause | What to do |
|---|---|---|
| `wrangler deploy` succeeds but the custom domain does not exist | `routes` written after `[vars]` in `wrangler.toml` — TOML swallowed it as a variable | move every top-level key above the first `[table]`; confirm with `npm run check` (it prints vars) |
| `failed to resolve host` / engine cannot reach the Worker | `*.workers.dev` from a mainland-China engine, or a `custom_domain` route wrangler 4.0.0 reported as added but never created | use a custom domain in your account; verify the route in the dashboard, not from the deploy output |
| Engine reports `serverless start payload too short` (empty body) | the pool's `url` points at the **engine**, so the engine POSTs `/start` to itself | `url` must be the Worker's `<WORKER_PUBLIC_URL>/api/rivet`, in *both* the runner-config and `configurePool` |
| Engine reports a payload/protocol error on `/start` only | engine image ≠ rivetkit version (e.g. `engine:latest` with rivetkit `2.3.26`) | pin the engine image to `2.3.26` (checklist §0) |
| Engine answers `endpoint_mismatch` when starting the runner | no `topology.datacenters[].public_url` (or it is not the hostname clients use) | mount the config file from §0 and restart the engine |
| Worker answers 500 with an **empty** message | a config/protocol error inside `registry.handler` | `curl <WORKER_PUBLIC_URL>/api/rivet/health` (and `wrangler tail`) — the Worker now returns `err.message` in the 500 body precisely so this is readable |
| First request after a deploy fails with a Zod/config error | registry built without `endpoint` (no `MESH_ENDPOINT` secret and no `RIVET_ENDPOINT` var) | set one of them; `configurePool` cannot register without it |
| Engine returns 400 `drain_grace_period must be less than request_lifespan` | the pool body was written without a grace period (engine default 1800 s) or with one ≥ the lifespan. **This is the Worker's own registration, not your step-1 curl** — the step-1 body above is already legal | the timing lives in `SERVERLESS_POOL_TIMING` (`src/pool-config.ts`), seconds; keep `drainGracePeriod < requestLifespan` and re-deploy. The engine keeps the last good config, so this is repairable without a `DELETE` |
| `wrangler tail` shows `in-Worker pool registration failed` on **every** invocation, and Cloudflare starts answering `Too many subrequests` | the registration retried a rejection: a 400 is not transient, so retrying only spends the invocation's subrequest budget (41 attempts did). It also starves the engine's actor wake-up scheduling while it lasts, so unrelated sends to this node time out | already fixed: the Worker attempts registration **at most once per isolate** and never retries. If you see it, you are running an older build — redeploy; then check the 400's message (row above) instead of retrying |
| `mesh send` refuses: `no runner in pool "cloudflare"` | correct behaviour on a cold serverless pool — the engine starts runners only for pending deliveries | first send from a bare client (§4), or wait, then retry |
| Actor is stuck: `/actors` shows an `error` no restart clears | the actor record's `error` is sticky — it is not cleared when a runner appears | destroy and recreate: `DELETE /actors/<id>?namespace=<ns>`, then `getOrCreate` again (§4 does it) |
| Listing shows the node but the runner never starts | self-registration is unproven; the actor may exist with no runner behind it | treat the listing as presence only; the runner arrives on the first delivery (§4) |
| `wrangler tail` shows `/api/rivet/start` repeating with 503 | in-Worker/out-of-band pool registration still failing | read the tail's `in-Worker pool registration failed` line, then re-run step 1 |

## What this does not prove

- **Nothing about self-registration.** `registerSelf` exists and is wired, but the recorded run's
  actor came from an out-of-band `getOrCreate`; a node appearing in a listing has not been shown to
  come from the Worker's own call.
- **Nothing about scale or load.** One probe, one reply.
- **Nothing about wake-up latency.** A serverless actor that is asleep is woken by the engine's own
  schedule; the example does not measure it.
- **Nothing across rivetkit majors.** The example pins `2.3.26` and makes no promise past it.
- **Nothing about this node as a source of work on a schedule.** Per the milestone's scope line, the
  example stops at the round trip.
