# Delivery visibility is two axes: Delivery verdict and Handoff outcome

`xfer_to` and `xfer_mesh_to` both returned a constant `status: "sent"` — identical
whether the target was awake, asleep, queued, or gone. Fixing that needs one term that
is **not** `Delivery verdict`: that term is already settled in `CONTEXT.md` as a claim a
*listing* makes about whether one **Node** can receive at all, and the mesh transport
implements exactly that. Milestone 4 item 1 asks for a different claim — where one
**Handoff** came to rest. Two axes, one word; that collision is the decision.

**Two axes, two terms.** *Delivery verdict* stays Node-scoped and unchanged. *Handoff
outcome* is the Handoff-scoped one: where one Handoff came to rest, as far as the network
can honestly tell. Four values — `queued` / `delivered` / `unknown` / `not-delivered` —
shared by both transports, each reaching only the subset it can support (mesh has a
durable queue and can say `queued`; local has none and can say `delivered`).

**Outcome is computed at transport time and promises nothing later.** `pi.sendMessage`
returns `void`, so even the receiver cannot learn what became of a Handoff, and ADR-0015
chose a deliberately lossy take-to-read Inbox with the persistent archive already
rejected. "Was it read" is therefore unreachable, not merely unbuilt. The mesh side had
already reached this ceiling on its own: `not-delivered | unknown | failed`
(`mesh-engine.ts`), where `unknown` is load-bearing precisely because a second send turns
an ambiguity into a real duplicate.

## Consequences

- `unknown` must never advise a retry, on either transport. This is not a style
  preference — it is why the value exists separately from `not-delivered`.
- An ack frame with no outcome field means `unknown`, never `delivered`. Older receivers
  and the broker's forward path therefore degrade toward honesty, not toward a false
  positive.
- Milestone 4 item 0 shrinks to two prerequisites for item 1: `isRuntimeIdle()` must also
  ask `hasPendingMessages()`, or a Handoff parked behind a queued turn reports
  `delivered` falsely; and the local bind must discriminate a live endpoint from a
  crashed one, or `delivered` comes back true about a Node you did not name.
- Outcome says nothing about whether a reverse Handoff follows. Item 4's loop guard
  cannot be built on it — that guard is about the semantic layer, and needs its own basis.
- **There is no inbound `held` state, and adding one to the mesh would not be a feature.**
  Decided 2026-10-19, after the local-only variant was also considered and rejected as not
  worth the state it introduces: accept-everything or stop-listening is the permanent shape.
  `held` cannot work on the mesh at all — the actor's `run` calls `onHandoff` (synchronous,
  `void`) and then writes `recordMeshDelivery` unconditionally on the next line, so a held
  message is recorded as delivered, any redelivery is dropped as a duplicate, and a receiver
  restart loses it. Supporting it would mean changing the durable-queue contract ADR-0013
  defines. This is worth recording because Reason's vocabulary is `stored | delivered | held
  | refused`, so a future reader comparing the two will ask why one value is missing here.
- Local gains no preflight. Its Node axis is degenerate (the endpoint exists or it does
  not), and unlike mesh a false pass costs only a failed connect and a `unlink`.

- A public relay for remote MCP clients (cloud agents, phone hosts) is **deferred out of
  Milestone 4** by decision, not by omission: it is client-role on the mesh
  (`sendMeshHandoff`, no join, no actor) but needs authentication, because an unauthenticated
  endpoint that can enqueue into someone's mesh is a different exposure than the unix socket
  ADR-0019 reasoned about. Auth is something someone maintains; it does not belong to a
  convenience feature. Milestone 4's item 2 is scoped to a local stdio gateway only.
