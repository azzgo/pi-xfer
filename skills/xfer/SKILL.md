---
name: xfer
description: Send and pick up structured handoff documents over the xfer network (pi-xfer) — local Unix-socket peers on this machine and cross-machine mesh nodes such as the grok bot node. Use when asked to hand work off to another agent or node, to check which nodes are online or what they handle, or to collect inbound handoffs addressed to this machine.
---

# xfer

xfer moves **structured handoff documents between agents** — not chat fragments. The receiver gets a document it can act on, plus a return address it can send results back to.

Two transports, one interface:

- **local** — Unix-socket peers on this machine at `~/.pi/xfer/<name>.sock`. Every pi session with the extension is one. **Sending needs no daemon.**
- **mesh** — cross-machine over RivetKit actors (`~/.pi/xfer/mesh.config.json`). `mesh send` uses a throwaway client, so it can enqueue to a remote node **without joining the mesh itself**.

## Invocation

Everything goes through this skill's wrapper, which resolves the daemon bundle (no path to hardcode):

```sh
~/.agents/skills/xfer/scripts/xfer <args>
```

The script is `scripts/xfer` beside this file.

## Discover who's out there

```sh
scripts/xfer peers
```

Read-only. Prints two groups:

- **LOCAL** — a filesystem scan of `~/.pi/xfer/*.sock`, merged with each `<name>.json` (status, cwd, description). Same read as `listTargets()`.
- **MESH** — a live engine query (`GET /actors?name=xfer-instance`) showing actor `status` and `pool`. This is the "observe without joining" read, not a node registration.

**Descriptions are self-declared and best-effort.** Local ones come from `<name>.json` or the durable `descriptions.json` store; a remote node's note only appears if it was cached locally. If a description actually matters, read it from a pi session.

## Send a handoff

Write the document first — it *is* the payload; the summary is only a label:
```markdown
kind: task | notification

# <one-line title>

## Context
<what this is, why now>

## Problem
<the concrete thing to solve>

## Requirements
<acceptance criteria — what "done" means>

## Return address
<the sender's node name, for the one return a task gets>
```

```sh
# to a local peer on this machine
scripts/xfer send <target> /tmp/h.md "<one-line summary>" --kind <task|notification> --from <my-node-name>

# to a mesh node (no join, no daemon required)
scripts/xfer mesh send <target> /tmp/h.md "<one-line summary>" --kind <task|notification> --from <my-node-name>
```

- `--kind` is required and is the whole reply contract — the send tool writes the `kind:` header line into the delivered doc, overriding whatever the file says, so never hand-write it. `task` obliges the receiver to send exactly one handoff back once it has a conclusion — done, blocked, or needing input. `notification` asks for nothing: the receiver stays silent unless it is missing information, or the doc conflicts with fact. Sending without a kind fails loudly; sending with the wrong one costs you the reply, silently.
- Prints the handoff id; exit 0 means **enqueued**, not done. There is no reply wait, and a task's conclusion arrives as a separate handoff — never block on it.
- **Never guess a target.** Get names from `peers`. `<target>` is a local socket name for `send` and a mesh node name for `mesh send`.
- Sending to a node that has **never** been online does not buffer — it errors after ~30s. A node that was online before and went offline **is** buffered and receives on rejoin.

## Pick up inbound handoffs

Only when a resident daemon runs under that name (see below):

```sh
scripts/xfer inbox list --name <my-node-name>   # peek — consumes nothing
scripts/xfer inbox take --name <my-node-name>   # consume — read the docs
```

`take` is **consume-on-read** and consumes **every** pending record in one call — the record is deleted the instant it is printed. `list` first; take only when actually processing. Each printed line is one JSON record with `from` / `summary` / `file` / inline `document`, plus `transport` (`local` or `mesh`).

> ⚠️ **Empty output is ambiguous.** A missing inbox file returns `[]` with exit 0, so "nothing pending" and "no daemon ever ran under this name" look identical. If liveness matters, check `peers` (the name appears as a socket) rather than trusting an empty inbox.

**Acting on a handoff.** The doc's `kind:` line decides the return. A `task` gets exactly one handoff back once you hold a conclusion — done, blocked, or needing input; a bare "finished" is not a conclusion. A `notification` gets nothing back unless you are missing information you need, or the doc conflicts with fact. Never send a handoff just to acknowledge: a receipt is not a reply.

## Being reachable

Sending needs nothing resident. **Receiving needs a daemon that outlives any one agent session** — start it once under launchd or tmux and leave it:

```sh
scripts/xfer up --name <my-node-name> --on-handoff ~/xfer/wake.sh
```

