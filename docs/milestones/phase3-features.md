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

Items 1–3 are the core of the milestone, with P0-D recording the posture they imply. P1-E (a
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
engine's persisted `error` field is stale** — on 2026-10-17 `agent-grok` still read `no_envoys`
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
  `mvbsq4ja-5dnpgd` to `agent-grok` was reported as a 30 s enqueue failure, and it was delivered
  anyway once a runner appeared in that pool — `agent-grok` echoed the nonce and named that exact
  id. `mesh.log` has the error and no success line. So today a sender is told "failed" about a
  message that arrives, and the obvious user reaction (retry) produces a second, genuinely
  duplicate delivery with a fresh id.

**Direction.** A protocol marker in actor state alongside `description` (e.g. `protocol:
"pi-xfer/1"`), read at discovery/probe time, and a pre-send probe that fails in milliseconds with a
distinguishable message: *not a pi-xfer agent* / *no runner attached* / *offline, buffered*. The
marker is self-declared, so it prevents misconfiguration and honest mistakes, not malice — malice is
P1-C's job; say that plainly in the docs rather than overselling it.

**Acceptance.** Sending to a foreign actor errors in well under a second naming the real cause;
sending to a runner-less node names the runner, not "stuck"; an existing node that predates the
marker still works (it is absent-state, not a hard failure). **A timeout must never be presented as
"not delivered"** — the three outcomes are *delivered*, *definitely not delivered*, and *unknown,
may still arrive*, and only the middle one may invite a retry. The receiver must dedupe on handoff
id so that a retry (or a re-delivery) cannot be applied twice.

**Open for design.** Probe surface (`getDescription` reuse vs a new action) and its cost — a probe is
a full RPC, and measured RPC round-trips through the tunnel are ~1 s; whether to cache probe results
per session; whether `/xfer doctor` reuses this check. Also: how long the sender waits before calling
it "unknown", and whether the receiver-side dedupe belongs here or in P1-C (a retry is a new id, so
id-dedupe alone does not catch it — decide whether the sender persists "sent, outcome unknown").

### P1-C — End-to-end encryption of the handoff envelope

**Problem.** The engine holds handoffs in plaintext, in transit and at rest, and an on-path attacker
or a compromised/misconfigured engine can read them, rewrite them (no integrity check), or register
a same-name actor to intercept. TLS fixes the wire but not a TLS-terminating edge (which is exactly
what the user's Cloudflare Tunnel is); a private network is not available to every operator.

**Direction.** Treat the engine as an untrusted transport and keep ADR 0013's model: it still does
discovery, durability, and wake-up; it just stores opaque bytes. Per node: a persistent X25519
keypair, public half in actor state beside `description`. Per handoff: an ephemeral sender keypair,
ECDH against the recipient's static key, HKDF-SHA256, ChaCha20-Poly1305 — all built into Node's
`crypto`, so no new runtime dependency and no native addon. Trust anchored out of band, SSH-style:
`/xfer mesh trust <name> <fingerprint>` over the existing local socket, TOFU on first contact.

This also closes P0-B's malicious half: a forged actor may advertise any public key, but it cannot
decrypt the payload, and it cannot produce a message the trusted key accepts.

**Scope boundary (explicit).** Single recipient; no key rotation; no multi-device per node; no
group handoffs; the board and local sockets are untouched.

**Ordering.** Depends on P0-B for the protocol marker and the probe (you cannot seal to a key you
have no way to look up or trust). It is the largest item here — if the milestone has to shed
something, it sheds P1-C, not P0-A/P0-B.

**Acceptance.** A handoff enqueued for a node is unreadable in the engine's store (grep the data
directory for a marker string — the check that §5.4 of the notes asserted but never ran); a
forged `xfer-instance` actor registered in the same namespace receives ciphertext it cannot open;
the recipient's fingerprint mismatch is a hard refusal, not a warning.

**Open for design.** Envelope encoding (JSON + base64 vs CBOR); where the key file lives and with
what mode (alongside `mesh.config.json` at 0600 is the obvious answer); what `mesh down` must never
destroy; replay handling (handoff id + nonce dedupe — Paseo's stated gap is the one thing not to
copy); how `mesh.log` avoids writing plaintext or key material.

**Required decision record.** A new ADR: the envelope format, the trust model, and the accepted risk
that a first-contact TOFU window is exploitable. ADR 0013 gets a pointer to it.

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

Small, and it gates nothing — but it should land before P1-C changes the wire format, so the two
documents do not contradict each other.

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
| **Reusing paseo-relay's transport** | Its session model is online-only with random-hex IDs — no durable queue, no discoverable names, so it would delete precisely what ADR 0013 provides. Only the E2EE envelope idea is borrowed (P1-C). |
| **Key rotation, multi-device, group handoffs** | Deliberate boundary of P1-C; revisit only when a real need appears. |
| **`/ui` exposure through the tunnel** | An operator action (gate it at Cloudflare Access), not a code change. Documented in the setup guide. |

## Verification duties

- `npm test` green per AGENTS.md, hermetic — the mesh tests must not touch the developer's real
  `~/.pi/xfer` state or the live engine.
- P0-A is visible TUI output: run the `verify` skill.
- P1-C needs a new hermetic test that proves ciphertext-at-rest without a network: seal, hand the
  bytes to the fake engine, assert the plaintext marker is absent.
- The live deployment (`engine.example.com`) is available for end-to-end checks but must never be a
  test dependency.
- P1-E is verified by a documented procedure, not by CI: the closed loop needs the public engine,
  a deployed Worker and the tunnel. Keeping it out of `npm test` is deliberate — a green suite must
  not depend on any of that.
