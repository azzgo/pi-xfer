# Mesh setup — cross-machine handoffs

The Mesh is pi-xfer's opt-in transport for delivering handoffs between machines: each pi session that joins becomes a **Node** — one actor in a [RivetKit](https://rivet.dev) actor network, with engine-side discovery and a durable queue, so a handoff reaches a Node on another machine even if it's offline when sent. Local Unix-socket delivery is unaffected and stays the default. Why it's built this way: [`docs/adr/0013`](../adr/0013-xfer-mesh-rivetkit-transport.md).

> **Before you deploy:** pi-xfer does not encrypt handoff payloads, and Rivet's engine speaks plain
> HTTP unless you put TLS in front of it. Read
> [Transport security is your responsibility](#transport-security-is-your-responsibility) first.

![Mesh architecture](assets/mesh-architecture.svg)

The static image above is an export of the full interactive diagram — **[Open the interactive diagram](assets/mesh-architecture.html)** for pan/zoom, per-node source references, and a dark theme.

## What you need before starting

The mesh needs a **Rivet control plane** (engine) that every machine can reach. pi-xfer does not ship one; you either use Rivet's hosted cloud or run your own. Once you have it, everything is configured with a single file, `~/.pi/xfer/mesh.config.json`.

> **Not every node is a machine that stays on.** A Cloudflare Worker can host a node that exists
> only while there is work — see [Serverless Cloudflare node](cf-serverless-node.md). It uses the same engine and
> the same commands, but its pool is registered differently (out of band), so read that page before
> pointing `mesh setup` at one.

## Step 1 — Get a control plane

Two routes. Pick one.

### Route A: Rivet Cloud (hosted)

1. Create a project at [dashboard.rivet.dev](https://dashboard.rivet.dev).
2. Open **Connect** and copy the backend address and credentials. The dashboard hands you one string shaped like `https://my-namespace:sk_xxxxx@api.rivet.dev`; **split it** — pi-xfer no longer accepts credentials inside the endpoint URL.
3. Put the parts in their own fields: `endpoint` becomes `https://api.rivet.dev`, `namespace` becomes `my-namespace`, and the token becomes `token` (or, better, `"token": "$RIVET_ADMIN_TOKEN"` so it is not in the file at all). See [Values that are not literals](#values-that-are-not-literals).

Reference: [Rivet Cloud docs](https://rivet.dev/docs/deploy/cloud/).

### Route B: Self-hosted control plane (VPS / single node)

Follow Rivet's guide: [Deploy a self-hosted control plane](https://rivet.dev/docs/deploy/self-host/control-plane/). The quick path is a single Docker container; for persistence pick the file-system (RocksDB) backend on one node — that is the setup pi-xfer's mesh assumes (see ADR 0013).

When the engine is up you need three things from your deployment:

| You need | Where it comes from | Goes into |
|---|---|---|
| **Engine URL** reachable from every machine that will join (e.g. `https://engine.example.com`; `http://` is only acceptable on a private network — see [Transport security](#transport-security-is-your-responsibility)) | Your reverse proxy / firewall config; the dashboard lives at `<engine-url>/ui` | `endpoint` |
| **Namespace** (e.g. `default`) | Your engine's namespace setup | `namespace` |
| **Token** (the admin token you configured) | Engine configuration — see the [configuration docs](https://rivet.dev/docs/deploy/self-host/control-plane/configuration/) | `token` (required by current engines — authentication is on by default since 2026-09-29; only an engine set to `auth.insecure_allow_unauthenticated: true` accepts anonymous traffic) |

Note: a self-hosted engine may also require a one-time **runner config** per namespace before runners are accepted (see [Workers → Self-hosted](https://rivet.dev/actors/self-host/workers/)):

```bash
curl -X PUT "http://<engine-host>:6420/runner-configs/default?namespace=default" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"normal":{}}}}'
```

If `mesh up` connects and then the node fails to start, this is the usual suspect.

## Transport security is your responsibility

**pi-xfer does not encrypt anything, and Rivet does not encrypt anything for it.** This is a settled
decision, not an unfinished one — application-layer encryption was considered and declined because a
protocol-level tunnel protects strictly more for strictly less work ([ADR 0019](../adr/0019-mesh-transport-security.md)).
Handoff documents
travel as plaintext, the engine admin token travels as a plain `Authorization: Bearer …` header (and
as a WebSocket subprotocol), and the durability you get for offline nodes is plaintext sitting in the
engine's database. TLS is decided purely by your `endpoint` scheme: `https://` gives you `wss://`,
`http://` gives you an unencrypted socket.

That makes the transport a deployment decision you own. Two consequences follow:

1. **Never expose the engine port (`6420`) directly to the internet.** Rivet's own docs say the
   control plane "speaks plain HTTP" and expects a reverse proxy or load balancer to terminate TLS
   in front of it, and that port `6420` is exposed publicly "behind TLS" or not at all.
2. **A man-in-the-middle on that path gets more than your handoffs.** Whoever can read the wire can
   read the admin token — which is the engine's root credential: every namespace, every actor, not
   scopable, not revocable without restarting the engine. They can also read every handoff document,
   rewrite it in flight (there is no integrity check), or register a same-named `xfer-instance`
   actor to intercept traffic addressed to you.

Acceptable shapes, cheapest first:

| Shape | What it gives you | What it costs |
|---|---|---|
| **Private network** (WireGuard / Tailscale) | The engine is not on the public internet at all; no DNS or certificate needed | Every machine must join the VPN |
| **TLS in front of `6420`** (Caddy / nginx + a real certificate) | `https://`/`wss://` end to end from each node to your proxy | A hostname, a certificate, a proxy that tolerates long-lived WebSockets |
| **A TLS-terminating tunnel** (e.g. Cloudflare Tunnel) | No public inbound port, and HTTPS/WSS at the edge with no certificate work | The tunnel provider terminates TLS, so it can read your traffic; see below |

Whichever you pick, **this is your responsibility, not pi-xfer's** — the extension cannot detect a
missing TLS layer and will happily run over plain HTTP. If you are the only operator you can decide
the risk is acceptable on a trusted network; anyone else reading this should assume it is not.

Ordered by what they actually protect, a **protocol-level tunnel (Tailscale / EasyTier / WireGuard)
beats a TLS-terminating edge**: the edge sits inside your trust model and reads everything it
forwards, whereas a peer-to-peer tunnel protects the payload, the admin token and the control plane
end to end. Also worth knowing: a same-named `xfer-instance` actor cannot be distinguished from a real
node, and that stays true on any of these shapes — it is an accepted limit, not a config problem.
Full reasoning and the accepted risks: [ADR 0019](../adr/0019-mesh-transport-security.md).

### If you terminate TLS at an edge (Cloudflare Tunnel and friends)

A tunnel hides the engine port and supplies HTTPS, but the edge is now part of your threat model:
it decrypts the connection to forward it, so it sees the plaintext handoffs and the admin token just
like a man-in-the-middle would. That is not a tunnel bug — it is what "TLS terminates here" means.
If that is unacceptable, encrypt at the application layer (pi-xfer does not do this yet — E2EE is an
open candidate item, not a shipped feature) or put the engine on a private network instead.

Two operational caveats worth knowing before you commit to a tunnel:

- **Long-lived WebSockets get cut.** Cloudflare documents an idle timeout on proxied WebSockets that
  non-Enterprise plans cannot raise (widely observed at ~100 s of silence), and it restarts edge
  servers on deploys, dropping connections. **You do not need to add a heartbeat on the pi-xfer
  side**: the native runner pings the engine continuously on its own (`last_ping_ts` stays 1–3 s
  fresh), so an edge idle timeout does not reach the runner registration. A cut gateway socket simply
  reconnects; what you will notice is latency, not a missing heartbeat.
- **The dashboard comes along.** The engine serves its admin UI at `<endpoint>/ui`. A public tunnel
  to the engine exposes that too; gate the hostname behind the provider's access control or do not
  publish it publicly at all.

## Step 2 — Configure `~/.pi/xfer/mesh.config.json`

Every machine that joins the mesh writes this file in its own home directory.

| Field | Required | What it is |
|---|---|---|
| `endpoint` | yes | Control-plane URL, always a plain literal. **Credentials in a URL (`https://ns:token@host`) are refused** — see [the migration note](#credentials-in-the-endpoint-url-no-longer-work). |
| `namespace` | no | The isolated environment your nodes live in. Defaults to `default` engine-side. A literal or `$ENV_VAR`. |
| `token` | no | Auth token for the engine (`sk_…` from Rivet Cloud; the admin token on self-hosted). Sent as `Authorization: Bearer …`. A literal, `$ENV_VAR`, or `!command` — see [below](#values-that-are-not-literals). |
| `pool` | no | Envoy/runner pool this host's runners join. Set it to the machine/host name on a mixed fleet so the engine can only schedule this Node's actor onto this machine. Unset = the engine-wide `default` pool, where the engine may place the actor on any host (see [per-host pools](#per-host-runner-pools-mixed-fleets)). |

Minimal example:

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "your-admin-token"
}
```

### Editor completion: point `$schema` at the repository's schema

The shape of this file is published as a JSON Schema, so you can get key
completion and validation while you type. Add one line at the top:

```json
{
  "$schema": "https://raw.githubusercontent.com/azzgo/pi-xfer/main/mesh.config.schema.json",
  "endpoint": "http://engine.example.com:6420/",
  "namespace": "default",
  "token": "!pass show mesh-token",
  "pool": "laptop"
}
```

Editors that speak JSON Schema (VS Code, JetBrains, Neovim + `jsonls`) then
complete `endpoint`/`namespace`/`token`/`pool`, flag a typo such as `tokn`, and
show the descriptions — including the three token forms below. pi-xfer itself
**ignores** `$schema`; it is an editor hint and never becomes part of the config.

The raw URL tracks `main`, so it serves whatever was last pushed — a schema
change is live once it lands on the branch. To pin a version, substitute a tag or
commit for `main`.

### Values that are not literals

`token` (and `namespace`) accept the same three forms as `apiKey` in pi's own
`models.json` — see [pi's models documentation](https://github.com/earendil-works/pi/blob/main/docs/models.md).
The semantics are pi's, deliberately: one dialect for every config file you write.

| Written as | Meaning |
|---|---|
| `"your-admin-token"` | the literal value |
| `"$MESH_TOKEN"` / `"${MESH_TOKEN}"` | interpolate an environment variable; literals may surround it (`"sk_${PART_A}${PART_B}"`) |
| `"!pass show mesh-token"` | run the rest **as a shell command** and use its trimmed stdout |

Two details worth knowing, both inherited from pi:

- `$$` produces a literal `$` and `$!` a literal `!`, so a value may itself start
  with a dollar sign without being read as a reference.
- A `$NAME` that is not set is an **error**, not an empty string. A blank token
  sent to the engine would fail as a confusing 401; naming the variable is the
  honest answer.

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "!secret-tool lookup service rivet-engine"
}
```

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "$RIVET_ADMIN_TOKEN"
}
```

**When it runs, and what that costs.** A `!command` is evaluated each time the
mesh actually talks to the engine — on `/xfer mesh up`, and on any send, listing
or check that needs the credential. Nothing is cached, matching pi ("commands run
at request time and are not cached"), so a rotated or expiring secret is picked up
on the next operation instead of being frozen for the session. Reading a config
is *not* such a moment: parsing only records which form was written, so a
display-only surface such as `/xfer mesh status` never spawns anything.

A command that fails, exits non-zero, or prints nothing is reported by name
(`mesh config "token": mesh token command "!…" …`), never silently turned into an empty token — including
when the only thing it wrote went to stderr. The whole command has 10 seconds before it is killed.

**Where it runs: in the cwd of whoever asked.** A `!command` inherits the
working directory of the pi session, daemon or CLI that triggered it — the same
as a line you typed into that shell. So a **relative path inside it is not
stable**: `"!./get-token.sh"` resolves against whichever repository you happen to
have open, which is usually *not* the directory holding `mesh.config.json`. The
same config then works from one project and fails from another, and (before this
was reported by name) the failure surfaced as "token invalid" rather than as
"that file is not here".

**Use an absolute path, `$HOME`, or a command on `PATH`** — `"!$HOME/bin/mesh-token"`
or `"!pass show mesh-token"`. Relative paths are not made to work: there is no
directory this could safely resolve against (the config file is data, not code,
and pi runs `models.json` commands from the process's cwd too). Every failure
names the cwd and the shell it used, so the reason is visible in the error:

```
mesh config "token": mesh token command "!./get-token.sh" produced no token
(exit code 127; cwd "/home/me/other-project", shell /bin/zsh) — no such file or directory
— a relative path inside the command resolves against the cwd above; use an absolute path or $HOME
```

> **Security boundary.** A `!command` runs with your own permissions, so **write
> permission on `mesh.config.json` is equivalent to permission to execute code as
> you.** That is a real change in what this file is: it used to be inert data.
> Keep it `0600`, keep it out of any repository, and prefer `$ENV_VAR` if you only
> need to avoid storing the secret on disk.

### Credentials in the endpoint URL no longer work

The old `https://my-namespace:sk_xxx@api.rivet.dev` form is **refused** with a
migration message: one URL carrying the endpoint, the namespace and the token was
too easy to get wrong, and now that a token can be a command or an environment
lookup, embedding it in a URL is a second, weaker spelling of the same thing.

Given:

```json
{
  "endpoint": "http://default:sk_xxx@engine.example.com:6420/",
  "pool": "laptop"
}
```

write:

```json
{
  "endpoint": "http://engine.example.com:6420/",
  "namespace": "default",
  "token": "sk_xxx",
  "pool": "laptop"
}
```

The token can also leave the file entirely — `"token": "$RIVET_ADMIN_TOKEN"` or
`"token": "!secret-tool lookup service rivet-engine"`. The exact target shape is
printed in the error, so pasting it from the message is enough.

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

One pool kind is **not** what this step creates: a **serverless** pool (a Cloudflare Worker, no
resident runner). `ensureRunnerPool()` writes `{ normal: {} }` and cannot express one, so
`mesh setup`'s pool step will not create one and no pi-xfer command may be pointed at it — see
[Serverless Cloudflare node](cf-serverless-node.md) for the out-of-band registration.

## Step 3 — Verify end to end

On each machine, in a pi session:

1. `/xfer mesh up` — joins this instance as a Node, using its xfer name. If the name is already taken on the engine, the join is refused (pick another via `/xfer name`).
2. `/xfer mesh status` — this host's own answer to "can anything reach me?": online or not, the pool it belongs to, whether that pool holds a live runner, and whether the engine answers. Works with or without `up`.
3. `/xfer mesh list` — live engine query, one row per node with its delivery verdict. The glyphs are the whole point:

   | | meaning |
   |---|---|
   | `●` running | the actor is connectable in its pool |
   | `◐` sleeping | the actor is asleep in a pool that has a runner — it wakes on delivery |
   | `○` no runner | **the pool has no runner, so this node cannot receive anything**. The row names the pool, not the node: any actor placed there is equally stranded |
   | `⚠` mismatch | the actor record still reads idle while its pool does hold a runner — the engine places it on the next send |
   | `·` pending / `✗` crashed | waiting for an allocation / a real engine error |
   | `?` unknown | the engine did not answer `/envoys`, so the runner side is unknown. Never rendered as "offline" and never as "no nodes" |

4. Send a cross-machine handoff: `/xfer mesh <other-node-name> <request>`. The document travels inline through the engine's durable queue. If the target node is online it arrives immediately; if it went offline **after having been online**, it is buffered and delivered when it rejoins. A target that has *never* been online is not buffered — the send errors after ~30 s.

   Every send first runs a **pre-send check** (one engine round: `/actors` + `/envoys`, 6 s): a target whose pool has no runner is refused in about a second, naming the pool, instead of costing a 30 s timeout. The check is **fail-closed** — if the engine cannot answer within 6 s, nothing is sent, because an unverified send may hand you the worst outcome (a reported failure about a message that still arrives). A `⚠` mismatch is a warning, not a refusal, and the send proceeds. `xfer-adapterd mesh send --no-preflight` skips the check for hosts that need to send through an unreachable control plane.

Local-side steps (`mesh.config.json` parsing, `mesh up` refusal on name conflict, doctor's Mesh line) are verified against the code in this repo; the full two-machine delivery loop was not re-run while writing this guide and depends on your control plane deployment.

## Step 4 — Describe what a node handles

`/xfer desc <text>` writes a short, self-declared capability note for **this** node — the kind of request you want sent its way ("handles Postgres migration reviews", "on-call for the payments service"). `/xfer desc` with no argument clears it.

The note lives in the node's own actor state on the engine, so it survives `mesh down` / `mesh up` and stays readable while that node is offline. It is unverified self-declaration: a claim, not a contract. Nothing in pi-xfer routes or schedules on it — listings stay names-only, and a consumer that wants a capability map loops the per-node describe RPC and caches the result itself. The one convenience is the web picker's `targets` query, which attaches each target's description to its entry (omitted when that node's actor cannot be reached).

## Local development vs production

Two lines that must not blur. The same commands serve both, so the difference
is entirely **which config they read** — and that file is the switch.

| | Local development / verification | Production |
|---|---|---|
| **Config** | a throwaway file pointing at a loopback engine (`http://127.0.0.1:6420`) or a stub | `~/.pi/xfer/mesh.config.json` pointing at your real engine |
| **Who reaches the network** | nobody — loopback only | your machines, deliberately |
| **How it is enforced** | `mesh-guard.ts` refuses any non-loopback endpoint in a test run | no guard: a real process talks to whatever the config says |

### The guard

`mesh-guard.ts` exists so "tests never touch a deployment" is a property of the
code rather than a rule people remember. It **arms itself when
`NODE_TEST_CONTEXT` is set** — which is exactly what `node --test` puts in each
worker, and in any process a test spawns. Nothing else arms it: an installed
extension, `/xfer mesh up`, the admin daemon and the adapter daemon run unarmed
and see no change at all.

Armed, it:

- **Refuses every non-loopback endpoint** from both outbound planes — the REST
  calls (`engineApi`, over `fetch`) and the socket transport (`createClient`
  from `rivetkit/client`, including the broker's description lookups). The
  refusal happens *before* the request, so nothing leaves the machine.
- **Lets loopback through**: `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`,
  `host.docker.internal`. An endpoint it cannot parse is refused rather than
  guessed at.
- **Stops inheriting your real config**: in a test run the default path is not
  `~/.pi/xfer/mesh.config.json` but a non-existent temp path, so a test that
  forgot to inject anything fails loudly instead of quietly reading production.
- **Counts its decisions** (`unguarded` / `loopback` / `allowed` / `blocked`),
  so a suite can assert it granted zero remote allowances.

Two environment variables are the whole interface:

| Variable | Effect |
|---|---|
| `XFER_ALLOW_REMOTE=1` | The **only** way through while armed. Meant for the one test that deliberately exercises the guard; `mesh-guard.test.ts` asserts repo-wide that no test enables it. |
| `XFER_MESH_CONFIG=/path/to/config.json` | Point a test run at a specific config instead of the non-existent default. |

One case the guard does **not** cover, on purpose: an interactive session
(a tmux pane, your own pi) is a normal process, so `/xfer mesh list` there
really does talk to whatever your config names. Treat that as production
access: **read-only included**. See the `verify` skill's *Never verify against a
live deployment* section.

### Standing up a loopback engine

For verifying mesh surfaces yourself — `/xfer mesh list`, `/xfer mesh status`,
the admin mesh panel — run the control plane locally instead of borrowing a
deployment. Take the single-container path from
[Deploy a self-hosted control plane](https://rivet.dev/docs/deploy/self-host/control-plane/)
— the same shape as *Route B* above, on `127.0.0.1` instead of a VPS, with its
default port exposed on this machine.

This guide does not pin the image name or flags: they belong to that page, and a
copy here would rot. All pi-xfer needs is a reachable endpoint.

Then a throwaway config — never your real one:

```json
{ "endpoint": "http://127.0.0.1:6420", "namespace": "default" }
```

Use it with `XFER_MESH_CONFIG=/tmp/mesh.local.json npm test`, or point a
working-tree session at it (`pi -ne -e ./`) after backing up
`~/.pi/xfer/mesh.config.json` — and put it back afterwards. Authentication is on
by default in current engines, so put the admin token you started the container
with in `token`. Either way
nothing you do on loopback can reach anyone else.

If even that is too much for what you are checking, do not run the command:
the verdict-derivation logic is covered hermetically by `npm test`, and that is
the coverage that matters for the code.

## Troubleshooting

Run `/xfer doctor` first — its **Mesh** line distinguishes config problems from engine problems:

| Symptom | Likely cause | What to do |
|---|---|---|
| Doctor: `not configured (opt-in) — create ~/.pi/xfer/mesh.config.json` | No config file yet | Create it (step 2). This is a normal state — the mesh is opt-in. |
| Doctor: `config unusable` | Invalid JSON, or missing/empty `endpoint` | Fix the file; the error message names the field. |
| Doctor: `config unusable: mesh config "token": mesh token command "!…" produced no token` | The `!command` failed — non-zero exit, or nothing on stdout. The message carries the cwd and shell it ran in; if it mentions a file not being found, the command used a **relative** path | Use an absolute path or `$HOME` ([values that are not literals](#values-that-are-not-literals)), then run the command by hand in that same cwd to see what it prints |
| Doctor: `engine unreachable at <endpoint>` | Engine down, wrong URL, or firewall | `curl <endpoint>/ui` from the same machine; check the engine container and any reverse proxy (it must tolerate long-lived WebSockets). |
| `mesh up` fails with an auth error | Wrong or missing `token`/`namespace` | Re-copy the values — on Route A the dashboard's single string has to be split into `endpoint`, `namespace` and `token`, since credentials in the URL are refused. If `token` is a `$VAR`, check it is exported in the environment that starts pi. |
| `mesh up`: node name already exists on the engine | A node with this xfer name was joined before (possibly from another machine) | `/xfer name <other>` and retry, or destroy the stale actor from the engine dashboard (`<endpoint>/ui`). |
| Node is up but the peer doesn't see it in `mesh list` | The two machines point at different engines or namespaces | Compare `endpoint` and `namespace` in both machines' configs — discovery is engine-side, so both must resolve to the same engine + namespace. |
| A handoff arrives on the wrong machine | Every host shares the `default` pool, so the engine scheduled your Node's actor onto another machine's runner | Give each machine its own `pool` and create that pool's runner-config — [per-host pools](#per-host-runner-pools-mixed-fleets), [ADR 0017](../adr/0017-mesh-runner-pools.md). |
| Send to an offline node errors after ~30 s | Target never came online | Durable queue buffering starts only once the target actor has been created (i.e. it joined at least once). Bring the target online first. |
| `mesh up` downloads files on first run | Expected | The native runtime is fetched from npm on first `mesh up` and cached locally (see ADR 0013). Needs network access. |
| Want to see what the mesh did after the fact | The mesh runs quiet, so the pi screen shows nothing — but nothing is dropped either | Read `<xfer-dir>/mesh.log` (`tail -n 50 ~/.pi/xfer/mesh.log`): every `mesh up/down/send`, refusal, failure, inbound handoff and rivetkit JS log line, append-only. [docs/dev/mesh-log.md](../dev/mesh-log.md) explains what it holds and what it cannot. |
| Connections drop every ~100 s (or on Cloudflare deploys) through a tunnel/edge proxy | The edge cuts idle gateway WebSockets. The runner registration is unaffected — it pings continuously. | Expect reconnects and higher latency; nothing to configure on the pi-xfer side. If churn is disruptive, use a private network / your own TLS proxy — [Transport security](#transport-security-is-your-responsibility) |
| `mesh list` shows `○ no runner` for a node, and sends to it are refused at once | The engine has no live runner in that node's pool, so nothing there can pick the actor up | Start a runner for that pool on that machine — open a pi session there (its runtime joins the pool named in its `mesh.config.json`) — then retry. `/xfer mesh status` answers the same question for this host |
| Every row reads `?` | The engine answered `/actors` but not `/envoys` | Check `/xfer mesh setup`; the runner side of the engine is unreachable even though the actor listing is not. Sends are refused while this lasts (fail-closed) |
| `mesh up` works but every handoff is readable by something on the path | You are on `http://`, or a TLS-terminating edge is in the path | Terminate TLS yourself or use a private network; pi-xfer has no payload encryption — [Transport security](#transport-security-is-your-responsibility) |
| Want the RivetKit runtime's **native** logs (the Rust side, e.g. SQLite warnings) | Those never reach JS — they are written straight to the process's stdout, so they cannot be filed in `mesh.log` | Launch pi with `RIVET_LOG_LEVEL=warn` (or `debug`): a level you set yourself is respected, the welcome banner stays off. Expect the lines to smear the pi screen — that noise is why the default is `silent`. |
