# Milestone 3 — Refine the mesh (approved feature list)

> Brainstorm closed 2026-10-17, user-approved. Scope: the mesh transport, after it went from
> "documented but unexercised" to a real deployment behind a Cloudflare Tunnel. Next node: design.
>
> Evidence trail (all of it gathered this round, read-only or live):
> `notes-mesh-transport-encryption.md` (transport security, encryption, tunnel cost, live test),
> `notes-mesh-peer-identity.md` (peer identification), `notes-mesh-boundary-extension.md` (CF actors,
> phone as an input source).

## Why this milestone exists

The mesh was designed around engine-side discovery and a durable queue (ADR 0013), and for a long
time nobody had run it against a hostile-enough reality. This round it was deployed for real —
`https://engine.example.com/` through a Cloudflare Tunnel — and three things surfaced that the design
never had to answer before:

1. **A node that cannot receive anything looks exactly like a node that can.** Four actors listed,
   all reported `Sleeping`, only two had runners attached. The difference lives in the engine's
   actor record (`error: no_envoys`) and in `/envoys`, and neither is surfaced to the user. The
   first send therefore cost a 30 s timeout and a wrong hypothesis.
2. **Peer identity is the actor type name and nothing else** (`xfer-instance` + a key). No
   handshake, no credential. A same-namespace actor can be listed and can receive a handoff in
   plaintext.
3. **Nothing on this path is encrypted by us, or by Rivet.** TLS is purely a function of the
   `endpoint` scheme, the control plane speaks plain HTTP by default, and the admin token is a root
   credential. The deployment guide now says so; the code still has no answer for "the transport is
   not trustworthy".

Items 1–3 are the core of the milestone, with P0-D recording the posture they imply. Item 3 was
resolved by **declining** application-layer encryption on 2026-10-17 (see P1-C below) — transport
security stays a deployment concern, and P0-D's ADR is where that decision is recorded. P1-E (a
Cloudflare actor as an ordinary mesh node) was added by the user after the first draft as an
experimental deliverable: closed loop, docs, and a committed example. Everything else that was on
the table is recorded as out of scope below, deliberately, so the next round does not relitigate it.

## Ordered list

### P0-A — Mesh node status: "can this node receive a handoff?"

**Problem.** `/xfer mesh list` prints names only (`commands.ts:384` maps `n.name`), and `peers`
reports every actor as `Sleeping` even when two of them have no runner and cannot be woken. The
distinguishing fact is already fetched and thrown away: `MeshNodeInfo.status` from the actor record,
plus `/envoys` (per-pool live runners, `last_ping_ts`, `last_rtt`). A user's only signal today is a
30 s timeout after they hit send.

**Direction.** Surface reachability, not just existence. A node whose pool has no live envoy should
read as *not deliverable* with the reason, distinct from *offline-but-buffered* and *unknown*. The
data source question (actor `error` field vs `/envoys` vs both) is a design decision, not a
brainstorm one.

**Acceptance.** With one pool's runner stopped, `mesh list` (or its successor) marks that node as
undeliverable and names the reason, and does not label a runner-less node the same as a live one.
Tests cover status derivation for every combination the engine can report.

**Open for design.** Whether this extends `mesh list` or becomes `/xfer mesh status`; whether to show
`last_rtt`/latency; whether `peers` (the adapter-side surface) gets the same information. **The
engine's persisted `error` field is stale** — on 2026-10-17 `phone` still read `no_envoys`
while its pool had a live runner — so the surface must reconcile the actor record against live
`/envoys` data rather than trusting the error field alone.

**Note.** This is user-visible output in a TUI → the `verify` skill applies.

### P0-B — Peer authenticity and a fast pre-send check

**Problem.** Three faces of one gap.

- Discovery trusts an actor type name, so a forged `xfer-instance` in the same namespace is
  indistinguishable from a real node (`notes-mesh-peer-identity.md`).
- A send to a target that is not a pi-xfer node fails the same way as a send to a node that is
  merely asleep: 30 s, then "target may be offline or stuck" (`mesh-engine.ts:237,279`).
- **And that failure is ambiguous, not negative.** Proven live on 2026-10-17: the handoff
  `mvbsq4ja-5dnpgd` to `phone` was reported as a 30 s enqueue failure, and it was delivered
  anyway once a runner appeared in that pool — `phone` echoed the nonce and named that exact
  id. `mesh.log` has the error and no success line. So today a sender is told "failed" about a
  message that arrives, and the obvious user reaction (retry) produces a second, genuinely
  duplicate delivery with a fresh id.

