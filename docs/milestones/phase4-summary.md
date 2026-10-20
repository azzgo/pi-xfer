# Milestone 4 Summary — Release Note Input

> Milestone: Phase 4 — make delivery visible.
> Status: complete. Items 0+1 shipped as one change, item 2 shipped, items 3, 4 and
> the item 5 delivery kernel were decided against and recorded with reasons.
> Feature list: `docs/milestones/phase4-features.md`. Decision record:
> `docs/adr/0020-delivery-visibility-two-axes.md`. Design plans:
> `phase4-design-p0-p1.md`, `phase4-design-p2.md`, `phase4-design-p2-p5.md`.

The thesis that drove the milestone, and the one sentence worth keeping in the
release notes:

> Do not assume a peer read your message because the send succeeded.

Before this milestone `xfer_to` and `xfer_mesh_to` both returned a constant
`status: "sent"` — the same value whether the target was awake, asleep, queued,
or gone.

## Shipped

### Handoff outcome (items 0 + 1, `8a334be`)

Both tools now report **where the handoff landed** instead of a constant. There
are four values, shared by both transports, and each transport reaches only the
subset it can honestly support:

| Outcome | Meaning | Local | Mesh |
|---|---|---|---|
| `queued` | accepted, will be picked up later | — (no queue on this transport) | ✓ |
| `delivered` | handed to the target's runtime now | ✓ | — (the sender cannot learn this) |
| `unknown` | the answer was ambiguous — it may have arrived | ✓ connection died before the ack | ✓ enqueue answer ambiguous |
| `not-delivered` | definitely did not land | ✓ no such endpoint | ✓ engine refused |

`unknown` is a real answer. It is never presented as a reason to resend, and the
tool text says so explicitly: a second send is what turns an ambiguity into a
real duplicate.

**The ceiling, stated plainly.** `pi.sendMessage` returns `void`, and ADR-0015
chose a deliberately lossy take-to-read Inbox with a persistent archive already
rejected. So "was it read" is **unreachable, not merely unbuilt**. The promise is
"you will learn where it landed", never "you will learn it was read". The wire
change is one additive field on the existing ack frame — no new frame type, no
new endpoint, no protocol version. A receiver that sends no outcome field yields
`unknown`, so older receivers degrade toward honesty rather than toward a false
positive.

**Two prerequisites shipped with it**, because `delivered` would otherwise be
false:

- `isRuntimeIdle()` now also asks `hasPendingMessages()`. A queued-but-not-started
  turn used to read as idle, so a handoff parked behind it was reported
  `delivered` when it had only been queued behind other work.
- The unlink-before-bind at bind time is replaced by `claimEndpoint()`
  (`endpoint-claim.ts`), which clears a crash leftover and refuses a live peer.
  Previously two same-named sessions both "bound" successfully: the first was
  stranded on an unlinked inode nobody could connect to again, both wrote the same
  `<name>.json`, and a sender asking for that name reached whichever bound last.
  This was the only hole in local's otherwise degenerate Node axis — the connect
  succeeded and `delivered` came back true, about a process that was not the one
  named.
  - **User-visible behaviour change:** launching a second same-named session, or
    running `/xfer name foo` against a live `foo`, now fails with a message that
    names the live peer, instead of silently taking over. This is the intended
    fix and it is the one regression a user can hit.
  - `rename` now claims the new name before releasing the old one, so a failed
    rename leaves the session intact.

### MCP gateway (item 2, `5687695` + `e406d4a`)

`mcp-gateway.mjs` — a stdio MCP server exposing `xfer_send`, `xfer_mesh_send`
and `xfer_list`. It binds no socket, keeps no inbox, joins no mesh, runs no agent
loop: each tool builds an argv and forks the existing `xfer-adapterd` CLI.

- `--name` is required and never derived. A send-only gateway binds nothing, so a
  name collision cannot be caught by `claimEndpoint`; it has to be refused at
  startup.
- `--no-preflight` is deliberately **not** exposed as a tool parameter: it is a
  human escape hatch for engine debugging, not something a model should reach for.
- It added **no build product**. It imports nothing from this repository, so it is
  a committed single file with no bundling step; `AGENTS.md`'s build-product list
  is unchanged by it.
- It required a new `xfer-adapterd list [--dir D] [--json]` subcommand. There was
  previously **no way to list peers from the CLI** — `/xfer list` is a pi command
  — so without it the gateway could send but not find a target, which is half the
  problem. The skill was updated to point at it as well.
- `xfer-adapterd send` also accepts `-` for the document, so a caller building a
  handoff in memory needs no temp file on the CLI side.

Sized honestly: this is a **convenience feature, not a capability gap**. It buys
a typed tool instead of three shell incantations, and one gateway per host session
instead of one skill file per agent. Two costs are documented in
`docs/guides/mcp-gateway.md`: a send-only host is **invisible in `/xfer list`**
(nothing binds a socket for it), and it **cannot receive**.

