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

---

## 0. Prerequisites

| Need | Why |
|---|---|
| A mesh engine reachable over **public HTTPS** | the engine calls back into the Worker; a `localhost` engine cannot |
| A local pi node already online (`/xfer mesh up`) | it is the sender whose reply you will read |
| A Cloudflare account + `wrangler login` | deploy the Worker |
| **No DeepSeek key** for the first pass | the echo path must be proven before any credential exists |

The engine being public is the deployment-shape change ADR 0013's serverless exception accepts. See
`docs/guides/mesh-setup.md` for the transport-security posture.

## 1. Register the pool, out of band 🔴

`ensureRunnerPool()` hardcodes `{ normal: {} }`, so it **cannot** create a serverless pool — and no
command in this repository may be pointed at one. Register it with the engine's own API, once:

The example joins the pool `cloudflare` by default — that value lives in `wrangler.toml` as
`POOL_NAME`, and the Worker reads it from there (`poolName` in `src/worker.ts`). To use a different
name, change it in `wrangler.toml` **and** below: this runner-config name is the one string that has
to match on both sides.

```bash
# Replace the engine host/token, and <pool> only if you renamed POOL_NAME.
# POOL_NAME defaults to: cloudflare
curl -sS -X PUT "https://<engine-host>/runner-configs/cloudflare?namespace=<ns>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"serverless":{"url":"https://<worker>.workers.dev/api/rivet","headers":{}}}}}'
```

Then confirm the engine holds it (a read against the deployment — also 🔴):

```bash
curl -sS "https://<engine-host>/runner-configs?namespace=<ns>" -H "Authorization: Bearer <token>" | jq .
```

The name must equal `POOL_NAME` in `wrangler.toml` (default `cloudflare`). The Worker's registry
declares it via `configurePool`, so the actor is placed in that pool when the registry starts;
`pi-xfer` itself never needs to learn the name.

## 2. Deploy the Worker 🔴

```bash
cd examples/cf-actor
npm install
npx wrangler secret put MESH_ENDPOINT     # https://<engine-host>
npx wrangler secret put MESH_NAMESPACE    # if your engine uses one
npx wrangler secret put MESH_TOKEN        # if your engine requires one
npx wrangler deploy
```

Set `WORKER_PUBLIC_URL` in `wrangler.toml` to the URL Wrangler printed, then deploy once more so
`serverless.publicEndpoint` matches reality. A mismatch shows up as the engine never reaching the
node, which looks identical to "the node does not exist".

Healthy check (no mesh involvement):

```bash
curl -sS https://<worker>.workers.dev/health
# {"ok":true,"node":"cf-node"}
```

## 3. Prove the node is on the mesh 🔴

From the local machine with the mesh up:

```bash
/xfer mesh list
```

**Pass**: a row for `cf-node` appears, and its state is not "NoRunner" — the serverless pool holds
the Worker. **Fail**: no row at all means the registry never started (check `wrangler tail`), and a
`NoRunner` row means step 1's pool was not registered where the actor was placed.

## 4. Send a handoff into it 🔴

```bash
cat > /tmp/cf-probe.md <<'EOF'
# Round-trip probe

Confirm you received this and reply with the handoff id.
EOF

xfer-adapterd mesh send cf-node /tmp/cf-probe.md "round-trip probe" --kind task
```

This prints the handoff id it minted, e.g. `mvddu4h2-vh8wpo`. **Write it down** — step 5 confirms it.

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

**Fail — accepted but never answered.** The local send reported success, `wrangler tail` shows no DO
call. That is `forwardToAgent` losing the handoff, not the mesh: the actor acked the queue message
before the DO recorded it.

**Fail — answered twice.** Two inbound lines for one probe. The DO's own dedupe should make this
impossible; seeing it means the DO was serving two instances (check `NODE_NAME` is constant and the
DO migration is `new_sqlite_classes`).

## 6. Optionally, the model branch 🔴

Only after step 5 passes. Set the key and repeat step 4:

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DEEPSEEK_MODEL   # optional, defaults to deepseek-chat
npx wrangler deploy
```

The reply is now the model's answer instead of the echo. A model failure still answers — with the
echo plus a line naming the failure — because an unanswered handoff reads on the mesh as lost.

**This costs money per handoff.** It is the last step on purpose.

## 7. Record the result

Note the date, the rivetkit version, the engine version, and which steps passed. The framing that
will churn is rivetkit's serverless interface, so a later reader needs to know exactly what was
proven and against what.

## What this does not prove

- **Nothing about scale or load.** One probe, one reply.
- **Nothing about wake-up latency.** A serverless actor that is asleep is woken by the engine's own
  schedule; the example does not measure it.
- **Nothing across rivetkit majors.** The example pins `2.3.26` and makes no promise past it.
- **Nothing about this node as a source of work on a schedule.** Per the milestone's scope line, the
  example stops at the round trip.