**Direction.** A protocol marker in actor state alongside `description` (e.g. `protocol:
"pi-xfer/1"`), read at discovery/probe time, and a pre-send probe that fails in milliseconds with a
distinguishable message: *not a pi-xfer agent* / *no runner attached* / *offline, buffered*. The
marker is self-declared, so it prevents misconfiguration and honest mistakes, not malice — malice is
nobody's job any more (P1-C was declined); say that plainly in the docs rather than overselling it.

**Acceptance.** Sending to a foreign actor errors in well under a second naming the real cause;
sending to a runner-less node names the runner, not "stuck"; an existing node that predates the
marker still works (it is absent-state, not a hard failure). **A timeout must never be presented as
"not delivered"** — the three outcomes are *delivered*, *definitely not delivered*, and *unknown,
may still arrive*, and only the middle one may invite a retry. The receiver must dedupe on handoff
id so that a retry (or a re-delivery) cannot be applied twice.

**Open for design.** Probe surface (`getDescription` reuse vs a new action) and its cost — a probe is
a full RPC, and measured RPC round-trips through the tunnel are ~1 s; whether to cache probe results
per session; whether `/xfer doctor` reuses this check. Also: how long the sender waits before calling
it "unknown", and where the receiver-side dedupe lives (it stays in this item now that P1-C is
declined; because a retry reuses the original id, id-dedupe is now a workable key — decide what
record keeps it and for how long).

### P1-C — Declined: no application-layer encryption (decided 2026-10-17)

**Status: declined on ROI, not deferred and not shed under pressure.** Read this section as a
decision record; do not re-open it without new evidence.

**What was proposed.** A per-node X25519 keypair published in actor state, a per-handoff ephemeral
sender key, ECDH → HKDF-SHA256 → ChaCha20-Poly1305, and out-of-band trust via
`/xfer mesh trust <name> <fingerprint>` with TOFU on first contact.

**Why it was declined.** The comparison is asymmetric in the wrong direction:

| Approach | Protects | Cost |
|---|---|---|
| E2EE envelope | the handoff payload only | keypair lifecycle, a TOFU window exploitable by construction, envelope format to version forever, replay handling, a new ADR, ongoing maintenance |
| Tailscale / EasyTier | the **entire link** — payload, admin token, control plane, RPC metadata | install once, zero code |
| TLS-terminating edge (Cloudflare Tunnel) | the wire | zero code, but the edge operator can read everything |

The cheapest option protects more. The envelope would also have added a permanent security surface
— key material at rest, a first-contact trust window, a versioned format — for a deployment that is
one operator's own machines, not a shared multi-tenant control plane.

**Consequence that is accepted, not fixed.** A foreign `xfer-instance` actor in a live pool remains
indistinguishable from a real node (the impersonation half of P0-B). The envelope was what would
have closed it. This is now a **documented accepted risk**, mitigated only at the deployment level
(keep the engine off untrusted networks). Do not file it as a bug.

**What moved elsewhere.**
- **Receiver-side dedupe survives** as its own item under P0-B. It was never an encryption concern:
  P0-B's retry reuses the original handoff id for traceability, and the durable queue can redeliver
  a message whose runner died before acking — so the same handoff can be applied twice.
- **P0-D's ADR now carries the decision**, including the deployment-shape ordering and the accepted
  impersonation risk. There is no successor document to point at.

**What this does not reopen.** ADR 0013's transport choice stands; the burden simply shifts onto
the deployment, which is why P0-D's ADR must be explicit about acceptable shapes.

### P0-D — Record the transport-security posture (docs only)

**Problem.** "Transport security is the operator's duty; pi-xfer ships no crypto; a TLS-terminating
edge reads your traffic" is now written in `docs/guides/mesh-setup.md`, but not as a decision. The
next person will otherwise re-derive it, or quietly assume the mesh is safe because it moved to
HTTPS.

**Direction.** One short ADR (or an explicit accepted-risk section in the mesh-transport ADR)
stating: no application-layer crypto is shipped; TLS is a function of the endpoint scheme; the
control plane speaks plain HTTP; the admin token is a root credential; the operator owns the
transport. Include the deployment shapes that are acceptable, and the two tunnel facts measured
here (per-RPC cost ~1 s; the native runner pings continuously, so an edge idle timeout does not reach
it).

This ADR is now the **only** place the encryption posture lives (P1-C was declined), so it must
state the boundary as settled and carry the deployment-shape ordering: protocol-level tunnel
(Tailscale/EasyTier) over a TLS-terminating edge, because the edge operator sits inside the trust
model. It must also record the accepted open risk that a foreign `xfer-instance` actor is
indistinguishable from a real node.