## Decided against, with reasons

Recording these is part of the milestone: each was a considered "no", not a
backlog item.

- **Item 3, inbound `held` / `refuse` — never.** The mesh cannot express it. The
  actor's `run` calls `onHandoff` (synchronous, returns `void`) and then writes
  `recordMeshDelivery` unconditionally on the next line, so a held message is
  recorded as delivered, redeliveries are dropped as duplicates, and a receiver
  restart loses it. Supporting it would change the durable-queue contract
  ADR-0013 defines. The local-only variant was considered and judged not worth the
  state it introduces — for the one thing it buys, closing the session is already
  an off switch. Accept-everything or stop-listening is the permanent shape.
  Recorded in ADR-0020 because Reason's vocabulary is
  `stored | delivered | held | refused`, and a future reader will ask why one
  value is missing here.
- **Item 4, loop guard — do not build.** A human is usually behind each send, and
  a guard without causation can only guess: it cannot tell an accidental loop from
  a relay someone built on purpose, so it would break the second. It is also
  blocked behind a causation field, which `phase4-features.md` already put out of
  scope. One honest caveat is recorded: ADR-0018 tells a *blocked* receiver to
  declare its reverse handoff as a `task`, so two mutually blocked agents can
  ping-pong with nobody present. That is degenerate and human-resolvable. The
  cheaper lever taken instead: both tool descriptions now state **when a send is
  permitted**, not only what a send contains.
