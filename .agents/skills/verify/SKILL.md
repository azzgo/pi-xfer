---
name: verify
description: Verify admin page and interactive command changes in a real browser/session.
---

# Verify

npm test covers headless logic. It cannot see a rendered page or an interactive
command. When your change has a visible or interactive surface, verify it with
the channel below — do not ask the user to look at the screen for you.

## Which copy is under test

pi-xfer is installed globally as `npm:pi-xfer` **and** exists here as a working
tree. Both copies register `xfer_to`, `xfer_mesh_to` and the `--xfer` flag, so a
session that loads both fails to start with one error per duplicate name:

```text
Error: Failed to load extension ".../node_modules/pi-xfer/index.ts": Tool "xfer_to" conflicts with .../pi-xfer/index.ts
```

Rules:

- Never `pi install <path to this repo>` and never add a local path to
  `~/.pi/agent/settings.json`. The single global entry stays `npm:pi-xfer`;
  upgrades go through `pi update --extensions`.
- Exercise the working tree with `pi -ne -e ./`: `-e ./` loads this repo's
  `index.ts`, `-ne` skips extension discovery so no installed copy can load
  beside it. Skills, prompts and context files still load.
- `-ne` also drops built-in extensions, MCP included — use a normal pi session
  when a channel needs MCP tools.
- Under `-ne -e ./` a "conflicts with" error means the working tree registers a
  duplicate itself: a real bug. Outside it, it means a duplicate install.

## Channel 1 — admin page (chrome-devtools MCP)

The repo tracks `.pi/mcp.json` with the `chrome-devtools` MCP server. It is
loaded after project trust is granted; first-time contributors must approve the
trust prompt. Tools are prefixed `mcp__chrome_devtools__`.

```text
1. Serve the page under test from a working-tree session: `pi -ne -e ./` in the
   repo root, then /xfer admin (or inspect via admin-manager for the existing
   URL — it is a global singleton; if already served, reuse the URL).
   Drive the browser from this agent's normal pi session, since -ne has no MCP.
2. mcp__chrome_devtools__navigate_page  → the admin URL
3. mcp__chrome_devtools__take_screenshot → look at it before judging CSS
4. Interact: click tabs/buttons, then screenshot again
5. Check both themes if a theme toggle exists
```

Rules:

- Never claim a button/layout/style is correct without a screenshot after the
  change. The cost of one screenshot is far below the cost of a user
  correction round.
- Danger-styled actions (stop, gc) get checked in their resting state too.
- No Chrome on the machine? Fall back to telling the user which URL to open
  and what to look at. State plainly that verification was not done by you.

## Channel 2 — extension commands (tmux)

Drive a real pi session with the extension loaded. This pattern is verified —
it is how this skill's smoke test was written:

```bash
tmux kill-session -t verify-smoke 2>/dev/null
tmux new-session -d -s verify-smoke -x 100 -y 30 -c <repo-root>
tmux send-keys -t verify-smoke 'pi -ne -e ./' Enter
sleep 6 && tmux capture-pane -t verify-smoke -p | tail -20   # after startup
tmux send-keys -t verify-smoke '/xfer list' Enter
sleep 3 && tmux capture-pane -t verify-smoke -p | tail -15   # command output
tmux send-keys -t verify-smoke Escape; sleep 1
tmux send-keys -t verify-smoke '/exit' Enter; sleep 2
tmux kill-session -t verify-smoke
```

Rules:

- Capture the pane after every step; never assume a command succeeded because
  `send-keys` returned.
- Long-running commands (broker ops) can hang the foreground — poll with
  `capture-pane` instead of waiting on the command.
- Replace `/xfer list` with whatever command you changed. A startup screen
  alone is not a pass; the changed command must produce visible output.
- **A tmux pane is a real pi process, not a test.** If the command you are
  verifying starts with `/xfer mesh`, it will reach the engine in
  `~/.pi/xfer/mesh.config.json` — read the next section before typing it.

