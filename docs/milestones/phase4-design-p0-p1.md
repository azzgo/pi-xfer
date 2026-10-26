# Milestone 4 design — items 0 + 1 (presence signal, Handoff outcome)
[简体中文](phase4-design-p0-p1.zh.md)

> Design node, 2026-10-19. Items 0 and 1 collapsed into one change during the design
> discussion; this is the written plan for that change. Decision record: ADR-0020.
> Items 2–5 of `phase4-features.md` are untouched by it — see "What this leaves" below.

## What the two items became

`phase4-features.md` ordered item 0 before item 1 and made 0 a precondition ("a verdict
restating a signal known to lie is worse than no verdict"). That ordering was assumed, not
derived. Once the two axes are separated, item 0's four defects land on different axes and
only one of them survives as load-bearing:

| Defect (from the feature list) | Axis after ADR-0020 | Still needed? |
|---|---|---|
| `index.ts:209` — `agent_end` sets `idle` before the run settles | Node (published metadata) | **No.** Local's Node axis is degenerate; mesh's preflight reads the actor record, not `status`. |
| `adapterd.src/daemon.ts:88` — `status: "idle"` written once at startup | Node (published metadata) | **No.** Same reason. |
| `XferInstanceState` has no `status` field | Node (mesh) | **No.** Mesh's preflight derives reachability from the actor record joined with `/envoys`. |
| `state.ts:75` — `isRuntimeIdle()` never asks `hasPendingMessages()` | Handoff (the steer/followUp branch at `controller.ts:32,69-70`) | **Yes.** Without it, a Handoff parked behind a queued turn reports `delivered` falsely. |

Plus the second, quieter defect the list filed under item 0 without ruling on — local name
collision — which turns out to be the **only** hole in local's otherwise degenerate Node
axis, and is therefore in scope after all.

So item 0 = two prerequisites. Item 1 = the change. Both are one commit.

## Q1 — two axes, not one word

`CONTEXT.md` already fixed *Delivery verdict* as a listing's claim about one **Node**
(`mesh-status.ts` renders it as seven glyphs). Item 1 wants a claim about one **Handoff**.
The two are orthogonal, and the surfaces are rich on opposite ones:

```
                     Node axis                    Handoff axis
                (can it receive at all)      (where did this one land)
              ┌────────────────────────┐    ┌────────────────────────┐
  mesh        │ 7 glyphs + fail-closed │    │ not-delivered          │
              │ preflight + delivered[]│    │ unknown | failed       │
              │  → rich                │    │ + delivered[] window   │
              ├────────────────────────┤    ├────────────────────────┤
  local       │ endpoint exists ⇔ can  │    │ one constant           │
              │ receive → degenerate   │    │   status: "sent"       │
              └────────────────────────┘    └────────────────────────┘
```

Two terms, both now in `CONTEXT.md`. *Handoff outcome* deliberately avoids `receipt` and
`acknowledgement` — already on the **Handoff** entry's avoid list, and already occupied on
the wire by the ack frame and `delivered[]`.

## Q2 — the value set, and its ceiling

Two facts cap what any transport can honestly say, and neither is a choice:

- `pi.sendMessage(...): void` (`types.d.ts:1258`) — the receiver has no return value, no
  id, no error. It knows only that it did not throw.
- ADR-0015 chose a lossy take-to-read Inbox; a persistent archive was considered and
  rejected there, and `phase4-features.md` keeps "durable read receipts" out of scope.

So outcome is a transport-time claim, never a post-hoc receipt, and never "was it read".

| Value | mesh (sender-side, already exists) | local (sender merges two facts) |
|---|---|---|
| `queued` | ✓ enqueue accepted, a runner will pick it up | ✗ no queue on this transport |
| `delivered` | ✗ the sender cannot learn this | ✓ ack returned with the branch fact |
| `unknown` | ✓ enqueue answer ambiguous | ✓ connection died before the ack |
| `not-delivered` | ✓ `actor_ready_timeout` | ✓ `client.ts:16` no such endpoint |

Same four values on both, each reaching a subset. The asymmetry is ADR-0015's, stated in
words rather than smoothed over.

**Boundary, per the user's explicit constraint:** this is a code-level ack and does not
touch the `kind` design. No pending record, no reply wait, no timeout, no reply channel —
a `notification` may be `delivered` and never answered, a `task` may be `delivered` and
never concluded. That gap is item 4, not this change.

## Q3 — no local preflight

`preflightMeshSend` exists because mesh's Node axis is rich: "online but its pool has no
runner" is real and common there, and a missed check costs a 30 s enqueue that reads as
"maybe delivered". Local has neither property. Its Node axis has two states, `client.ts:16`
already checks the only one that can fail, and a false pass costs a failed connect plus an
`unlink` (`index.ts:126`) — nothing survives it. So local gains no preflight; mesh is
untouched.

## Q4 — bind-time live/zombie discrimination

`controller.ts` and `adapterd.src/daemon.ts` unlink the endpoint before binding. That makes
`EADDRINUSE` unreachable, which makes the existing error path (`server.ts:57-59` →
`controller.ts:136-143`) unreachable. Consequence: two same-named pi sessions both bind
successfully; the first is stranded on an unlinked inode and can never be connected to
again; **both write the same `<name>.json`**, so `/xfer list` shows one peer whose `pid`
alternates. `hasLivePeer()` (`index.ts:50-57`) succeeds for both pids, so `xfer_to` stays
resident and the model is told to take names from `/xfer list`.

There are eight `unlinkSync` sites across the two files, and one sentence separates them:
**an unlink that releases *our own* name is correct; an unlink that clears *someone else's*
claim is the bug.**

| Site | Verdict |
|---|---|
| `controller.ts:98-99` — `start`, the endpoint + metadata it is about to claim | **must go** → discriminate |
| `controller.ts:141-142` — `rename`, the **new** endpoint + metadata it is about to claim | **must go** → the worst site: `/xfer name foo` on a live session silently steals `foo` |
| `adapterd.src/daemon.ts:76` — `start`, the stale socket | **must go** → discriminate |
| `controller.ts:135-136` — `rename`, releasing the old name it held | keep |
| `controller.ts:163-164` — `shutdown` | keep |
| `adapterd.src/daemon.ts:186-187`, `:198-199` — shutdown | keep |

Fix: replace the three claims with a discriminate.

This is precisely the one hole in local's degenerate Node axis: `client.ts:16` passes, the
connect succeeds, `delivered` comes back true — about a Node that was not the one named.

```text
endpoint exists
  ├─ live (metadata pid alive, or socketHasListener) → bind fails, say so
  └─ crashed                                        → remove, then bind
```

Both predicates already exist and are tested in `gc.ts` (`processAlive`, `socketHasListener`),
with the conservative semantics that matter: `EPERM` counts as alive, a connect timeout
counts as listening. This moves gc's rule from a manual `/xfer gc` to bind time. The
unlink currently serves two masters — clearing zombies *and* letting a duplicate name take
over — and the two must be split.

Behaviour change, stated plainly: launching a second same-named pi in one directory goes
from silent takeover to a startup failure with a message. That is a real trade-off
("silent takeover vs. refuse to start"), which is why ADR-0020 records it — but the
implementation is small and easily reverted, so no separate ADR was written for it.

## The change

```diff
  // state.ts — prerequisite 1
  isRuntimeIdle(): boolean {
    if (!this.runtimeContext) return true;
-   try { return this.runtimeContext.isIdle(); } catch { return true; }
+   try {
+     const ctx = this.runtimeContext;
+     return ctx.isIdle() && !ctx.hasPendingMessages();
+   } catch { return true; }
  }

  // controller.ts + adapterd.src/daemon.ts — prerequisite 2
- try { fs.unlinkSync(endpoint); } catch { /* ok */ }
+ // endpoint present → live: fail the bind and name the conflict;
+ //                   crashed: remove and bind.
+ // Reuse gc.ts processAlive() / socketHasListener().

  // server.ts — the receiver's half
- socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id }) + "\n");
+ socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id, outcome: "delivered" }) + "\n");

  // client.ts + broker-main.ts — the sender's merge
- const ack = response as { type?: unknown; msg_id?: unknown };
- if (ack.type === "ack" && ack.msg_id === msg.msg_id) { finish(); return; }
+ const ack = response as { type?: unknown; msg_id?: unknown; outcome?: unknown };
+ if (ack.type === "ack" && ack.msg_id === msg.msg_id) {
+   finish(undefined, ack.outcome === "delivered" ? "delivered" : "unknown");
+   return;
+   // no field (older receiver) → unknown, never delivered
+ }

  // index.ts — the constant goes away
- status: "sent"
+ outcome: <queued | delivered | unknown | not-delivered>
```

Additive on an existing frame: no new frame type, no new endpoint, no protocol version.
Both readers already ignore unknown fields.

## Touched areas

| File | Change |
|---|---|
| `state.ts` | `isRuntimeIdle()` asks `hasPendingMessages()` |
| `controller.ts` | three claim sites become discriminates: `:98-99` (`start`), `:141-142` (`rename`'s new name) |
| `adapterd.src/daemon.ts` | same at `:76` — peers must behave alike |
| `server.ts` | ack frame carries `outcome` |
| `client.ts` | read `outcome`, return it from `sendNotify` |
| `broker-main.ts` | same merge on the forward path (`:318-319`) |
| `types.ts` | `XferNotifyOutcome` union; `PeerInfo`/`TargetInfo` if surfaced in listings |
| `client.ts` | `sendNotify` returns `Promise<XferNotifyOutcome>` instead of `Promise<void>` — three callers: `index.ts:118`, `adapterd.src/main.ts:189` (the CLI `send`), and `adapterd.test.ts` |
| `index.ts` | both tools report `outcome` instead of `status: "sent"` |
| `gc.ts` | no change — `processAlive` (`:43`) and `socketHasListener` (`:60`) are already exported with the semantics needed |
| `server.test.ts` | `:86` pins the ack shape with `deepEqual` — the one place the wire format is asserted |

No build product changes (`web-picker.user.js`, `mesh-runtime.cjs`, `broker.cjs`,
`admin.cjs` are untouched). No new dependency. No ADR-0013/0014/0015 departure.

## Risks

1. **`delivered` is a lie if prerequisite 1 ships alone.** The two must land together —
   a Handoff queued behind a pending turn would otherwise report success.
2. **Behaviour change on duplicate names.** Anyone relying on silent takeover — a second
   same-named pi, or `/xfer name foo` pointed at a live `foo` — now gets a startup error
   instead. This is the intended fix; it is called out here because it is the only
   user-visible regression in the change.
3. **The ack field is a wire-format change with older peers.** Handled fail-safe (absent
   field → `unknown`), but a mixed-version fleet will report `unknown` for local sends,
   which is correct and will look like a regression in dashboards.
4. **Nothing here is testable against a live deployment** (AGENTS.md). Tests use
   `fakeDeps` / loopback engines; the duplicate-name path in particular needs a test that
   binds two servers on one path, which is hermetic.
5. **The `unknown` rule is easy to erode.** Any future text that suggests a retry on
   `unknown` reintroduces the duplicate hazard the value exists to prevent.

## What this leaves

- **Item 2 (MCP outbound)** — unaffected. When it lands it picks from the same four values.
- **Item 3 (inbound hold/refuse)** — parked at the design node by instruction. ADR-0020
  records the one thing it must decide: `held` ≠ `queued`, so it needs a fifth value.
- **Item 4 (loop guard)** — **cannot be built on outcome.** Outcome is transport-time and
  silent on replies; the guard asks whether a `task` was ever concluded, which is the
  semantic layer. It needs its own basis, and the standing open questions from the
  research round (Board's single `pending` slot, steer concurrency ordering inside pi) are
  where that basis will have to come from.
- **Item 5 (per-host profiles)** — untouched, still scope-only.

## Verification

Implemented in `8a334be`. `npm test` 539 pass, 0 fail (was 521 before this change).

New tests: `client.test.ts` covers the ack merge — `delivered` only when the receiver
says so, `unknown` for an absent or unrecognised field, a rejection when the connection
dies first. `endpoint-claim.test.ts` covers the rule that would have caught the takeover:
a live peer is refused and its files survive, a crash leftover is cleared. Three routing
cases pin `isRuntimeIdle()` (idle + nothing queued → `followUp`; idle + queued → `steer`;
busy → `steer`), and `server.test.ts`'s ack shape now asserts the new field.

Manual smoke, 2026-10-19, local only (`--no-mesh`, no engine, `mesh.config.json` never
read):

| What | Result |
|---|---|
| `xfer_to` → a live `xfer-adapterd` on the same machine | `✅ delivered`, and the record is in the daemon's `inbox.jsonl` — the claim is real, not just a return value |
| receiver acks 8 s late, client times out at 5 s | rejected `ack timeout` → the `unknown` branch ("do not resend"), not `not-delivered` |
| second `xfer-adapterd up --name` on a live name | refused with the live peer's name, exit 1, the first daemon unaffected |
| dead pid + unaccepted socket (crash leftover) | `nameIsLive` false → both files cleared → name reusable |

The prompt-side wording checked itself: asked what it sent, the session answered with the
tool's `delivered` **and** volunteered "delivered 只表示已交到目标会话，不代表它已读取",
which is the clause the design put in the result text.

Admin and `commands.ts` flows are untouched by this change, so the `verify` skill's browser
channel did not apply.
