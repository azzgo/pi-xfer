# Status-aware actor adoption in mesh up()
[简体中文](0016-actor-adoption.zh.md)

Status: accepted

## Context

ADR 0013 fixed "name conflict: check first, then occupy — refuse, do not
auto-rename", because the same actor key routes to whichever actor already
exists. That rule was implemented as an unconditional refusal: any same-name
actor in the engine listing blocked `up()`. It was written before the mesh had
a routine crash story, and it made recovery require a manual `down` on the other
host — even when that host was already gone.

Rivet's actor lifecycle makes most same-name actors not competitors at all:

- Virtual actors are never auto-cleaned. When a runner is lost (the pi process
  dies, the machine sleeps, the network drops), the engine puts the actor to
  sleep rather than deleting it; its durable state is preserved.
- A lost actor therefore commonly reads as `Sleeping` (or `Crashed`, or
  a `Pending` allocation that never became connectable), not as a live
  participant. Its name is free to be taken over by whoever reconnects first.
- Actor status is a pure function of the engine's timestamp fields
  (`destroy_ts` / `error` / `sleep_ts` / `connectable_ts`); there is no status
  field on the actor listing.

The one unsafe case is `Running`: a live runner is connected right now, and a
second process resolving the same key silently routes its traffic there.

The remaining sharpness is the heartbeat delay. A just-crashed actor may keep
`connectable_ts` set (and thus read `Running`) until the engine notices the
runner is gone. Adoption deliberately adds no retry loop: a single read of the
listing decides, and a fresh corpse may require one more `up()` a moment later.

## Decision

`MeshNode.up()` becomes status-aware, with no `--takeover` flag and no separate
code path for pi and the adapter daemon — it is one behavior for every host:

- **name not found** → normal create.
- **same-name actor `Sleeping` / `Crashed` / `Pending`** → adopt: re-resolve the
  existing actor in this process (`getOrCreate` + `resolve()`) so this process's
  run loop owns it. Durable actor state (the node description) is preserved, and
  the actor is **never destroyed** on the adopt path.
- **same-name actor `Running`** → refuse, and point at the other host
  (`先在那边 /xfer mesh down`).

`down()` remains the only destroying path: it is what a deliberate offline
transition means, and adoption must not be confused with it.

## Consequences

- A crashed host no longer needs a manual `down` elsewhere; the next `up()`
  under the same name recovers the node, its description included.
- A genuinely concurrent start still fails safe: a `Running` actor is refused.
- The heartbeat window is a documented rough edge, not a bug to paper over with
  retries in this iteration.
- `MeshNodeInfo` now carries `status`; `/xfer mesh up` and the adapter daemon
  share the same hermetic tests (adopt on sleeping, refuse on running).

## References

- ADR 0013 (mesh transport) — the conflict rule this refines.
- ADR 0015 (adapter daemon) — the second host that shares this lifecycle.