## Never verify against a live deployment

Verification is **local, always**. The machine's `~/.pi/xfer/mesh.config.json`
points at a real engine; a working-tree session reads it by default, so the
moment you run a mesh command in that session you are talking to production.

This is not only about writes. **A read counts.** A `/xfer mesh list` or
`/xfer mesh status` typed into a tmux pane sends `GET /actors` and `GET /envoys`
to that engine, with its token, leaving a trail on a system that belongs to
somebody's deployment. Read-only is still access.

Rules:

- **Ask first, every time.** Any access to the engine named in
  `~/.pi/xfer/mesh.config.json` — GET included, tmux interactive session
  included — is a human decision. Say which command you want to run and why,
  and wait for a yes. Do not decide it is harmless on your own.
- `npm test` is not subject to this: `mesh-guard.ts` arms itself on
  `NODE_TEST_CONTEXT` and refuses any non-loopback endpoint, so the suite
  cannot reach a deployment even by mistake. Whatever your test does, the
  guard decides.
- An interactive tmux session is **not** covered by that guard — it is a normal
  pi process, so it is exactly the case that needs the rule above. "It is only
  a smoke test" is not an exemption.
- Prefer a channel that never touches the mesh: most command smoke tests
  (`/xfer list`, `/xfer board …`, `/xfer broker …`, admin pages) need no engine
  at all. Only `/xfer mesh …` does.

### Verifying mesh surfaces without a deployment

For `/xfer mesh list`, `/xfer mesh status`, the delivery verdicts or the admin
mesh panel, pick one of these instead of pointing at a real engine:

| Approach | How |
|---|---|
| **Hermetic stub** (default) | `npm test` — `mesh-guard.test.ts` and the `mesh.test.ts` suites drive every verdict branch from stubbed `/actors` + `/envoys` responses. This is the coverage for the *logic*. |
| **Local loopback engine** | Run a control plane on this machine and point a throwaway config at it: `{"endpoint": "http://127.0.0.1:7920"}`. Loopback is allowed by the guard and costs nobody anything. `XFER_MESH_CONFIG=/tmp/mesh-local/mesh.json` selects it for a test; for an interactive session, pass `--mesh-config` where the CLI accepts one — never edit `~/.pi/xfer/mesh.config.json`. **Use a port the machine's own engine is not on, and see [Recipe: an engine that coexists with a running one](#recipe-an-engine-that-coexists-with-a-running-one)** — a naive second instance silently half-works. |
| **Inspect the rendered HTML** | When no browser is available, `curl` the admin page and read the markup. Say plainly that this is not a screenshot and does not verify layout. |

