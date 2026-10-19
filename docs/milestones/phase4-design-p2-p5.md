# Milestone 4 design — items 2–5 (scope decisions)

> Design node, 2026-10-19. Items 0+1 are in `phase4-design-p0-p1.md` (ADR-0020). This file
> records the go/no-go calls on the remaining four items. Three are closed; item 4 is not,
> and the reason is a dependency rather than a judgement.

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

**Known cost, stated up front.** All agents behind one gateway share one Node name.
`/xfer list` collapses from N rows to one, and a receiver sees `from: <gateway>`, not the
agent. The mitigation is the mechanism already in the codebase: stamp the calling agent into
the document with `stampDocument()`, exactly as `sender-cwd-stamp.ts` stamps the sender's
cwd today. That keeps the Agent visible inside the Handoff even though the Node name is
shared.

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

## Item 4 — loop guard: **unresolved, and blocked behind a deferred decision**

Nothing here is a judgement about whether the guard is worth building. The dependency chain
is what blocks it:

```
guard against agents working each other in a circle
└─ needs: an answer to "was this task ever concluded?"
   └─ needs: correlating a reverse Handoff with the Task that asked for it
      └─ needs: a causation field on the Handoff
           └─ msgId() is neither monotonic nor sortable, and no slot is reserved
              → phase4-features.md puts thread/reply/causal fields OUT OF SCOPE
```

And the transport-time `outcome` cannot substitute, by decision: outcome is silent on
replies (ADR-0020). So item 4 has no home for its ledger today either:

- `os.tmpdir()` handoff docs carry a `kind` stamp and a cwd stamp and nothing else, and have
  no reaper
- the Board's `pending` (`board.ts:112`) is the `/xfer board` compose slot — one in-memory
  `PendingWrite`, unrelated to task tracking despite the name
- `XferInstanceState` on the engine could hold an *outbound* ledger (it survives reconnect
  and is readable by name), which is the one structurally plausible home — but it is useless
  without the causation field above

So the next move on item 4 is not a counter. It is a decision about whether handoffs carry
causation, which `phase4-features.md` already deferred to a later milestone. Until that
lands, item 4 should stay undesigned rather than be designed against a hole.
