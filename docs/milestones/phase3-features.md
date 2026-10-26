# Milestone 3 — Refine the mesh (approved feature list)
[简体中文](phase3-features.zh.md)

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

**Direction (settled).** `mesh list` becomes a four-state table — `●` running/deliverable, `◐`
sleeping/deliverable, `○` no runner in its pool, `⚠` the pool has a runner but the actor record
disagrees — and a new self-only `mesh status` answers "what is *my* state", working **with or without
`up`** (as does `list`). A `✕ destroyed` state was designed and cut: both listing paths filter
`destroy_ts`, so it can never render. Data comes from `/actors` + `/envoys` in parallel, 6 s each.

**Acceptance.** With one pool's runner stopped, the surface marks that node's verdict as *no runner*
and names the pool — never the node — as the reason; a live node is never labelled the same as a
runner-less one. A failed `/envoys` renders every row with `?`, never "offline" and never "no nodes".
Hermetic tests cover the four-state derivation from the raw fields (`connectable_ts`, `sleep_ts`,
`error`, `runner_name_selector`) joined with a fake `/envoys`.

**Constraints discovered.** `deriveActorStatus` maps **any** non-null `error` to `"Crashed"`
(`mesh-engine.ts:79`) — wrong for `no_envoys`, where the actor is `sleep_ts`-sleeping and the failure
is scheduling. The surface must derive from the raw fields, not that helper. `listMeshNodes`
(`mesh-engine.ts:328`) also **drops `pool`**, the join key to `/envoys`; it must gain it, and t011's
observer path needs the same field. `slots` is remaining capacity, not liveness — never surfaced.

**Note.** This is user-visible output in a TUI → the `verify` skill applies.

### P0-B — Peer authenticity and a fast pre-send check

**Problem.** Three faces of one gap.

- Discovery trusts an actor type name, so a forged `xfer-instance` in the same namespace is
  indistinguishable from a real node (`notes-mesh-peer-identity.md`). **Accepted, not fixed** — see
  P1-C's decline; it is mitigated only at the deployment level.
- A send to a target that is not a pi-xfer node fails the same way as a send to a node that is
  merely asleep: 30 s, then "target may be offline or stuck" (`mesh-engine.ts:237,279`).
- **And that failure is ambiguous, not negative.** Proven live on 2026-10-17: the handoff
  `mvbsq4ja-5dnpgd` to `phone` was reported as a 30 s enqueue failure, and it was delivered
  anyway once a runner appeared in that pool — `phone` echoed the nonce and named that exact
  id. `mesh.log` has the error and no success line. So today a sender is told "failed" about a
  message that arrives, and the obvious user reaction (retry) produces a second, genuinely
  duplicate delivery with a fresh id.

**Direction (settled).** A hard pre-send check, not a probe: `/actors` + `/envoys` in parallel with
**6 s each**, blocking the send when the target's pool has no runner — **no override path**. This
costs ~1 s and wakes nothing. No protocol probe is built: the actor type name already classifies the
peer, and `/actors` exposes no state (`include_state` → 400), so reading a marker would cost a 4.4 s
actor wake per node. A self-declared `protocol` field is still written for future use and diagnosis,
but **no logic reads it**, and the rule that governs it is: **a missing field means unknown, never
unsupported.**

**A finding that reframed the mechanism:** the gateway's own actor-ready wait is ~30 s — the same as
`QUEUE_SEND_TIMEOUT_MS` — and returns `503 guard.actor_ready_timeout`. Elapsed time therefore cannot
separate "client timed out" from "engine says this pool has no runner"; only the error **code** can.
`queueSend` currently discards it, stringifying every failure into "target may be offline or stuck".

**Acceptance.** A send to a runner-less pool returns in ~1 s naming the pool, not "stuck". A send
accepted and then answered with `guard.actor_ready_timeout` is **not delivered** (the engine says it
never entered the queue). A send accepted whose client wait expires is **unknown**, and must be
presented as such — never "not delivered", never "retry". Retry is user-initiated only, reuses the
**original handoff id**, and is labelled a recovery probe, not a fix.

**Receiver side.** Dedupe on handoff id: a **3-entry sliding window in actor state** (revisit to 10
if real logs disagree), recorded **after** deliver so a crash repeats work rather than losing a
handoff. A hit is dropped with one `mesh duplicate` log line, checked before the `/tmp` document is
written. Window-edge redelivery is accepted by decision.

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

