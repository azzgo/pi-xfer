# Milestone 4 design — items 2–5 (scope decisions)

> Design node, 2026-10-19. Items 0+1 are in `phase4-design-p0-p1.md` (ADR-0020). This file
> records the go/no-go calls on the remaining four items. All four are closed. Item 2's
> implementation plan is `phase4-design-p2.md`, which corrects the cost estimate in its
> section below.

## Item 2 — MCP as an outbound surface: **do, local stdio gateway only**

The feature list scoped this as "hosts that can only run an MCP client". That framing was
wrong on inspection: MCP is an *interface* a host has, not a category of host, and every
coding agent that speaks MCP can also run a shell — so `xfer-adapterd send` already reaches
all of them, and it needs no daemon at all (`skills/xfer-agent/SKILL.md`: "send needs no
daemon, so a send-only host may skip the background process").

What the grilling did find is a second framing the list never considered, and it is the one
worth doing: **one local gateway process, many local agents.** Today N agents means N skill
files and N daemons. A single stdio MCP server whose tools shell out to the existing
`xfer-adapterd send` / `mesh send` removes both — no skill file, no launch command, and a
model that gets a typed tool instead of three shell incantations.

Sizing it honestly: this is a **convenience feature, not a capability gap.** It should not
share a milestone with items 0+1, which are "the things we say are lies".

**Known cost — and a correction.** The first cut of this section said every agent behind one
gateway shares one Node name, that `/xfer list` collapses to one row, and that a receiver
sees the gateway rather than the agent. That is wrong for stdio: the host spawns the server
and owns its stdin/stdout, so there is one gateway process *per host session*, each with its
own name. `/xfer list` does not collapse — a send-only gateway binds nothing, so it is not
listed at all. What remains is two gateways configured with the same name, which is a config
error. The cost that survives is real but different: **a send-only host is invisible in
`/xfer list`**, because nothing binds a socket for it.

The mitigation below therefore becomes an escape hatch for the shared-name case rather than
a required part of the feature. It is kept because the failure it prevents is invisible.

**Out of scope by decision: the public relay.** A relay for cloud or phone agents is
client-role on the mesh (`sendMeshHandoff` — no join, no actor, already built for send-only
hosts) but it must be reachable from the internet, and an unauthenticated endpoint that can
enqueue into someone's mesh is a different exposure than the unix socket ADR-0019 reasoned
about. Authentication is something a maintainer carries. Deferred to its own milestone.

## Item 3 — inbound hold / refuse: **never**

Decided 2026-10-19. Recorded in ADR-0020 because Reason's vocabulary is
`stored | delivered | held | refused` and a future reader will ask why one value is missing.

Two independent reasons, either sufficient:

1. **The mesh cannot do it, structurally.** The actor's `run` calls `onHandoff`
   (synchronous, returns `void`) and then writes `recordMeshDelivery` unconditionally on the
   next line. The message has already left the durable queue and there is no nack channel,
   so a held message is recorded as delivered, any redelivery is dropped as a duplicate by
   `isDuplicateMeshHandoff`, and a receiver restart loses it. Making it work means changing
   the durable-queue contract ADR-0013 defines.
2. **The local-only variant was considered and judged not worth its state.** It would need
   a tmpdir reaper first (there is none — four write sites, one `unlink` on the failure
   path), a store, a `/xfer held` command to list and release, and a setting. For the one
   thing it buys over today — stay reachable but do not inject — closing the session is
   already an off switch, and it needs no new state.

Accept-everything or stop-listening is the permanent shape.

## Item 5 — per-host delivery profiles: **do not build the kernel**

The item bundled two things at very different costs:

| | What it is | New capability |
|---|---|---|
| Delivery kernel (Reason's `hook <agent>`) | per-host logic for getting a handoff into an agent's context | **2 hosts** (Claude Code, Codex) |
| Per-host config placement | `hosts/<name>.md`, `.xfer-agent.json`, `install --host` — already exists, varies install location and launch command only | none |

The kernel is rejected: it drifts with other people's releases (Reason's own documentation
records Cursor, Copilot and Devin all reading Claude Code's `~/.claude/settings.json` hooks,
so a hook process must detect which agent is actually calling it), it falls outside the
hermetic test surface that AGENTS.md requires, and its worst failure mode does not crash —
it silently addresses the wrong context.

The placement half is nearly free and stays. It is **not** item 5 being done: row two of the
payoff table (Cursor, Gemini CLI, Copilot CLI) still gets turn-level reliability from host
hooks, not push. The line that keeps the drift risk out is written into
`skills/xfer-agent/install.md`: **a preset carries install location and launch command, never
delivery logic.**

Not building it is not the same as closing the door — `generic.md` already covers anything
with a shell. A host that needs more can fork or send a PR, and that route is now documented
rather than folklore.

## Item 4 — loop guard: **do not build**

Decided 2026-10-19. Two reasons, and the second is the one that will still hold when
someone arrives with Reason's consecutive-message cap.

**1. The probability is low, because a human is usually behind each send.** The tool
description and the skill both push against the shapes that would generate traffic on
their own — "never send a handoff that only acknowledges or confirms" — and an agent
generally sends because someone asked it to. One caveat recorded honestly: the prompt-side
gate that was meant to hide `xfer_to` when no peer exists is **not implemented**
(`index.ts:66` computes `hasPeers` and reads `getActiveTools()` into a variable, then does
nothing), so the tool is always in the prompt. The description's content still discourages
acknowledgement-shaped sends; it is the absence that is not enforced.

**2. A guard without causation can only guess, and guessing wrong breaks something real.**
The loop the guard would catch is not distinguishable from one a human built on purpose. A
heuristic that stops it would stop that too.

The one case the human-in-the-loop defence does not cover is worth recording, because the
protocol produces it on purpose: ADR-0018 instructs a receiver that is *blocked* to declare
its reverse Handoff as a `task`, so two mutually blocked agents can ping-pong with nobody
present. That is a degenerate case a human resolves on sight — and paying for it would mean
first reopening `phase4-features.md`'s out-of-scope on causal fields, then accepting a
heuristic that also catches deliberate relays.

What a guard would need, and why it is not cheap:

```
guard against agents working each other in a circle
└─ needs: an answer to "was this task ever concluded?"
   └─ needs: correlating a reverse Handoff with the Task that asked for it
      └─ needs: a causation field on the Handoff
           └─ msgId() is neither monotonic nor sortable, and no slot is reserved
              → phase4-features.md puts thread/reply/causal fields OUT OF SCOPE
```

The transport-time `outcome` cannot substitute, by decision: outcome is silent on replies
(ADR-0020). And the ledger has no home today — the tmpdir handoff docs carry only a `kind`
stamp and a cwd stamp and have no reaper; the Board's `pending` (`board.ts:112`) is the
`/xfer board` compose slot, one in-memory `PendingWrite`, unrelated despite the name; and
`XferInstanceState` could structurally hold an outbound ledger but is useless without the
causation field.

A coarser guard — "N consecutive agent↔agent messages with no human input", which is what
Reason caps and Claude Code rate-limits — was considered and declined as well. It is a
heuristic, not the guard, and shipping it would make item 4 look resolved while catching
only the most clumsy loops.

## Found while designing, not fixed

Four defects surfaced during this round that belong to no item. They are recorded here
because this is the only file in scope; they want a tracker, not a milestone doc, so whoever
picks one up should move it out.

**`syncXferToolAvailability` is a no-op** (`index.ts:66`). It computes `hasPeers`, reads
`getActiveTools()` into a variable and never writes it back, so the promised gate — hide
`xfer_to` when no peer exists — does nothing and the tool is always in the prompt. The hook
point and the predicate are both already there; only the write is missing. Unnoticed because
the repo has no `tsconfig.json` and `npm test` runs through a resolve hook, so the two unused
locals are never checked.

**Handoff documents in `os.tmpdir()` are never reaped.** Four write sites (`index.ts:107`,
`mesh.ts:308`, `broker-main.ts:363`, `adapterd.src/main.ts:215`) and one `unlink`, at
`index.ts:126`, on the failure path. On success nothing deletes the file — `deliverInbound`
only names the path, and `gc.ts` reaps `.sock` and `.json` only. Every successful handoff
leaves a file in the system temp directory for the life of the machine.

**`handoff-kind.ts` repeats a paragraph** in its header comment: the two sentences about the
tool stamping the `kind:` line appear twice in a row.

**`msgId()` is neither monotonic nor sortable** (`utils.ts`). It embeds a base-36 timestamp
but appends randomness after it, so string order does not match time order. Cheap to fix,
but load-bearing only once handoffs carry causation — the same blocker as item 4.