- **Item 5, per-host delivery profiles — no delivery kernel.** The kernel (per-host
  logic for getting a handoff into an agent's context) drifts with other projects'
  releases — Cursor, Copilot and Devin all read Claude Code's `settings.json`
  hooks, so a hook process has to detect which agent is calling it — falls outside
  the hermetic test surface, and its worst failure mode does not crash: it silently
  addresses the wrong context. It bought new capability on two hosts. Presets
  remain and carry configuration only, never delivery logic; `CONTRIBUTING.md`
  now records the fork-or-PR route that was previously folklore.
- **The public MCP relay is deferred** — it is client-role on the mesh (already
  built) but needs authentication, and an unauthenticated endpoint that can
  enqueue into someone's mesh is a different exposure than the unix socket
  ADR-0019 reasoned about. Auth is something someone maintains; it does not belong
  to a convenience feature.

## Premises that turned out to be wrong

The most expensive part of the milestone to discover, so they are recorded rather
than quietly corrected:

- The feature list asserted item 0 gated item 1 unconditionally. It does not.
  Three of item 0's four defects sit on the Node axis, which is degenerate on
  local; only `hasPendingMessages()` is load-bearing. Item 0 collapsed into two
  prerequisites for item 1 and shipped with it as one change.
- Item 2 was framed as serving "hosts that can only run an MCP client". That set
  is empty — MCP is an interface a host has, not a category of host, and every
  coding agent that speaks MCP can also run a shell. The framing that turned out
  to be worth doing was one local gateway per host session.
- An earlier draft of the item 2 plan claimed a shared gateway collapses
  `/xfer list` to one row. Wrong for stdio: the host spawns the server and owns its
  stdin/stdout, so there is one process per host session, each with its own name.
  `/xfer list` does not collapse; a send-only gateway is not listed at all.
- `AGENTS.md` said "four committed build products" and omitted
  `xfer-adapterd.cjs`, which already shipped with a `.sha256` and was already
  enforced by `artifact-freshness.test.ts`. Corrected this milestone.
- `syncXferToolAvailability` was found to be a no-op — it promises to hide
  `xfer_to` when no peer exists and does nothing, unnoticed because the repo has no
  `tsconfig.json`, so the unused locals are never type-checked. Not fixed (see
  follow-ups).

## Fixes found during review

Both were caught reviewing the gateway after it worked, not while authoring it —
which is the point worth keeping.

- **A fifth outcome value.** The gateway's first cut invented `not-sent` and
  applied it to the ack-timeout case — precisely the ambiguous case where a resend
  creates a real duplicate. Fixed by making the CLI **name** its outcome as the
  trailing word of its failure line and having the gateway map only named values; a
  missing name degrades to `unknown`. There is now a repo-wide test asserting
  `not-sent` appears nowhere.
- **A warning through the failure channel.** `xfer-adapterd mesh send` printed no
  outcome, and routed a preflight *warning* through `fail()`, so a `Mismatch`
  (which means **queued**) exited 1. A gateway trusting the exit code turned a
  successful enqueue into a failure. Fixed with `warn()` that leaves the exit code
  alone, and `runMeshSend` now reports `queued`.
- **The temp handoff document is no longer deleted on `unknown`.** The handoff may
  already have arrived and the target's delivery message points at that path. Only
  `not-delivered` removes it.

## Verification

- `npm test`: **567 tests, 566 pass, 1 skipped, 0 fail.**
- New tests cover the ack merge (`client.test.ts`: `delivered` only when the
  receiver says so, `unknown` for an absent or unrecognised field, rejection when
  the connection dies first), the endpoint claim (`endpoint-claim.test.ts`: a live
  peer is refused and its files survive, a crash leftover is cleared), inbound
  routing through `isRuntimeIdle()`, the tool descriptions, and a real stdio
  JSON-RPC handshake against `mcp-gateway.mjs` including stdout purity on the error
  path and the exact argv per tool via a stub CLI.
- Local manual smoke against a live `xfer-adapterd` confirmed:
  - `delivered` is real — the record was in the daemon's `inbox.jsonl`, not just in
    the return value;
  - an 8-second-late ack resolves to the `unknown` branch ("do not resend"), not
    `not-delivered`;
  - a second daemon on a live name is refused without disturbing the first;
  - a crash leftover is cleared and the name reused.
- **Nothing in this milestone was tested against a live deployment or engine.** No
  engine was contacted; the deployment named in the real
  `~/.pi/xfer/mesh.config.json` was never read from or written to.

## Vocabulary added

Two terms in `CONTEXT.md`, and a reader needs both to follow the code:

- **Delivery verdict** — sharpened to be **Node**-scoped: what a *listing* says
  about one Node's ability to receive at all. It was already this, and the
  milestone fixed the wording so it cannot be read as a claim about one handoff.
  `mesh-status.ts` implements it as seven glyphs.
- **Handoff outcome** — new, **Handoff**-scoped: where one handoff came to rest, as
  far as the network can honestly tell. Deliberately avoids `receipt` and
  `acknowledgement`.

One axis, one word was the collision ADR-0020 exists to resolve.

## Docs

- `CONTRIBUTING.md` — new. What a contributor needs (hermetic tests, the committed
  build products, no runtime deps), what a host preset may contain, and the five
  settled decisions that are not taking patches, each pointing at the ADR or
  decision that settled it.
- `docs/guides/mcp-gateway.md` — installation for an MCP host, the flag table, the
  tool-to-CLI mapping, the outcome table, and the two costs (invisible in
  `/xfer list`, cannot receive).
- `README.md` — capabilities table gains **Handoff outcome** and **MCP gateway**
  rows and links the gateway guide.
- `AGENTS.md` — the build-product list corrected to name `xfer-adapterd.cjs`, and
  `mcp-gateway.mjs` recorded as deliberately not one of them.
- `skills/xfer-agent/SKILL.md` — points at `xfer-adapterd list` and mentions the
  gateway as an alternative to the CLI.

## Follow-ups / open

1. **The gateway's loopback end-to-end mesh test is written but skipped.** It is
   opt-in via `XFER_ENGINE_BINARY`. Environmental: a root-owned `rivet-engine`
   holds the default ports on this machine and the real deployment is remote. This
   is the one gap against the plan in `phase4-design-p2.md`, which should say so.
2. **The CLI's error text is now load-bearing.** The gateway reads the trailing
   word of the failure line to recover the outcome. Deliberate and test-pinned, but
   it belongs in ADR-0020's consequences so that anyone rewriting the CLI's error
   wording knows they are touching a wire.
3. **Four defects found while designing and deliberately not fixed** (closing
   section of `phase4-design-p2-p5.md`):
   - `syncXferToolAvailability` is a no-op (`index.ts`);
   - handoff documents in `os.tmpdir()` are never reaped on the success path —
     every successful handoff leaks a file;
   - `handoff-kind.ts` repeats a paragraph in its header comment;
   - `msgId()` is neither monotonic nor sortable — load-bearing only if handoffs
     ever carry causation.
   These want a tracker, not a milestone doc.
4. **`broker.test.ts` has a pre-existing flake.** "removes broker.pid and broker.json
   on SIGTERM" failed once under full-suite parallel load and passed on 3× isolated
   and 3× full-suite reruns, both before and after this milestone's changes. Not
   caused by this work, but a test that can go red on its own is debt.

## What a user will notice

For a release-note author, the five visible changes, in order of impact:

1. `xfer_to` / `xfer_mesh_to` return `outcome` (`queued | delivered | unknown |
   not-delivered`) instead of `status: "sent"`.
2. A second session on a live name — a duplicate pi with the same `--name`, or
   `/xfer name <live>` — is refused with a message naming the live peer, instead of
   silently taking over the endpoint.
3. `xfer-adapterd list [--dir D] [--json]` — peer discovery from the CLI, which
   previously had none.
4. `mcp-gateway.mjs` — `xfer_send`, `xfer_mesh_send`, `xfer_list` for any MCP host,
   send-only, and not listed in `/xfer list`.
5. What did not change: no inbound `held` state, no loop guard, no per-host delivery
   kernel, no public relay — each a decision with a recorded reason, not an
   omission.
