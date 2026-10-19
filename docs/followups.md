# Follow-ups — known, deliberately not fixed

Defects and unimplemented promises found while designing, each with enough evidence to act
on later without re-deriving it. Nothing here blocks anything; they are recorded so they are
not rediscovered and then forgotten.

## 1. `syncXferToolAvailability` is a no-op

`index.ts` computes the peer check and throws the result away:

```ts
function syncXferToolAvailability(): void {
  const hasPeers = state.identity !== null && hasLivePeer();
  const active = pi.getActiveTools();   // ← read, never written back
}
```

The comment above it promises the opposite: *"keep the ~1KB tool description out of the
prompt whenever there is no peer to talk to."* It runs on `before_agent_start`, so the hook
point and the predicate are both already in place; only the write is missing. Nothing caught
it because the repo has no `tsconfig.json` and `npm test` runs through a resolve hook, so the
two unused locals are never type-checked.

**Why deferred.** Not Milestone 4's business, and it is a prompt-budget optimisation rather
than a correctness fix. It surfaced twice during the item 4 discussion because an always-
present tool is part of why autonomous sends are possible at all.

**Revisit when** someone wants the tool absent rather than merely discouraged, or wants the
prompt back.

## 2. Handoff documents in `os.tmpdir()` are never reaped

Four write sites, one `unlink`, and that one is on the failure path:

| Site | Write |
|---|---|
| `index.ts:107` | `pi-xfer-<msg_id>.md` |
| `mesh.ts:308` | `pi-xfer-<message.id>.md` |
| `broker-main.ts:363` | `pi-xfer-<msgId>.md` |
| `adapterd.src/main.ts:215` | `xfer-adapterd-<id>.md` |

`index.ts:126` is the only removal, and it runs only when the notify throws. On the success
path nothing deletes the file: `controller.deliverInbound` only tells the model the path, and
`gc.ts` reaps `.sock` and `.json` only. Every successful handoff therefore leaves a file in
the system temp directory for the lifetime of the machine.

**Why deferred.** Adding an inbound `held` state is the thing that makes this urgent — held
documents must outlive the turn, possibly forever — and that was declined (ADR-0020). Without
hold, the leak is bounded by temp-directory hygiene rather than by correctness.

**Revisit when** hold is reconsidered, or when a tmpdir sweeper is wanted for its own sake.

## 3. Duplicated paragraph in a module header

`handoff-kind.ts` states the same two-sentence paragraph about the tool stamping the header
line twice, in consecutive blocks of its header comment. Harmless, but it is the kind of
duplication that hides a real edit later.

**Why deferred.** Cosmetic; it will be swept by whatever next touches that file.

## 4. `msgId()` is neither monotonic nor sortable

`utils.ts`:

```ts
export function msgId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
```

It embeds a base-36 timestamp but appends randomness after it, so string ordering does not
match time ordering and nothing can reconstruct a thread's order from ids alone. Making it a
monotonic counter would be a small change.

**Why deferred.** Nothing needs it today. It becomes load-bearing only if handoffs carry
causation — which `phase4-features.md` puts out of scope, and which is the actual blocker on
Milestone 4 item 4.

**Revisit together with** the causal-field decision, not before.
