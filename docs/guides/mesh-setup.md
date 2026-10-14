# Mesh setup — cross-machine handoffs

The Mesh is pi-xfer's opt-in transport for delivering handoffs between machines: each pi session that joins becomes a **Node** — one actor in a [RivetKit](https://rivet.dev) actor network, with engine-side discovery and a durable queue, so a handoff reaches a Node on another machine even if it's offline when sent. Local Unix-socket delivery is unaffected and stays the default. Why it's built this way: [`docs/adr/0013`](../adr/0013-xfer-mesh-rivetkit-transport.md).

![Mesh architecture](assets/mesh-architecture.svg)

The static image above is an export of the full interactive diagram — **[Open the interactive diagram](assets/mesh-architecture.html)** for pan/zoom, per-node source references, and a dark theme.

## What you need before starting

The mesh needs a **Rivet control plane** (engine) that every machine can reach. pi-xfer does not ship one; you either use Rivet's hosted cloud or run your own. Once you have it, everything is configured with a single file, `~/.pi/xfer/mesh.config.json`.

## Step 1 — Get a control plane

Two routes. Pick one.

### Route A: Rivet Cloud (hosted)

1. Create a project at [dashboard.rivet.dev](https://dashboard.rivet.dev).
2. Open **Connect** and copy the backend endpoint value — it looks like `https://my-namespace:sk_xxxxx@api.rivet.dev` (namespace and secret token embedded in one URL).
3. That URL is your `endpoint`. You're done — skip to step 2.

Reference: [Rivet Cloud docs](https://rivet.dev/docs/deploy/cloud/).

### Route B: Self-hosted control plane (VPS / single node)

Follow Rivet's guide: [Deploy a self-hosted control plane](https://rivet.dev/docs/deploy/self-host/control-plane/). The quick path is a single Docker container; for persistence pick the file-system (RocksDB) backend on one node — that is the setup pi-xfer's mesh assumes (see ADR 0013).

When the engine is up you need three things from your deployment:

| You need | Where it comes from | Goes into |
|---|---|---|
| **Engine URL** reachable from every machine that will join (e.g. `https://engine.example.com` or `http://203.0.113.10:6420`) | Your reverse proxy / firewall config; the dashboard lives at `<engine-url>/ui` | `endpoint` |
| **Namespace** (e.g. `default`) | Your engine's namespace setup | `namespace` |
| **Token** (the admin token you configured) | Engine configuration — see the [configuration docs](https://rivet.dev/docs/deploy/self-host/control-plane/configuration/) | `token` (may be omitted when the engine is only reachable inside a private network — self-hosted engines accept unauthenticated traffic by default) |

Note: a self-hosted engine may also require a one-time **runner config** per namespace before runners are accepted (see [Workers → Self-hosted](https://rivet.dev/actors/self-host/workers/)):

```bash
curl -X PUT "http://<engine-host>:6420/runner-configs/default?namespace=default" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"normal":{}}}}'
```

If `mesh up` connects and then the node fails to start, this is the usual suspect.

## Step 2 — Configure `~/.pi/xfer/mesh.config.json`

Every machine that joins the mesh writes this file in its own home directory.

| Field | Required | What it is |
|---|---|---|
| `endpoint` | yes | Control-plane URL. You may embed namespace and token as URL auth — `https://my-ns:sk_xxx@api.rivet.dev` — and omit the two fields below (pi-xfer parses them out, verified against `parseMeshConfig` in `mesh-config.ts`). |
| `namespace` | no | The isolated environment your nodes live in. Defaults to `default` engine-side. |
| `token` | no | Auth token for the engine (`sk_…` from Rivet Cloud; the admin token on self-hosted). Sent as `Authorization: Bearer …`. |
| `pool` | no | Envoy/runner pool this host's runners join. Set it to the machine/host name on a mixed fleet so the engine can only schedule this Node's actor onto this machine. Unset = the engine-wide `default` pool, where the engine may place the actor on any host (see [per-host pools](#per-host-runner-pools-mixed-fleets)). |

Minimal example (Route A, URL-auth form — one value copied from the dashboard):

```json
{
  "endpoint": "https://my-namespace:sk_xxxxx@api.rivet.dev"
}
```

Explicit-field example (typical for Route B):

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "your-admin-token"
}
```

### Per-host runner pools (mixed fleets)

By default every machine's runners join the engine-wide `default` pool, so the
engine may schedule *your* Node's actor onto *another* machine's runner — and the
handoff then delivers on the wrong host. On a mixed fleet (a grok bot, an
issue-tracker box, several dev Macs) give each machine its own pool:

1. **Pick a pool name** — use the machine/host name (`workstation`, `dev-mac`).
   The mesh name is still the xfer node name; the pool only decides *where* the
   runner lives.
2. **Add `pool` to that machine's config**:

   ```json
   {
     "endpoint": "https://engine.example.com",
     "namespace": "default",
     "token": "your-admin-token",
     "pool": "workstation"
   }
   ```

3. **Create its runner-config once** — run `/xfer mesh setup` on that machine.
   It parses the config, creates the pool's runner-config on the engine if
   missing (the same PUT the `default` pool got in step 1), and confirms the
   engine is reachable. Idempotent — safe to re-run at any time. The manual
   equivalent is still possible:
   `curl -X PUT "http://<engine>:6420/runner-configs/<pool>?namespace=<ns>" -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"datacenters":{"default":{"normal":{}}}}'`

With `pool` set, this host's runner joins that pool and this Node's actor is
created with `runner_name_selector=<pool>`, so only this machine can receive it.

> **Migrating an existing node**: adding `pool` does **not** move an actor that
> already exists — `getOrCreate` keeps the original placement, so a plain
> `down → up` can look successful while the actor still lives in the old pool.
> `up` now detects this and refuses. To migrate: restart the pi process (an
> extension build from before pool support cannot perform the migration), then
> run `/xfer mesh down` followed by `/xfer mesh up` with the new config.
Discovery, `desc`, and cross-pool `mesh send` stay un-pooled: a Node in another
pool is still listed and addressable — only placement of your own actor is
pinned. Repeat on every machine, each with its own pool. The adapter daemon
accepts the same value as `--pool` (together with `--engine`). Rationale and the
RivetKit API evidence: [ADR 0017](../adr/0017-mesh-runner-pools.md).

Sanity-check the file at any time with `/xfer doctor` — the **Mesh** line reads the config and queries the engine.

## Step 3 — Verify end to end

On each machine, in a pi session:

1. `/xfer mesh up` — joins this instance as a Node, using its xfer name. If the name is already taken on the engine, the join is refused (pick another via `/xfer name`).
2. `/xfer mesh list` — live engine query; you should see both machines' nodes.
3. Send a cross-machine handoff: `/xfer mesh <other-node-name> <request>`. The document travels inline through the engine's durable queue. If the target node is online it arrives immediately; if it went offline **after having been online**, it is buffered and delivered when it rejoins. A target that has *never* been online is not buffered — the send errors after ~30 s.

Local-side steps (`mesh.config.json` parsing, `mesh up` refusal on name conflict, doctor's Mesh line) are verified against the code in this repo; the full two-machine delivery loop was not re-run while writing this guide and depends on your control plane deployment.

## Step 4 — Describe what a node handles

`/xfer desc <text>` writes a short, self-declared capability note for **this** node — the kind of request you want sent its way ("handles Postgres migration reviews", "on-call for the payments service"). `/xfer desc` with no argument clears it.

The note lives in the node's own actor state on the engine, so it survives `mesh down` / `mesh up` and stays readable while that node is offline. It is unverified self-declaration: a claim, not a contract. Nothing in pi-xfer routes or schedules on it — listings stay names-only, and a consumer that wants a capability map loops the per-node describe RPC and caches the result itself. The one convenience is the web picker's `targets` query, which attaches each target's description to its entry (omitted when that node's actor cannot be reached).

## Troubleshooting

Run `/xfer doctor` first — its **Mesh** line distinguishes config problems from engine problems:

| Symptom | Likely cause | What to do |
|---|---|---|
| Doctor: `not configured (opt-in) — create ~/.pi/xfer/mesh.config.json` | No config file yet | Create it (step 2). This is a normal state — the mesh is opt-in. |
| Doctor: `config unusable` | Invalid JSON, or missing/empty `endpoint` | Fix the file; the error message names the field. |
| Doctor: `engine unreachable at <endpoint>` | Engine down, wrong URL, or firewall | `curl <endpoint>/ui` from the same machine; check the engine container and any reverse proxy (it must tolerate long-lived WebSockets). |
| `mesh up` fails with an auth error | Wrong or missing `token`/`namespace` | Re-copy the values; on Route A the single URL-auth endpoint value avoids split-field mistakes. |
| `mesh up`: node name already exists on the engine | A node with this xfer name was joined before (possibly from another machine) | `/xfer name <other>` and retry, or destroy the stale actor from the engine dashboard (`<endpoint>/ui`). |
| Node is up but the peer doesn't see it in `mesh list` | The two machines point at different engines or namespaces | Compare `endpoint` and `namespace` in both machines' configs — discovery is engine-side, so both must resolve to the same engine + namespace. |
| A handoff arrives on the wrong machine | Every host shares the `default` pool, so the engine scheduled your Node's actor onto another machine's runner | Give each machine its own `pool` and create that pool's runner-config — [per-host pools](#per-host-runner-pools-mixed-fleets), [ADR 0017](../adr/0017-mesh-runner-pools.md). |
| Send to an offline node errors after ~30 s | Target never came online | Durable queue buffering starts only once the target actor has been created (i.e. it joined at least once). Bring the target online first. |
| `mesh up` downloads files on first run | Expected | The native runtime is fetched from npm on first `mesh up` and cached locally (see ADR 0013). Needs network access. |
| Want the RivetKit runtime's own logs (debugging the engine or the runner) | pi-xfer pins the runtime quiet, because those logs go straight to the process's stdout and overwrite the pi screen | Launch pi with `RIVET_LOG_LEVEL=debug` (or `warn`): a level you set yourself is respected, the welcome banner stays off. Expect the lines to smear the screen — that noise is why the default is `silent`. |
