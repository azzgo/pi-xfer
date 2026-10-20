# MCP gateway — typed xfer tools for a host's model

`mcp-gateway.mjs` is a **stdio MCP server**: the host spawns it, owns its
stdin/stdout, and its tools shell out to the `xfer-adapterd` CLI that already
exists. It binds no socket, keeps no inbox, joins no mesh and runs no agent
loop — every tool builds an argv and forks the CLI.

That "no socket" fact is the whole reason the design is cheap **and** the one
thing a user will notice:

| | |
|---|---|
| Nodes created | none |
| Hosts listed in `/xfer list` | **only** once something binds a socket (`xfer-adapterd up`) — a send-only gateway is invisible there |
| Sender a receiver sees | the `--name` you started the gateway with |

Invisible is honest: sending does not require being listed. It is also the one
behaviour change worth stating up front, because someone used to seeing a host
in `/xfer list` will look for one and not find it.

## Why per host session, not one shared process

stdio means the host owns the process, so there is one gateway **per host
session** and each can carry its own name. `/xfer list` therefore does not
collapse, and a receiver sees that host's name rather than a gateway's. The
residual risk is two gateways configured with the same `--name` — which is a
config error, and `--name` is required precisely so it cannot happen by
accident.

## Install

No build step and no runtime dependency: it is a committed `.mjs` that imports
nothing from this repository. Point your host's MCP config at it.

**Claude Code / `claude_desktop_config.json` style:**

```json
{
  "mcpServers": {
    "xfer": {
      "command": "node",
      "args": [
        "/path/to/pi-xfer/mcp-gateway.mjs",
        "--name", "agent-my-host"
      ]
    }
  }
}
```

For an npm-installed pi-xfer the path is
`~/.pi/agent/npm/node_modules/pi-xfer/mcp-gateway.mjs`.

## Flags

| Flag | Required | Meaning |
|---|---|---|
| `--name <n>` | **yes** | The sender name stamped on every handoff. Never derived — not from cwd, not from an env var. |
| `--dir <d>` | no | Where peer sockets live. Defaults to `~/.pi/xfer`. Tests point it at a fresh temp dir. |
| `--xfer-adapterd <path>` | no | The CLI to fork. Defaults to the `xfer-adapterd.cjs` beside this file; tests point it at a stub. |

**`--name` is required and never derived.** A send-only gateway binds nothing,
so a name collision cannot be caught the way a duplicate daemon is
(`claimEndpoint`) — it has to be refused at startup instead. The name that
`xfer-adapterd install` generates is the right one.

`--no-preflight` is **deliberately not a tool parameter**. It exists for a
human debugging the engine; a model should not reach for it, so the gateway
never offers it.

## Tools

| Tool | Backs |
|---|---|
| `xfer_send` | `xfer-adapterd send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>` |
| `xfer_mesh_send` | `xfer-adapterd mesh send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>` |
| `xfer_list` | `xfer-adapterd list --json --dir <dir>` |

`xfer_send` / `xfer_mesh_send` take `{ target, summary, document, kind }` and
return `{ handoff_id, outcome, target }`.

`outcome` is always one of ADR-0020's **four** values — `queued`, `delivered`,
`unknown`, `not-delivered` — and there is no fifth. A failing CLI is still an
`isError: true` result, but its `outcome` stays inside that set:

| Situation | `outcome` |
|---|---|
| local send acked | `delivered` |
| mesh enqueue accepted | `queued` |
| target has no socket (`peer "x" not found`) | `not-delivered` |
| ack timeout, dropped connection, unclassified refusal | `unknown` |
| CLI could not say (config error, missing binary, crash) | `unknown` |

**`unknown` is never a definite negative, and never invites a resend.** An ack
timeout means the handoff may well have arrived; reporting it as "not sent"
would make a model resend, which is precisely the duplicate hazard the value
exists to prevent. The `detail` field carries the CLI's own message plus an
explicit do-not-resend sentence, so the guidance reaches the model with the
verdict.

A **preflight warning** (mesh `Mismatch`: the actor record reads idle while the
target's pool does hold a live runner) is *not* a failure — the handoff was
queued and the engine places it on the next send. It goes to stderr and leaves
the exit code at 0.

`xfer_list` takes `{}` and returns `{ targets: [{ name, sessionName, cwd,
status }] }`. **Local only** — mesh nodes are listed by the xfer extension, not
here.

The gateway writes the handoff document to a temp file itself, exactly as
`xfer_to` does, and passes the path; the file is removed when the call returns.

## Receiving is out of scope

There is no inbox, no `xfer_inbox` and no `--on-handoff`. A host that adopts the
gateway still only *sends*. Anything expecting inbound delivery will find
nothing, and this document must not imply otherwise.

## Discovery needed a new subcommand

`xfer-adapterd` had no way to list peers from the CLI — `/xfer list` is a pi
command. Without a replacement, a send-only host would still need a shell to
find a target, which is half the problem the feature exists to solve. So
`xfer-adapterd list [--dir D] [--json]` was added: it prints the `*.sock`
siblings with their metadata, and `--json` emits one object per line (the same
shape `inbox` prints). This also improves the skill path, which until now told
the host to read the directory by hand.

## Verification

`npm test` covers, in `mcp-gateway.test.ts`:

- a **real stdio JSON-RPC handshake** — `initialize`, `tools/list`,
  `tools/call` — against a spawned `mcp-gateway.mjs`, not a transport mock;
- **stdout purity**: every line on stdout is a JSON-RPC frame, on the error path
  included. One stray line corrupts the session and looks like a broken client
  rather than a broken server, so this is the most likely bug in the file;
- the **exact argv** for all three tools, via a stub CLI on `--xfer-adapterd`,
  so a CLI flag change cannot silently diverge from a tool schema;
- `xfer-adapterd list` and `send -` (stdin document) in `adapterd.test.ts`.

The **loopback end-to-end mesh test** is present but skipped by default: it
needs the pinned `rivet-engine` binary, and a second engine must be given its
own `guard` port and its own database or it half-works in a way that looks like
a broken engine. `XFER_ENGINE_BINARY` opts in; the recipe for a coexisting
engine is in `.agents/skills/verify/SKILL.md` (contributors) — note that
`runner-configs` PUT is rejected by a 2.3.26 engine, so a loopback engine is
currently good for reads and not for a real mesh enqueue.

The gateway itself never touches an engine, so `mesh-guard.ts` is not loaded
here — and it does not need to be. The mesh code path lives in the forked CLI,
which inherits `NODE_TEST_CONTEXT` from the test and is therefore guarded
structurally, exactly as any other spawned adapter is.

**A smoke against a real deployment is a human decision**, per AGENTS.md, and it
buys little that a loopback run does not.
