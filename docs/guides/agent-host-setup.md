# Agent Host Setup — wiring a non-pi bot into the xfer network
[简体中文](agent-host-setup.zh.md)

This guide is for a bot or agent that is **not** a pi session — a Feishu bot, a
CLI agent, a cron worker — that should receive and send xfer handoffs like any
pi node. The adapter daemon (`xfer-adapterd`) is the bridge; no dedicated
adapter code is needed per bot. Everything here applies to any host, with the
grok bot as the worked example.

If your "host" is a pi session, you do not need this guide — see
[Quickstart](quickstart.md) and [Mesh setup](mesh-setup.md).

## How the pieces fit

```
mesh engine (durable queue)
        │  push — the engine delivers to your node's actor
        ▼
xfer-adapterd  (one per host, named like a pi node)
        │                    │
        ▼ push                ▼ pull
--on-handoff CMD       inbox take/list (JSONL)
  (your command gets      (your bot polls a
   the handoff on stdin)   local inbox file)
```

- **Mesh → adapterd is push.** The engine's durable queue delivers inbound
  handoffs to the daemon's actor as they arrive. Your bot never polls the
  engine.
- **adapterd → your bot is your choice**: push via `--on-handoff`, or pull via
  the inbox. Pick one; you can also use both (the inbox always records every
  handoff, `--on-handoff` is an extra strategy on top).

## 1. Install the daemon and skill

```bash
xfer-adapterd install --host generic --into /path/to/your-bot --name grok
```

This copies the generic agent-host skill (SKILL.md + helper scripts) into the
bot's directory so the bot knows how to send and take handoffs. The generated
launch command is **local-only** — a Unix socket on this machine. Add `--mesh` to
the install if the bot also needs to be reachable across machines.

## 2. Configure the mesh (only if the bot joins the cluster)

Create `~/.pi/xfer/mesh.config.json` the same way a pi node does:

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "…",
  "pool": "grok-host"
}
```

Then make sure the setup actually works — this one command parses the config,
creates the pool's runner-config on the engine if missing, and confirms
reachability:

```bash
xfer-adapterd up --mesh --name grok --once   # smoke: joins and exits after first handoff
```

or, from a pi session on the same machine, `/xfer mesh setup` (same config
file, same engine). Notes:

- **Pick one pool per host** and use the machine name. See
  [per-host pools](mesh-setup.md#per-host-runner-pools-mixed-fleets). An
  existing actor does not move pools by itself — if you change `pool` later,
  follow the [migration warning](mesh-setup.md) (down, restart, up).
- Credentials go in their **own fields** — `namespace` and `token`. URL userinfo
  (`https://ns:token@host`) is refused with a migration message: one URL carrying
  several settings was too easy to get wrong. `token` may be a literal, `$VAR`, or
  `!command` — see [values that are not literals](mesh-setup.md#values-that-are-not-literals).

## 3. Choose a delivery mode

### Push — `--on-handoff`

```bash
xfer-adapterd up --name grok --mesh \
  --on-handoff /path/to/your-bot/handle-handoff.sh
```

Every inbound handoff spawns `handle-handoff.sh` with the handoff JSON on
stdin:

```json
{ "id": "h-…", "from": "issue-tracker", "to": "grok",
  "summary": "…", "file": "/tmp/xfer/h-….md", "transport": "mesh" }
```

The document body is at `file`. A failing handler never takes the daemon down;
the handoff stays in the inbox either way. Use this when your bot should react
immediately — e.g. post the summary to a Feishu webhook, wake the agent loop.

### Pull — inbox

```bash
xfer-adapterd up --name grok --mesh          # daemon only
xfer-adapterd inbox take --name grok         # bot polls; consumes every pending record (consume-on-read)
xfer-adapterd inbox list --name grok         # peek without consuming
```

The inbox is a local JSONL file; `take` atomically consumes every pending record. There
is no retention — once read, it is gone. Polling is fine for a bot that wakes
on a timer anyway.

## 4. Sending handoffs out

```bash
# to a local pi session (same machine)
xfer-adapterd send <target> <file> <summary> --from grok

# across the mesh
xfer-adapterd mesh send <target> <file> <summary> --from grok
```

## 5. Running it resident

The daemon is a normal foreground process; keep it alive with whatever you
already use:

- **tmux** (simplest): a dedicated session running the `up` command. A
  watchdog loop that relaunches on exit is enough:

  ```bash
  while true; do
    xfer-adapterd up --name grok --mesh --on-handoff …
    sleep 5
  done
  ```

- **launchd / systemd**: `KeepAlive`/`Restart=on-failure`, 5 s restart backoff.

If the daemon cannot start (bad config, engine unreachable at startup) it exits
with an error message — the supervisor above restarts it, which is the
reconnect path.

## Delivery semantics worth knowing

- **Durable queue buffering**: a target that was online before and went offline
  receives its handoffs when it rejoins. A target that has **never** been
  online is not buffered — the send errors after ~30 s. Keep your node `up` if
  you expect traffic.
- **Misroute guard**: handoffs are addressed by node name; a handoff delivered
  to the wrong node is refused, not silently consumed.
- **Misconfigured pool**: a node whose actor sits in a pool without a
  runner-config looks online but never receives anything. `mesh setup` (or the
  daemon's `--mesh` startup) plus per-host pools prevents this; `up` on a pi
  node also refuses pool mismatches outright.

## Feishu as an inbound channel

If the bot's users message it via Feishu, keep these constraints in mind:

- **One app, one long-connection consumer.** A Feishu app's WebSocket
  long-connection (WSClient) can be consumed by exactly one process. If your
  resident bot holds it, a second process using the same app gets nothing.
  Recommended split: the Feishu long-connection lives in the bot process; it
  forwards messages into xfer via `xfer-adapterd send`/`mesh send`, and
  outbound handoffs reach Feishu through the bot's `--on-handoff` handler.
- **Deduplicate events.** Feishu redelivers on missed acks; key dedup on the
  event's message id.
- **Mention-only intake** (`GROUP_POLICY=mention`) keeps a group bot quiet
  unless @-mentioned; pair it with a water-mark if you ever fall back to
  periodic pulls of the message list.

A first-class `feishu` adapter inside pi-xfer is deliberately deferred — the
constraint above is the part that must be documented first, and the generic
path already works today.
