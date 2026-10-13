# xfer-adapterd: one bundle, dual transport, take-to-read Inbox

Status: accepted

## Context

pi reaches the xfer network through the extension. Every other agent host
(Cursor, grok bot, a custom harness) can also own an xfer socket, but has no pi
runtime to host the extension, no `/xfer` command surface, and no way to run the
mesh actor loop. The settled access mechanism is a single self-contained bundle,
`xfer-adapterd.cjs`, that a host launches as a background process (ADR 0013
established the mesh transport it joins).

The constraints that shaped it: nothing host-specific may leak into names or
protocol; the extension's local protocol is the wire contract
(`xfer-notify`/ack JSONL, 1 MiB frame cap); the daemon must be usable on a host
that never ran pi; and the build shares the mesh runtime's native-addon rewrite
so no runtime npm dependency appears.

## Decision

**One bundle, dual transport.** `xfer-adapterd` serves the local Unix-socket
transport by default and can join the Mesh with the same `MeshNode` the
extension uses. Names stay transport-neutral; only the mesh transport module
mentions the engine. `up` joins the mesh when asked (`--mesh`, config from
`~/.pi/xfer/mesh.config.json` or `--engine/--namespace/--token`); `mesh send`
enqueues a one-shot handoff without joining, so a send-only host needs neither
daemon nor registration.

**Inbox is take-to-read.** Inbound handoffs are appended to a JSONL Inbox
(`<encoded-name>.inbox.jsonl`) before anything else; `inbox take` atomically
renames the file aside and consumes the records, so a concurrent append lands in
a fresh file and survives. `inbox list` peeks without consuming. There is no
durable storage design behind the Inbox.

**Deliver strategies.** Inbox-first always. `--on-handoff <cmd>` is a
best-effort second strategy: the handoff JSON goes to the command's stdin with
`XFER_HANDOFF_ID` / `XFER_HANDOFF_FROM` / `XFER_HANDOFF_FILE` in the
environment. A failing strategy never takes the process down. A `url` strategy
(HTTP POST) is deferred pending research and is deliberately not reserved as a
flag.

**Install artifacts.** `install --host <cursor|generic> --into <dir>` fixes the
skill in place: `SKILL.md` (generic operations: up / send / inbox take / rename),
`install.md` for self-install, a host overlay page, and `.xfer-agent.json` with
the host kind, defaults, and the recommended launch command generated at install
time — agents never construct adapter flags themselves. `skills/xfer-agent/` in
the repo is the template source of truth; distribution is a manual copy.

## Consequences

- A non-pi host is a first-class Node: it can be a local target and a mesh
  actor, and can hand off to pi and to other adapter hosts.
- The daemon bundle inlines the mesh runtime (same esbuild recipe and native
  rewrite as `mesh-runtime.cjs`); the native addon is still downloaded on first
  mesh join into `~/.pi/xfer/cache`.
- Send-only hosts can skip the daemon entirely; only a receive-capable host runs
  the background process.
- The Inbox is lossy by construction (take deletes). That is the point: it
  matches "one way, deliver into the session", not a durable mailbox.

## Considered

A per-host integration (Cursor extension, MCP server, …) — every host would
re-implement the same socket and mesh loop. A persistent mailbox — contradicts
the one-way handoff model and needs a cleanup story. A separate transport per
host — breaks the "one name, one participant" Node contract.