### P1-E — Cloudflare actor as a mesh node (closed loop, docs, example)

**Opportunity.** The first mesh node that costs nothing to keep alive: a serverless pool holds an
`xfer-instance` implementation that bridges to a Pi Durable harness inside a Durable Object, so the
node wakes when there is work and is otherwise absent. The intended use is the user's own: wake on a
schedule, collect and summarize, and — when it is worth telling someone — send a handoff over the
mesh to an always-on agent. Addressing stays `actor type + key`; a sender that omits `poolName`
reaches it across pools. Background and the feasibility argument are in
`notes-mesh-boundary-extension.md`.

**Deliverables — three, and nothing beyond them.**

1. **A verified closed loop.** The engine is already publicly reachable (`engine.example.com`), which is
   the prerequisite the notes identified. Create a `serverless` runner-config pointing at the Worker
   endpoint, deploy a bare `xfer-instance` actor to Cloudflare Workers, `mesh send` into it from a
   local node, and get a handoff back out. **No agent logic in this step** — it only has to prove
   that Cloudflare is an ordinary node on the mesh.
2. **Documentation.** Pool kind and addressing; the discipline a serverless actor must follow (reply
   on receipt — `submit` without waiting; no in-memory state across calls, so anything needed to
   answer goes into actor SQLite); why such a node is a good *destination* for buffered work and a
   bad *source* (it has no read side and no persistence once gone); the operational prerequisites and
   the documented limits.
3. **A committed example** under `examples/` (the directory does not exist yet; this item creates
   it) — runnable, with the deploy steps, small enough to read in one sitting.

**Explicitly experimental, not a supported feature.** No SLA, no network test in CI, and no promise
that the example keeps working across rivetkit majors. Say so at the top of both the example and the
docs page.

**Open for design — the first one can sink the item.**

- **Does rivetkit 2.3.26 support serverless workers at all?** Unverified. Confirm before anything
  else. If it does not, this item becomes "documented negative result + what it would take", which
  is still a legitimate deliverable but changes the shape of the milestone.
- `getOrCreate` pins this host's own creation to `config.pool` (`mesh-engine.ts:197-200`); sending
  across pools needs an explicit escape hatch, and adopted actors do not move pools (`mesh.ts:208`).
- Whether the second step uses the real Pi Durable harness or a minimal stand-in for the reply path,
  and how that return path authenticates.
- The example may carry dependencies of its own — it is not the extension, so the "no runtime npm
  dependencies" rule does not apply to it; say so explicitly so nobody later reads it as precedent.

**Risk.** This is the item most likely to be blocked by an upstream we do not control. Schedule it
last, and treat a written negative result as an acceptable outcome rather than letting it stall the
milestone.

## Out of scope for this milestone

| Item | Why not now |
|---|---|
| **Phone as a push-only input source** | Thought experiment only. Native iOS cannot host the runner (no native addon), Android/Termux is excluded by the user, so the only role left is a sensor input with no read side. Not this milestone. |
| **Native runner on mobile** | Ruled out technically: rivetkit's envoy requires a native addon; wasm is not an option. |
| **Engine-side always-on runner** | Rejected by ADR 0013; not reopened. |
| **Reusing paseo-relay's transport** | Its session model is online-only with random-hex IDs — no durable queue, no discoverable names, so it would delete precisely what ADR 0013 provides. Its E2EE envelope was the one idea borrowed, and it was then declined on ROI (P1-C). |
| **Key rotation, multi-device, group handoffs** | Moot: with application-layer encryption declined (P1-C) there is no key material to rotate or share. Revisit only if encryption is ever revisited. |
| **`/ui` exposure through the tunnel** | An operator action (gate it at Cloudflare Access), not a code change. Documented in the setup guide. |

## Verification duties

- `npm test` green per AGENTS.md, hermetic — the mesh tests must not touch the developer's real
  `~/.pi/xfer` state or the live engine.
- P0-A is visible TUI output: run the `verify` skill.
- The receiver-side dedupe (P0-B) needs a hermetic test: deliver the same handoff id twice and
  assert it is applied once — no network, no real `~/.pi/xfer`.
- The live deployment (`engine.example.com`) is available for end-to-end checks but must never be a
  test dependency.
- P1-E is verified by a documented procedure, not by CI: the closed loop needs the public engine,
  a deployed Worker and the tunnel. Keeping it out of `npm test` is deliberate — a green suite must
  not depend on any of that.
