# Mesh log — what is in it, what is not, how it is maintained

The mesh transport runs **in-process** inside pi (ADR 0013) and is pinned quiet,
because RivetKit logs the way a standalone server does — straight to the
process's stdout — and every one of those lines lands on the pi screen instead
of a redraw (`/xfer mesh up` used to smear the welcome banner and native SQLite
warnings across the TUI). Quiet must not mean lost, so what can be captured is
still written down:

```
~/.pi/xfer/mesh.log      append-only, one logfmt line per record, mode 0600
```

Read it with `tail -n 50 ~/.pi/xfer/mesh.log` (or `less +G`). It is a file for
humans and is never fed back into an agent's context.

```
2026-10-14T07:09:39.991Z level=info msg="mesh up" node=bugfix endpoint=http://engine.example.com:6420 namespace=default pool=workstation nativeLogLevel=silent adopted=Sleeping
2026-10-14T07:12:04.006Z level=info msg="mesh send" from=bugfix to=phone id=k3f9 bytes=4821
2026-10-14T07:12:31.880Z level=warn msg="mesh misroute" id=k3f9 from=bugfix to=phone reached=bugfix
```

## Two producers, one timeline

| Producer | Where it is wired | Records |
|---|---|---|
| RivetKit's own JS logger | `setup({ logging: { baseLogger: createMeshLogSink() } })` in `mesh-engine.ts` (`ensureNode`) | `starting rivetkit envoy`, api calls, engine/actor warnings, actor-scoped lines (`child({actorName, actorKey, …})` bindings are merged in) |
| pi-xfer's mesh events | `logMeshEvent(...)` calls in `mesh.ts` (`up` / `down` / `send` / inbound / misroute) | node lifecycle, refusals (`mesh up refused — …`, pool mismatch), send/inbound ids and sizes, misroutes |

Everything lands in `mesh-log.ts`: `formatMeshLogLine` (logfmt),
`appendMeshLogLine` (never throws — a broken log target must not take the mesh
down), `createMeshLogSink` (the logger handed to RivetKit) and `logMeshEvent`.

Handoff **bodies never reach the log** — only ids, node names, byte counts and
the inbound tmp doc path. Keep it that way when adding an event: the log is
long-lived and world-readable to whoever has the account, documents are not.

## What is not in it, and why

**The native runtime's own tracing output** — the `ts=… level=warn
message="SQLite transaction is unnamed…"` lines. RivetKit's native addon (Rust)
writes those directly to the process's stdout at fd level; they never pass
through `process.stdout.write`, so no JS in this process can see them, let alone
redirect them. Measured on rivetkit 2.3.26 with `process.stdout.write` patched:
only the JS logger's chunks arrive, while the Rust lines keep going to the
terminal. There is also no `RIVET_LOG_*` variable that selects a file — the
knobs are `RIVET_LOG_LEVEL`, `RIVET_LOG_TARGET`, `RIVET_LOG_TIMESTAMP`,
`RIVET_LOG_MESSAGE`, `RIVET_LOG_ERROR_STACK` (and `RUST_LOG` is ignored).

They exist on a terminal only, when the host launches with an explicit level:

```bash
RIVET_LOG_LEVEL=warn pi     # native warns appear on screen (and will smear it)
```

Rust *panics* are a different path — they go to stderr unfiltered and are
unaffected by `RIVET_LOG_LEVEL`.

So a support question that needs native detail has to be answered by
reproducing with that level set, or by capturing the terminal (`tmux
capture-pane -pS -3000`) — it cannot be answered from `mesh.log` after the fact.

## Maintaining it

- **Adding an event**: call `logMeshEvent(logPath, level, "mesh <what>", {
  fields })` from `MeshNode` — it already holds the target path in `this.logPath`.
  Prefer one record per outcome (success/refusal/failure) over a start/end pair.
- **File level**: `MESH_LOG_LEVEL` in `mesh-log.ts` is a **constant**, currently
  `info`, deliberately not an env knob — the point of the file is that the detail
  is already there when a problem turns out to need it, and nobody can turn it on
  after the fact. Raising it (e.g. to `debug`) is a source edit; it adds
  RivetKit's chatty api-call lines, so do it on a branch, not on main.
- **Hermetic tests**: never let a test write the real `~/.pi/xfer/mesh.log`.
  `MeshNodeOptions.logPath` and `RivetEngineOptions.logPath` are the injection
  seams; `mesh.test.ts` uses `meshLogPath()` for every node it builds.
- **RivetKit upgrades**: `createMeshLogSink` is duck-typed on purpose — Pino is
  only a build-time transitive of rivetkit (ADR 0013 keeps it out of every
  dependency list), so the sink implements the surface RivetKit actually calls.
  On a version bump, re-check that surface before trusting the log:
  `grep -rno "logger[0-9]*()\.[a-zA-Z]*(" node_modules/rivetkit/dist/tsup/*.js | sed 's/.*()\.//' | sort -u`
  should still be `child`, `debug`, `error`, `info`, `trace`, `warn`.
- **Growth**: the file is append-only with no rotation, like `broker.log` and
  `admin.log` — it is human-cleaned (`rm ~/.pi/xfer/mesh.log` is always safe).
- **Verifying a change**: `npm test` covers the sink and the events; the
  end-to-end check is `/xfer mesh up` followed by reading the file — the screen
  must stay clean while `mesh.log` gains the session's records.