- **Local-only by default.** `up` opens a Unix socket on this machine and nothing else; `--mesh` is the explicit opt-in for being reachable across machines. Success with `--mesh` ends in `[mesh]` — no `[mesh]` means the mesh half failed.
- `--once` means **exit after the first handoff**, not "start and exit". Do not use it as a startup probe — with no traffic it hangs forever.
- `--check` starts the daemon, prints what came up, and exits — the **one-shot probe**. Use it when you want to know "would this work?" without leaving a process behind.
- It must be supervised (`KeepAlive`, or `while true; do …; sleep 5; done`). **5s restart backoff** covers the engine's heartbeat window for same-name takeover; a status-aware `up()` adopts its own crashed/sleeping actor rather than refusing.
- **Do not start a resident daemon from an agent session** — backgrounded processes do not survive the session. That one belongs to the human.

## Leaving the mesh

A mesh actor outlives the process that made it. If your daemon dies, the engine still lists your name, and the next `up` is refused with *"already Running elsewhere"* — a failure that reads like another machine stole the name. Destroy the actor to release it:

```sh
scripts/xfer mesh down --name <my-node-name>
```

This only removes the **mesh** half: the local socket and the inbox are untouched, so local peers keep working. It is the same destroy the admin page's "mesh down" button performs.

## Web picker follow-ups (page-tool)

**A web-picker handoff carries its own follow-up channel: the broker's
page-tool CLI — use it instead of opening a browser.** The channel is described
in the handoff itself, under `## Follow-up channel`; the op table is also
available as `node <broker CLI> page-tool --help`.

Every call must name its tab explicitly (ADR-0022 — the tabId is in the handoff's `## Page`
section, `- tabId: <id>`; the command example in the same doc already carries
it as `--tab`). The submit ack's `routedTabId` goes to the browser, not to you:

```sh
node <broker CLI path from the handoff> page-tool <target> <op> [paramsJSON] --tab <tabId>
```

The path the handoff names is the runnable one (`dist/broker.cjs` on an npm
install). Do not substitute `daemon/broker-main.ts`: node refuses to type-strip
a `.ts` file under `node_modules`.

- **`missing_tab`** — you called without `--tab`. Read the tabId from the
  handoff's `## Page` section and pass it. Never guess one: a guessed id is a
  `tab_unreachable` in disguise, indistinguishable in the log from a closed page.
- **`tab_unreachable`** — that page is closed or the picker disconnected.
  **Stop and ask the human** to reopen the page (title/url are in the
  handoff) or reconnect the picker. Do not retry: a page-lifetime tab id
  never comes back on its own.
- Distinguish this from **connection-layer failures** (`timeout` right after
  a reload): those recover by themselves within seconds — wait and retry ≤3
  times is fine there. Only a *routing* failure is a HITL stop.
- A **staging-bag handoff** covers several pages: each "## Page:" section
  carries its own `tabId`. Per-page follow-ups take the tabId from that
  section — staged markers may come from pages other than the sender's.

## Guardrails

- **`inbox take` is destructive.** `list` first, never take on speculation.
- **Do not invent targets or endpoints.** Node names come from `peers`; engine config comes from `mesh.config.json`.
- **Redact secrets** from handoff documents — they land as files on another machine.
- A mesh node whose actor sits in a `pool` with no runner-config **looks online but receives nothing**. If a node in `peers` never picks anything up, suspect the pool, not the message.
- Handoffs are point-to-point by name. There is no broadcast.
- **Give a shell command a `timeout`.** The bash tool has no default deadline, so a command that never exits blocks the turn indefinitely. Pass `timeout: 1800` (30 minutes) on anything long, `timeout: 60` on a quick probe. This is a backstop, not a plan: a command that only exits on a timeout is a bug in the command. (Only bash has this parameter — the file tools finish or fail on their own.)
- **Never run a resident daemon in the foreground of a tool call.** `up` without `--check` never returns. Use `--check` to probe, and leave the real daemon to launchd or tmux.

## Facts worth keeping straight

| Thing | Truth |
|---|---|
| `up` default transport | local Unix socket only — `--mesh` is opt-in |
| `--mesh=true` | not recognised; use the bare flag |
| `--once` | exits after the *first* handoff |
| `--check` | starts, reports, exits — the one-shot probe; `up` alone never returns |
| `--help` | prints usage and exits; it never starts a daemon |
| `mesh down` | destroys the mesh actor only; the local socket and inbox stay |
| `inbox` model | take-to-read, no retention |
| `mesh send` | enqueues without joining; needs only `mesh.config.json` |
| `.sha256` files in pi-xfer | hash only, **no filename** — plain `sha256sum -c <file>` fails |
| credentials | `namespace`/`token` fields only — URL userinfo is refused; `token` may be `$VAR` or `!command` |
