# Milestone 4 — 通讯面：让投递可被看见（approved feature list）
[简体中文](phase4-features.zh.md)

> Brainstorm closed 2026-10-18, user-approved. Next node: **design**.
>
> **Items 0 + 1 are designed.** `phase4-design-p0-p1.md` (ADR-0020) collapses item 0 into
> two prerequisites for item 1; the ordering assumed in note 1 below was derived, not given.
> Items 2–5 remain undesigned.
>
> **What this file is.** A gap list with its evidence. **What this file is not.** A solution list.
> Every item below states what is missing and what is known about the cost; none of them states how to
> build it. The user asked explicitly that no feature preference be presumed here, because the design
> discussion has not happened yet. Where a decision was already made by the user it is recorded as such.
>
> Evidence trail (all gathered this round, read-only, no code changed):
> `notes-reason-network-wake.md` (delivery tiers + external survey of Reason's own design),
> `notes-transport-matrix.md` (the six transport surfaces, end to end),
> `notes-pi-runtime-primitives.md` (what the pi runtime actually exposes),
> `notes-external-protocols.md` (A2A / MCP / Reason / c2c.im landscape and ADR compatibility),
> `notes-coordination-semantics.md` (threading, ids, dedupe, concurrency),
> `notes-identity-and-addressing.md` (naming, reachability, credentials).
> Three factual corrections to the earlier wake note are recorded in its own §8, §10, §11, §12 —
> read those before the gap table below.

## Why this milestone exists

Cross-context handoff works today. What it cannot do is tell either side the truth about what
happened. Five independent lines of investigation, from five different starting points, converged on
that single sentence, and none of them was looking for it:

> Do not assume a peer read your message because the send succeeded.

c2c.im states it that way. Reason's DESIGN.md states that MCP notifications are not a delivery path.
agents-mesh describes the same trap in its own words. In pi-xfer, `xfer_to` returns
`status: "sent"` as a **constant** (`index.ts:149`, `index.ts:194`) — a value that would be identical
whether the target was awake, asleep, or gone. The four available acknowledgement granularities all
stop short of "was it seen":

| Surface | What its ack actually means |
|---|---|
| Local socket | handed to `deliver()` (`server.ts:36-39`) |
| Mesh | queue accepted, or `unknown` — three states (`mesh-engine.ts:341-360`) |
| Broker (forward) | re-states the local socket's ack |
| Adapter daemon | JSONL append succeeded; an `--on-handoff` command's exit code never reaches the sender (`adapterd.src/daemon.ts:159-183`) |

That is the gap this milestone is about. Everything else on the list is either a precondition for
answering it honestly, or a distinct hole found on the way.

Two properties of this milestone, both deliberate:

- **It is mostly additive and local.** No new component, no server, no registry, no persistence.
  Nothing on this list touches ADR-0013 (in-process, no separate daemon, discovery = `listActors`),
  ADR-0014 (Board stays machine-local) or ADR-0015 (Inbox is lossy by construction) — except item 3,
  which is explicitly parked at the design node.
- **The evidence for item 1 is much stronger than for items 3–4.** Four independent projects converging
  on one sentence is a different kind of evidence from "two of them have this feature". The list below
  records that difference rather than smoothing it over.

## Ordered list

Ordering below is a working sequence, not a settled priority. Item 0 exists because item 1's verdict
depends on the signal item 0 repairs; items 3 and 4 are independent of it and could be reordered.

### 0 — The presence signal reports things that are not true

**Gap.** `status` and busy/idle are described in the README, in the broker targets payload and in the
metadata files as facts about the session. They are not. Four separate ways to be wrong, one per
surface:

- **pi, premature idle.** `index.ts:209` sets `idle` on `agent_end`. That event is not terminal: the
  runtime's own declaration for `AgentSettledEvent` says it fires "after an agent run has fully
  settled and no automatic retry, compaction, or queued continuation will run"
  (`dist/core/extensions/types.d.ts:800-805`), and two events sit between. The session can be resuming
  work while we announce it is free.
- **pi, queued work invisible.** `state.isRuntimeIdle()` (`state.ts:73-76`) asks only `isIdle()` and
  never `hasPendingMessages()`, which sits on the same interface (`types.d.ts:244`). A turn that is
  queued but not started reads as idle.
- **Adapter daemon, frozen.** `adapterd.src/daemon.ts:88` writes `status: "idle"` once at startup and
  never updates it — including while `--on-handoff` is spawning work.
- **Mesh, absent.** `XferInstanceState` (`mesh-engine.ts:18-23`) has no `status` field at all. The
  signal that exists on the local transport does not cross.

There is a second, quieter instance of the same family: `local-side name collisions are silently
taken over`. Both `controller.start` and `startAdapterd` unlink the socket path before binding
(`controller.ts:98-99`, `adapterd.src/daemon.ts:75-78`). A second pi session launched with the same
name steals the endpoint; the loser keeps listening on an unlinked inode, receives nothing, and
`/xfer list` shows one healthy entry. Mesh rejects a duplicate name (`Running`, ADR-0016); the local
transport does not check at all.

**Evidence.** `notes-pi-runtime-primitives.md`, `notes-transport-matrix.md`, §11–§12 of
`notes-reason-network-wake.md`, `notes-identity-and-addressing.md` §name resolution.

**What this does not decide.** Which signal is authoritative — `runtimeContext.isIdle()` or the
event-driven `currentStatus` — is **not** settled here, and the two currently disagree with each other,
not only with reality. Note also that `doctor.ts:187`'s `node.status === "Idle"` refers to a Rivet
actor lifecycle state, a different concept that happens to share the word; any work in this area has
to deal with that collision. Whether the name-collision case is in scope for this item or is a
separate defect is not decided either.

### 1 — The sender cannot tell whether the handoff was seen

**Gap.** Both tools return a hardcoded `status: "sent"` (`index.ts:149`, `index.ts:194`). The
information needed to say something true is already computed at delivery time and discarded:
`controller.ts:69-71` branches on `isIdle` and chooses `followUp` + `triggerTurn` or `steer`. The
distinction is exactly the one a sender wants — *did it land, or will it land later, or is there
nowhere to land it*.

**Evidence.** Four external projects converge independently (see "Why this milestone exists").
Reason's vocabulary is `stored | delivered | held | refused`; c2c.im splits durability from wake;
both live entirely in the sender's return value. Corroborated from five angles inside this repo —
`notes-transport-matrix.md` (ack granularity per surface), `notes-coordination-semantics.md` (the
`kind: task` contract has no mechanism behind it: no reply wait, no pending record, and none of
`doctor.ts`'s five checks looks at a handoff that was never answered), `notes-identity-and-addressing.md`
(what reachability surfaces report, and what they do not).

**What this does not decide.** The value set. Whether `held` appears in the first cut or later.
Whether the verdict is computed at send time or arrives later as a receipt — the two imply
different storage, and item 3 would interact with the second. The mesh side needs a new actor action
and `XferInstanceState` growth; the local side appears not to need a protocol change at all, but
whether the local side's freshness is sufficient is **not** established: `targets.ts` contains no timer
(`listTargets` is a one-shot directory scan) and `METADATA_POLL_MS` (`constants.ts:16`, 1 s) belongs
to the *writer*. So the local verdict would be a read-time snapshot, not a subscription.

### 2 — MCP as an outbound surface for hosts that speak it

**Gap.** The Adapter Daemon is the answer for hosts that can run our bundle. Hosts that can only run
an MCP client have no path in. `reason network mcp` and `c2c-mcp-server` both take this shape: MCP as
a thin front door onto a transport that lives elsewhere, never as the wire itself.

**Evidence.** `notes-external-protocols.md` §2. pi-xfer already has the required shape — `xfer_to` is
a tool (`index.ts:73-95`).

**What this does not decide.** Scope, packaging, or naming. What must be written down when this is
designed is the limit, not the feature: **MCP is outbound only.** Reason's DESIGN.md records the
empirical finding that MCP notifications are not a delivery path, and the specification is removing
the server-initiated direction outright (sampling deprecated; SEP-2260, status Final, drops standalone
server requests). This item therefore buys "any MCP host can send to us" and buys nothing about
wake or receipt. Whether it is worth doing given the Adapter Daemon already covers most hosts is an
open question, not a settled one.

### 3 — Inbound policy: accept / hold / refuse — **parked at the design node**

**Gap.** There is no middle setting. Every handoff that reaches the socket is injected
(`controller.ts:64-71`): idle opens a new turn, busy steers into the current one. There is nowhere to
put "received, but not now". Combined with the settled weakness that peer identity is an actor type
name plus a key with no handshake and no credential (ADR-0019 records impersonation as an accepted
risk) and that `/xfer desc` is unverified self-declaration, the only choices today are accept
everything or stop listening.

**What the user has already decided.** The value is real and it should not be folded into the other
items — the user separated it explicitly, on the grounds that the decision about *how* it works is a
design question. **Do not carry an implementation assumption into the design node.**

**What the design node has to answer, none of it answered here.** Granularity: Reason sets it per
machine, Claude Code per session, and both positions exist in this repo. Manual or automatic: both
external implementations are manual gates — Reason's `hold` waits for a human, Claude Code's
`crossSessionInbound` is a switch. An automatic rule would have to judge a sender whose identity
cannot be verified, which is a different premise from every other item on this list. Storage: a held
handoff is state that outlives the turn, and this round established that the `os.tmpdir()` handoff
documents already have **no reaper at all** (four write sites — `index.ts:103`, `mesh.ts:308`,
`broker-main.ts:363`, `adapterd.src/main.ts:215`; the only `unlink` is `index.ts:126`, on the failure
path. `gc.ts` reaps `.sock` and `.json` only). Hold adds a layer on top of an unbounded pile, so its
lifetime has to be decided before it is implemented. One further constraint: ADR-0018's
"the sender declares, the receiver never judges" governs `kind` — what the message *is* — and does not
govern whether to accept it; the two do not collide.

### 4 — No guard against agents working each other in a circle

**Gap.** Nothing observes agent-to-agent exchange loops. `kind: task` promises "exactly one
conclusion", but that is convention only — no reply wait, no outstanding-task record, and none of
`doctor.ts`'s checks looks at an unanswered handoff. A→B, B→C, C→A raises nothing anywhere. Because
our delivery **wakes sessions** (`controller.ts:69-70`), such a loop is not merely structural: it
keeps a session turning.

**Evidence.** `notes-coordination-semantics.md`. Two external projects carry a guard: Reason caps
consecutive agent↔agent messages in a thread with no human input; Claude Code has a per-sender rate
limit and a 50-message queue ceiling. Note the evidence grade is weaker here than for item 1 — two
projects having a feature is not four projects agreeing on a finding.

**What this does not decide.** The counter's scope (per peer, per session, per machine), where it
lives, and what it does when it trips — warn, stop, or drop. The design node may reasonably conclude
that this is a `/xfer doctor` check rather than an in-path guard; that is a design choice, not a
prerequisite.


### 5 — Per-host delivery profiles for non-pi code agents — **entry into implementation undecided**

**Gap.** A non-pi code agent has no steer path today. `skills/xfer-agent/SKILL.md` tells the host to
run `xfer-adapterd inbox list` / `inbox take` itself: take-to-read, and only if the agent chooses to.
`--on-handoff <cmd>` can push, but what it pushes is a **process** — and that process still has to
reach the agent by some host-specific means (write to a socket, inject into a terminal pane, drop a
file nobody reads). ADR-0015 names the seam on purpose and defers the alternatives: *"`--on-handoff
<cmd>` is a best-effort second strategy… A `url` strategy (HTTP POST) is deferred pending research and
is deliberately not reserved as a flag"*.

The per-host configuration position already exists and carries no delivery semantics:
`skills/xfer-agent/hosts/cursor.md` and `hosts/generic.md`, plus `.xfer-agent.json` (host kind, agent
name, launch command), vary **install location and launch command only**; `install --host
<cursor|generic>` likewise fixes placement. Nothing in the shipped artifacts says how a handoff reaches
the agent's context.

**Why it was added after the fact.** The round's earlier conclusion — "adapterd is good enough" — was
recorded before this was looked at closely, and it holds only down to the process boundary. Past that
boundary every host that cannot be injected into gets "the agent must remember to look", which is
exactly the pull tier that both external surveys describe as a fallback rather than a guarantee
(c2c.im: *"`poll_inbox` requires the model to choose to call it. A fallback is not a guarantee."*).

**Evidence.** `notes-external-protocols.md` §3 (Reason's `hook <agent>` — one delivery kernel with
the client as parameter) and §5 (Claude Code's `CLAUDE_CODE_MESSAGING_SOCKET`, Codex app-server);
`notes-transport-matrix.md` (adapterd's ack is "JSONL append succeeded"; the spawned command's exit
code never reaches the sender); `skills/xfer-agent/`; ADR-0015.

**The payoff is not uniform, and saying so is the point of writing this down:**

| Host class | What a profile could actually reach | Tier |
|---|---|---|
| Claude Code, Codex | a native injection API | true push |
| Cursor, Gemini CLI, Copilot CLI | host hooks, running inside the host's own lifecycle in its own context format | reliable turn-level — better than today, not push |
| Everything else | nothing | pull, unchanged |

Only the first row is a new capability. The second row turns "a process was spawned and the agent may
or may not notice" into "the host itself received the content at a point it was going to process
anyway".

**Two costs that have to be priced before this becomes implementation work, not before it becomes
scope.** First, this is an external-integration surface that drifts with other people's releases:
Reason's own documentation records that Cursor, Copilot and Devin all read Claude Code's
`~/.claude/settings.json` hooks, so its hook process must detect which agent is actually calling it —
a failure mode that does not crash, it silently addresses the wrong context. Second, none of it is
automatically verifiable: these hosts are outside the test surface, the same reason
`web-picker.user.js` is excluded from `npm test` under AGENTS.md. A profile layer adds a manual
verification matrix that has to be maintained per host.

**What this does not decide.** Whether it enters implementation at all — the user recorded it as
**scope-only on 2026-10-18**, to be settled during discussion, not to be treated as agreed work. Also
undecided: which hosts, whether the seam is a shipped profile or a documented recipe, and how any of
it is verified. Note that extending ADR-0015's deliver-strategy section would be an extension of a
settled ADR rather than a departure from it — that question is for the design node.

## Out of scope

Recorded deliberately so the next round does not relitigate it.

| Item | Why |
|---|---|
| **A2A** | **Decided by the user, 2026-10-18, on architectural preference.** pi-xfer is stateless by design; A2A requires each node to be an HTTP endpoint with a task store and a `Task` lifecycle (`submitted → working → … → terminal`, terminal states immutable). That inverts the choice pi-xfer made on purpose and would reopen ADR-0013/0014. |
| `serve`-style resident headless agent (Reason's framing; per-sender threads, warm resume, resume-after-restart) | A product-shape question, not a capability gap — `--on-handoff` already wakes non-pi hosts. Raises ADR questions nobody has answered (is the worker a Node? where does its state live? who supervises it?) and sits in tension with ADR-0014's "state that outlives a session belongs to the Board". |
| Durable mailbox / read receipts with a store behind them | ADR-0015 chose a deliberately lossy take-to-read Inbox; a persistent archive was considered and rejected there. |
| Server-side wake guarantees | Conflicts with ADR-0013's deliberate acceptance that "daemon alive but pi dead" is ambiguous. |
| Agent Card as a discovery format | Capability declaration already exists as the Node's self-described `/xfer desc` on the actor; an Agent Card is the same claim in a heavier signed form, and discovery is `listActors`. |
| `doing` inference (Reason infers it from host todo files) | Absent on all three surfaces, and pi cannot see the host's plan. Suggested as its own milestone rather than folded in here. |
| MCP as an inbound wake path | Closed by the protocol, not by preference: server-initiated requests are being removed (SEP-2260, Final), and Reason measured that clients do not pass MCP notifications to the model. |
| Thread / reply / causal fields on handoffs | Established as a real gap (`notes-coordination-semantics.md`: `msgId()` is neither monotonic nor sortable, and there is no reserved slot for causation) but it is a protocol-shape change, not a delivery-visibility change. Deliberately left for a later milestone. |

## Notes for the design node

1. **Item 0 gates item 1.** A verdict that restates a signal known to lie is worse than no verdict.
   If the design node reorders, item 1 must not ship without saying what it does when the underlying
   busy/idle value is itself in one of its four wrong states.
2. **Items 3 and 4 are independent of 0–2** and could ship in any order or separately.
3. **The name-collision behaviour recorded under item 0 may be a separate defect.** The user was not
   asked to rule on it; it surfaced during evidence gathering and is recorded, not claimed.
4. **Nothing in this milestone was tested against a live deployment.** All of it is code reading. The
   external half of the evidence rests on documentation and, in several places, on search extraction
   rather than direct fetches — the sources are indexed per note, and the ones that could not be
   verified directly are listed in each note's closing section.
5. **Item 5 is scope-only.** It is on the list because the user identified it, not because it was
   agreed. Whether it becomes implementation work is a discussion outcome, and the item says so where
   it is defined so the design node cannot read it as settled.