**Feasibility: confirmed (2026-10-17).** rivetkit 2.3.26 ships a first-class serverless path:
`registry.handler(request)` and `registry.serve()` are public, and edge hosts auto-select the wasm
runtime (`src/registry/native.ts:229`) without touching the native addon. The three wasm refusals
(`startAndWait` → "do not host an envoy"; `listen()`; local SQLite) are scoped to the envoy and the
listener, so ADR 0013's prohibition does not reach a serverless registry. Queue, state and action
surface all have wasm parity — an `xfer-instance` actor ports without a shape change.

**Deliverables — three, and nothing beyond them.**

1. **A verified closed loop.** Deploy an `xfer-instance` actor to Cloudflare Workers, register a
   `serverless` runner-config pointing at it, `mesh send` into it from a local node, and get a handoff
   back out.
2. **Documentation.** Pool kind and addressing; the discipline a serverless actor must follow (reply
   on receipt — enqueue without blocking the run loop; no in-memory state across calls, so anything
   needed later goes through the DO's own persistence); why such a node is a good *destination* for
   buffered work and a poor *source* (no read side, no presence once asleep); the operational
   prerequisites and the documented limits. It must not blur the two persistence layers: rivetkit's
   actor state lives engine-side in remote SQLite (forced under wasm), while the agent's own state
   lives in the Durable Object.
3. **A committed example** under `examples/` — a Quick Start: a Durable Object running a **DeepSeek
   agent loop**, receiving a handoff and replying to its sender. Runnable without an API key first (a
   fixed echo), so the mesh path can be proven before any credential is provisioned.

**Scope line.** This repository guarantees **an agent that can join the xfer mesh and work**. What
that agent actually does — cron wake-ups, collection, summarisation — is platform-specific and belongs
to the reader's own agent repository, so the example stops at the round trip.

**Explicitly experimental, not a supported feature.** No SLA, no network test in CI, and no promise
across rivetkit majors. **Where the banner goes:** the docs page and code comments, but **not** the
README — what will churn is rivetkit's serverless interface, while the capability itself is
stable, so the README states support plainly. The example may carry its own npm dependencies (it is
not the extension); say so explicitly so it is never read as precedent.

**Open / constraints found in design.**

- **Bundling is the untested risk.** npm ships the `--target web` wasm binding only; the Cloudflare
  `pkg-cloudflare` target is a build script, not an artifact, and `@rivetkit/cloudflare-workers` is
  not a 2.3.26 dependency — so the bare `runtime: "wasm"` + `registry.handler()` path is the one to
  use.
- **`ensureRunnerPool()` hardcodes `{ normal: {} }`** (`mesh-engine.ts:311-325`) and cannot create a
  serverless pool. The CF pool is registered out of band; no command may be pointed at it.
- **Cross-pool sends need no escape hatch** — verified live: `get` addresses an actor by key
  regardless of its pool (a request from one pool to a node in another returned 200). The concern
  above is withdrawn.
- **Verification is the one live-deployment exception** (recorded in `AGENTS.md`): a Durable Object
  has no local stand-in, so the closed loop is proven by a manual, written-down procedure kept out of
  `npm test` and out of every script.

**Shipped (2026-10-18).** `examples/cf-serverless-node/` — a Worker hosting the `xfer-instance`
actor in rivetkit's wasm runtime, bridged to a Durable Object that runs a stub agent
(`answerHandoff()`: a fixed echo, or one DeepSeek call when a key is set). The closed loop was
verified by hand on a real deployment, procedure in `VERIFICATION.md`.

What did **not** ship is the Pi Durable half of the Opportunity above: no Pi Durable harness runs
inside the Durable Object, and nothing depends on one. The example is the transport; the agent
behind `POST /agent/answer` is the seam a reader fills in. The directory was renamed from
`examples/pi-durable-cf/` to `examples/cf-serverless-node/` on 2026-10-22, so the name does not
promise an agent framework the example does not contain — the guide moved with it to
`docs/guides/cf-serverless-node.md`.

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
- The live deployment is available for end-to-end checks but must never be a test dependency, and is
  never wired into a script or a sub-agent's default instructions (see `AGENTS.md`). The one carve-out
  is P1-E's example, which cannot be exercised any other way.
- P1-E is verified by a documented procedure, not by CI: the closed loop needs the public engine,
  a deployed Worker and the tunnel. Keeping it out of `npm test` is deliberate — a green suite must
  not depend on any of that.
