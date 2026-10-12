# Quickstart

Get your first handoff delivered between two pi agents in about five minutes.

## What is pi-xfer?

pi-xfer lets pi coding agents hand each other **structured markdown documents** — context, problem, requirements — instead of chat fragments. It works out of the box between agents on one machine (local Unix sockets), optionally across machines (the **Mesh**), and can pull structured context straight from your browser (the web picker). The rest of this guide covers the local path; see the architecture map at the end for how the pieces relate.

## Install

```bash
pi install npm:pi-xfer
```

Then start (or restart) pi so the extension loads.

## Your first handoff (30 seconds)

You need **two pi sessions running on the same machine** — open a second terminal and run `pi` in each.

**1. Find each session's xfer name.** In each session, type:

```
/xfer name
```

Each session has an xfer name (shown in the output, and copied to your clipboard). Call them `alpha` and `beta` — you can rename with `/xfer name <new-name>` if you like.

**2. Confirm they can see each other.** In `alpha`:

```
/xfer list
```

You should see `beta` (and every other running session) listed. If not, check both sessions are running and retry after a few seconds.

**3. Send a handoff.** In `alpha`, just ask the agent in plain language:

> Send a handoff to beta asking it to review the error handling in src/server.ts.

The agent composes a structured document (Context / Problem / Requirements / Return address) and delivers it one-way — `alpha` does not wait for a reply.

**4. Read it in `beta`.** The handoff arrives in `beta` as a message:

```
📨 [Xfer from **alpha**]

**Request**: ...
**Doc**: /var/folders/.../pi-xfer-....md
```

Read the doc, do the work, and reply the same way — in `beta`, ask the agent to `/xfer` a handoff back to `alpha`.

That's the whole loop: one-way, structured markdown handoffs between peers.

## Where to go next

| Capability | Command | Guide |
|---|---|---|
| Async collaboration cards | `/xfer board list` | README → Board |
| Web picker (browser → handoff) | `/xfer broker start` + userscript | [`docs/dev/web-picker.md`](../dev/web-picker.md) |
| Cross-machine delivery | `/xfer mesh up` | Mesh setup guide (coming) |
| Local web console | `/xfer admin` | — |

## How the pieces fit together

![Architecture](assets/architecture.svg)

The static image above is an export of the full interactive diagram — **[Open the interactive diagram](assets/xfer-architecture.html)** for pan/zoom, per-node source references, and a dark theme.

Three layers, bottom-up:

- **Peer transport (default)** — every pi session with the extension listens on a Unix socket at `~/.pi/xfer/<name>.sock`. Handoffs between sessions on one machine go directly over this socket. No daemon, no setup.
- **Broker (web picker)** — a small local daemon (`/xfer broker start`) that serves the Tampermonkey userscript. The browser sends **picks** and **records** to the broker, which turns them into a handoff delivered to a peer like any other.
- **Mesh (opt-in)** — join with `/xfer mesh up` and your instance becomes a **Node**: one actor in a shared network with engine-side discovery and a durable queue, so a handoff reaches a Node on another machine even if it's offline when sent. Local socket delivery is unaffected and stays the default.

Glossary for all terms: [`CONTEXT.md`](../../CONTEXT.md). Why the mesh is built the way it is: [`docs/adr/0013`](../adr/0013-xfer-mesh-rivetkit-transport.md).