Standing up a loopback engine is Rivet's own self-host path — see
[Rivet → self-host](https://rivet.dev/docs/deploy/self-host/control-plane/)
and [Local development vs production](#local-development-vs-production) in the
mesh guide. The recipe below is what actually worked here; the field is full of
near-misses that look like "the engine is broken" and are not.

#### Recipe: an engine that coexists with a running one

A developer machine usually already has an engine on **6420** (api), **6421**
(guard) and **6430** (metrics). A second instance must move **all three** and
must not share the first one's database. Two knobs, both easy to miss:

```jsonc
// /tmp/mesh-local/engine.json
{
  "auth": {
    "admin_token": "local-test",
    "insecure_allow_unauthenticated": true
  },
  "api_peer": { "host": "127.0.0.1", "port": 7920 },
  "guard":    { "host": "127.0.0.1", "port": 7921 },   // ← not derived from api_peer
  "metrics":  { "host": "127.0.0.1", "port": 7930 }
}
```

```bash
BIN=~/.pi/xfer/cache/napi/<version>/engine-cli/node_modules/@rivetkit/engine-cli-<triple>/rivet-engine
XDG_DATA_HOME=/tmp/mesh-local/xdg "$BIN" --config /tmp/mesh-local/engine.json start
# then: {"endpoint": "http://127.0.0.1:7920", "namespace": "default", "token": "local-test"}
```

Why each line is there:

- **`guard.port` is its own key.** `api_peer.port` moves only the REST plane. A
  missing `guard` block leaves the guard on 6421, where it crashes with
  `Address in use (os error 98)` roughly once a second, restarting forever. The
  REST plane answers `/health` perfectly the whole time, so this failure does
  **not** look like a startup failure — it looks like a working engine that
  returns `internal_error` on everything real.
- **`XDG_DATA_HOME` moves the database.** There is no config key for it:
  `filesystem`, `db`, `db_path` are all rejected as unknown fields, and the path
  is hardcoded to `<XDG_DATA_HOME>/rivet-engine/db`. Without the override a
  second engine dies with `failed to open rocksdb … LOCK: Resource temporarily
  unavailable` — a lock conflict, not corruption.
- **`insecure_allow_unauthenticated` + `admin_token` must both be set.** The
  token alone still makes `auth.insecure_allow_unauthenticated` mandatory, and
  omitting the token fails deserialization with `missing field admin_token`.
- **Add a *fresh* port, do not "pick another loopback IP".** `127.0.1.1` is
  worth knowing about when a port is squatted, but a `guard` left on 6421 keeps
  crashing regardless of which address `api_peer` binds. Moving the port is the
  fix; moving the IP is not.

Sanity check that the engine is genuinely isolated, before trusting anything
built on it:

```bash
curl -s http://127.0.0.1:7920/health                                  # {"status":"ok"}
grep -c "service crashed" /tmp/mesh-local/engine.log                  # must be 0
curl -s -H 'Authorization: Bearer local-test' \
  "http://127.0.0.1:7920/actors?namespace=default&name=xfer-instance"  # {"actors":[]}
```

`/actors` **requires the `name` query param** — without it the engine answers
`500 internal_error` with `meta=null`, which reads as "the engine is broken"
when it is only a missing parameter.

#### Expect the guard to crash once at startup

A fresh engine logs one
`service crashed … verification_unavailable: … verification keys are
temporarily unavailable` while its JWT key-ring is still initialising. It
recovers by itself. **One** such line is normal; a repeating one is the port
collision above.

#### Known gap: `runner-configs` PUT on 2.3.26

`mesh-engine.ts:ensureRunnerPool` sends
`{"datacenters":{"default":{"normal":{}}}}`, and a 2.3.26 engine rejects it with
`no variant of enum RunnerConfigKind found in flattened data`. That blocks
`/xfer mesh setup` and any enqueue into a pool with no runner, so a loopback
engine is currently good for **reads** — `/actors`, `/envoys`, `/health`,
the listings and the preflight verdicts — and not yet for a real mesh enqueue.
Do not conclude your change is broken when a loopback enqueue fails this way;
check the engine version and this message first.

#### Etiquette

- Put the config, the database and the log under one throwaway directory, and
  delete it when done. Never point an engine at `~/.local/share/rivet-engine/db`.
- **Check what is already listening before you start anything**:
  `ss -ltn | grep -E ':64[0-9][0-9]'`. An engine owned by another user cannot be
  killed by you, and starting a second one against its database only produces a
  lock error.
- Kill only processes you started, by pattern anchored on *your* config path
  (`pkill -f "rivet-engine --config /tmp/mesh-local"`). A bare
  `pkill -f rivet-engine` reaches the machine owner's engine too.
- Everything above is still governed by *Never verify against a live
  deployment*: loopback is allowed and free, `~/.pi/xfer/mesh.config.json` is
  not.

## Manual smoke checklist (release)

When neither channel is available (contributor without Chrome, headless CI):

- [ ] `npm test` green, build artifacts byte-identical
- [ ] `pi -ne -e ./` loads the extension with no errors in the startup banner
- [ ] `/xfer list` responds
- [ ] `/xfer admin` starts, opens a working page, tabs switch
- [ ] Stop / gc actions work and are visibly styled as dangerous
