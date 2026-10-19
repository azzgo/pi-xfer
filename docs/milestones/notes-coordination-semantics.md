# Coordination semantics — research input (multi-sender coordination in the handoff / Board / broker surfaces)

Provenance: read-only code walkthrough of `main` at the user's request, 2026-10-18. No files were
changed except this one; no test was run; no mesh engine was started; no live deployment was
touched and `XFER_ALLOW_REMOTE` was not set. Claims cite `file.ts:line` (`file.ts:LINE`); behavior
inferred only from test files is marked **[from tests]**. Product judgement is deliberately absent
— open questions are collected at the end.

Scope: what the repo actually does about *more than one message, more than one sender, more than one
exchange at a time*. The primitives are `handoff` (one-way document, carries a Kind), `Board` /
`Card` / `Entry` (machine-local async collaboration), the `Broker` (web-picker reverse channel), and
`Node` / `peer` discovery. All terms are used as defined in `CONTEXT.md`.

---

## 1. Handoff wire shape: there is no thread, no reply reference, no causal chain

### 1.1 The two wire shapes

| Transport | Frame | Fields | Cite |
|---|---|---|---|
| local (peer socket) | `XferNotifyMessage` | `type:"xfer-notify"`, `msg_id`, `from`, `file`, `summary` | `types.ts:18-24` |
| mesh (Node actor queue) | `MeshHandoffMessage` | `id`, `from`, `to?`, `summary`, `document` | `mesh-engine.ts:8-15` |

Both are flat. The mesh shape carries the document inline, the local shape carries a filesystem
path to a tmp doc (`index.ts:102-108`, `mesh.ts:308-309`). Nothing else survives the wire.

The local ack is `{type:"ack", msg_id}` (`server.ts:44-47`, matched in `client.ts:94-97`) and the
broker's unix-socket push uses the same ack grammar (`broker-main.ts:290-296`). The ack is a
*transport* receipt matched by `msg_id`, not an application-level reply.

### 1.2 Kind is the only relational field, and it is a declaration, not a link

`kind: task | notification` is one header line in the document head, parsed by `readHandoffKind`
(`handoff-kind.ts:53-62` → `parseHandoffKind` `handoff-kind.ts:44-50`), stamped by the sending tool
from a required parameter (`stampHandoffKind` `handoff-kind.ts:72-80`). It says *what this handoff
asks for*. It does not say **which** handoff it answers.

`grep` over the tree for `thread|reply_to|replyTo|parent_id|parentId|in_reply|causal` returns
**no implementation site** — only prose:
- `CONTEXT.md:86` — "the reverse message is itself a Handoff — never a 'reply' or 'receipt'";
  `CONTEXT.md:57` — "_Avoid_: thread, log" (for Conversation).
- `docs/milestones/notes-reason-network-wake.md:31,106` — an external design sketch
  (`Envelope{id, from, to, reply_to, thread, …}`) explicitly framed as *对齐但命名须用 CONTEXT.md 词汇*.
  Not code, not an ADR.
- `mesh-config.ts:267` — "thread" as in OS thread, unrelated.

So: **no thread / session grouping / reply reference / causal chain exists, and no field is
reserved for one.** The only place a reply "points back" is human-readable prose inside the
document body: the `/xfer <target>` and `/xfer mesh <target>` request templates ask the agent to
write a `**Return address**: from=<name>` line in the doc (`commands.ts:460`, `commands.ts:679`),
and the web-picker doc renders a `from:` / `handoff_id:` footer (`handoff-doc.ts:249-250`). Those
are markdown the model is asked to produce; nothing parses them back.

### 1.3 What the receiver is told about ordering

`controller.deliverInbound` builds the envelope text and passes `msg_id` through verbatim:
`**Handoff**: \`${msg.msg_id}\` — kind: ${kind}` (`controller.ts:38`, `controller.ts:47-53`).
The id is displayed; it is not compared to anything. There is no receiver-side index of ids, so an
agent cannot ask "is this the answer to what I sent".

---

## 2. `msgId()` — unique-ish, not monotonic, not sortable, not causal

```ts
export function msgId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
```

`utils.ts:9-11`. Properties, stated precisely:

- **Not globally unique by construction**: `Math.random()` over 6 base36 chars (~2.2 × 10⁹ space).
  Collision is unlikely but unguarded — no registry, no counter, no clock sequence.
- **Not monotonic**: `Date.now()` is not monotonic (NTP steps, clock skew across machines), and the
  random half dominates intra-millisecond ordering.
- **Sortable only by prefix, and only within one machine's clock**: lexicographic sort of the whole
  id also compares the random suffix; two ids minted in the same millisecond order arbitrarily.
- **No causality**: the id encodes no `from`, no target, no parent. Two peers id-ing concurrently
  produce ids that cannot be ordered.

Call sites, all minting a fresh id, no id reuse except a deliberate recovery probe:
`index.ts:102` (`xfer_to`), `mesh.ts:242` (default arg of `MeshNode.send`, used by `xfer_mesh_to`
via `index.ts:172`), `adapterd.src/main.ts:186` (local `send`), `adapterd.src/main.ts:263`
(`mesh send`). The same id is later reused only when a caller passes it back deliberately —
`MeshNode.send(target, params, id)` carries the doc comment that re-sending under the original id
is the recovery probe the receiver's dedupe window covers (`mesh.ts:230-241`).

The broker mints ids by a **different scheme**: `m<base36 Date.now()><base36 counter>`
(`broker-main.ts:255-258`, `nextMsgId`) and request ids with an `r` prefix
(`broker-main.ts:260-263`). So the id space has two grammars; nothing distinguishes them
programmatically, and no field says which grammar produced an id.

Consequence: **causality cannot be inferred from ids; it would have to be an explicit field**, and
no such field exists (§1.2).

---

## 3. Multiple senders into one receiver

### 3.1 Local socket path (pi extension)

`server.ts:11-50` — one `net.Server` on `<name>.sock`. Per connection: a string buffer, JSON-lines
split on `\n`, and for each parsed frame with `type === "xfer-notify"` and a string `msg_id`:
`delivery.deliver(msg)` **synchronously, then** `socket.write(ack)` (`server.ts:40-47`).

`XferController.deliverInbound` (`controller.ts:25-72`) is synchronous end to end: it reads the
sender-cwd stamp (`controller.ts:31`), reads the Kind (`controller.ts:37`), composes a string and
calls `pi.sendMessage(...)` (`controller.ts:66-70`). No awaits before the send.

So for the local transport:
- **No overwrite**: each `xfer-notify` becomes its own `sendMessage` call tagged
  `customType: "xfer-inbound"` (`controller.ts:67`). Nothing is keyed by sender or by id, so
  nothing can collide.
- **Queueing**: there is none in xfer. Ordering is whatever the event loop gives: frames on one
  connection are handled in arrival order; frames on *different* connections (sender A and sender B
  are different `net.createConnection` clients, `client.ts:17`) interleave by socket scheduling.
  There is no sequence number, so the receiver's transcript order is not provably the writers' order.
- **Render order is decided by pi, not by xfer** (see §3.2).

### 3.2 Busy vs idle: `steer` vs `followUp` — the one deliberate ordering decision

```ts
}, isIdle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" });
```

`controller.ts:70-72`, with `isIdle = state.isRuntimeIdle()` (`controller.ts:27`) delegating to
`runtimeContext.isIdle()` and defaulting to idle when there is no context or the call throws
(`state.ts:73-77`).

- **Idle receiver**: `followUp` + `triggerTurn` — the message starts a turn and is queued as a
  follow-up.
- **Busy receiver**: `steer` — the message is injected into the running turn.
- **No context** (controller constructed but session never started): treated as idle, so
  `followUp`. In that branch `state.identity` is also null, but `deliverInbound` never reads
  identity, so delivery still proceeds **[from code]**, and `controller.test.ts:31-34` exercises
  exactly this: a fake `pi` with only `sendMessage`, no `runtimeContext`.

The semantics of `deliverAs: "steer"` for a second concurrent message — whether it interrupts,
appends mid-turn, or waits — live in pi's runtime, not in this repo. **Not verifiable from this
tree** (§7).

### 3.3 Mesh path (Node actor queue)

The actor's `run` loop is a single `for await` over `c.queue.iter()` (`mesh-engine.ts:236-249`):
each message is checked for duplicate, then `onHandoff(...)` then `recordMeshDelivery(...)`, in
order, one at a time. `onHandoff` writes the doc synchronously and calls the same
`deliverInbound`-equivalent (`mesh.ts:304-323`; the controller is wired in at `index.ts:38-41`).
So **the mesh transport serializes per Node** and does not overwrite: queue order is the delivery
order, and A and B both arrive.

Note the two transports land in the same `deliverInbound`, hence the same `steer`/`followUp`
branching — a mesh handoff and a local handoff are indistinguishable downstream except for the
`· mesh` label (`controller.ts:29`, `controller.ts:55`).

### 3.4 The document filesystem is a shared, name-keyed namespace

Both mesh deliveries and local `xfer_to` deliveries write to
`path.join(os.tmpdir(), \`pi-xfer-${id}.md\`)` — `mesh.ts:308`, `index.ts:103`, and the broker's
submit path `broker-main.ts:363`. The filename is a function of `msg_id` (or the broker's own id)
only. There is no per-sender or per-transport directory. Two consequences that follow directly from
the code:

- A **cross-machine** collision (host A's `msgId` equal to host B's) would make both nodes write the
  same path on *their own* machines — harmless — but on one machine, a local sender and a mesh
  peer minting the same id would collide. Probability is the `Math.random()` collision of §2.
- A **recovery probe** deliberately reuses the id, so it overwrites the previous doc file
  (`mesh.ts:308` is an unconditional `writeFileSync`). That is the intended dedupe/probe design, and
  it also means the old doc's content is gone if the probe carries different bytes.
- `/tmp` cleanup is **not** implemented (`grep tmpdir` shows only the writers:
  `index.ts:103`, `mesh.ts:308`, `broker-main.ts:363`, `adapterd.src/main.ts:215`; neither `gc.ts`
  nor the Admin ever removes them).

### 3.5 Adapter Daemon (non-pi Agent Host) — a different multi-sender answer

`adapterd.src/daemon.ts:141-160`: every delivered frame is appended as one JSONL line to
`<name>.inbox.jsonl` (`appendInbox`, `adapterd.src/inbox.ts:38-42`) **before** anything else runs,
then `--on-handoff` is spawned with the record on stdin. Consumption is `takeInbox`
(`adapterd.src/inbox.ts:76-91`), which renames the file out of the way first so a concurrent append
lands in a fresh file and survives **[from tests]** (`adapterd.test.ts:132-140`).

So adapterd **does** queue, durably-ish (the file is the queue; `CONTEXT.md:44-48` insists it is
"take-to-read … no durable storage behind it"). Two differences from the pi extension worth
recording:
- append-before-process means a crash after ack but before `take` leaves the record in the inbox;
  the pi extension has no such record at all — its only trace is the tmp doc and `mesh.log`.
- multiple `--on-handoff` children can be in flight at once (`adapterd.src/daemon.ts:107-138`
  tracks a `handoffChildren` set), so adapterd's concurrency model is process-per-handoff, not
  in-process injection.

---

## 4. Board: what it supports, who uses it, and what conversation shape it can hold

### 4.1 Shape

`board.ts`:
- Location: `~/.pi/xfer/board/` (`board.ts:7`), machine-local by ADR
  (`docs/adr/0014-board-stays-machine-local.md`).
- `Card` = front matter `id/title/created_by/created_at` (`board.ts:12-17`, serialized at
  `board.ts:86-88`) + a body of Entries. `Card` in memory adds `file`, `body`, `entries`
  (`board.ts:20-25`).
- `Entry` = `id`, `type`, `author`, `at`, `text` (`board.ts:27-34`); rendered as
  `### e-XXXX · type · author · timestamp` (`board.ts:92-95`).
- Ids: `c-0001`, `e-0001`, allocated by scanning existing ids for the max
  (`board.ts:63-70`, `board.ts:72-79`). No uuid, no counter file — allocation reads the directory.
- `create` (`board.ts:179-192`), `append` (`board.ts:194-200`), `del` (`board.ts:202-207`),
  `clean` (`board.ts:209-215`). **There is no `read`-modify-delete of an Entry, no edit, no
  status field.** Append-only is enforced by there being no other writer.
- Every write is a full-file `fs.writeFileSync` of `serialize(card, appendEntryText(...))`
  (`board.ts:198`). No lock, no atomic rename, no merge: **two processes appending to the same card
  concurrently will produce last-writer-wins loss** of the earlier entry. `board.ts` has no
  cross-process guard at all; `grep` finds no `flock`/`O_EXCL`/lockfile in the file.
- `Marker` is **not a Board concept** — `CONTEXT.md:69-71` defines it under Web Picker, and no
  Board code mentions it (`grep -i marker` over `*.ts` hits only web-picker / handoff-doc).

### 4.2 Who uses it — complete call-site list

| Call site | What it does | Can write? |
|---|---|---|
| `commands.ts:79` | `registerBoard(pi, {boardDir, getAuthor: identity.name})` — the only registration | — |
| `board.ts:244-283` | `agent_end` interceptor: takes pending write, parses a ` ```board-entry ` block out of the last assistant message, then `create`/`append` | **yes** |
| `commands.ts:495-607` | `/xfer board list\|new\|read\|write\|del\|clean\|open` | via `setPending` (`commands.ts:513`, `commands.ts:558`) |
| `admin-main.ts:480-494,585,637` | Admin console: `new Board(boardDir).list()`, `.read()` — render only | **no** (read-only by design, `admin-main.ts:614`) |
| `admin-main.ts:764-773` | `/board/open` → `board.read(card)` → `openPath(file, true)` (opens the editor) | no write in-page |

That is the whole surface. **No `pi.registerTool`** — agents cannot touch a Card unprompted; per
ADR 0009 the human is the sole coordinator (`docs/adr/0009-xfer-board-command-driven.md:20-27`).

### 4.3 Pending-write state is a single slot

`Board.pending: PendingWrite | null` (`board.ts:150-151`, `board.ts:158-168`) holds exactly one
pending write. `/xfer board write` sets it (`commands.ts:558`) and injects a prompt; the
`agent_end` handler consumes and clears it first thing (`board.ts:248-251`). Therefore:

- **Two overlapping board writes are not queued.** The second `setPending` overwrites the first;
  the first prompt's reply then lands on the second card. The code has no guard against
  `/xfer board write` being issued twice before the first `agent_end` fires — the overwrite is
  silent, and only the losing intent disappears (no warning at either `setPending`).
- Any other turn's `agent_end` **before** the intended reply will consume the pending state and
  abort with "reply had no ```board-entry block" (`board.ts:259-263`), leaving the write unapplied.
  Single-slot + first-`agent_end`-wins is the whole concurrency story.

### 4.4 What conversation shape it can hold

What is supported today: an ordered append-only Conversation (`CONTEXT.md:54-57`) inside one Card,
written *only* by a human-invoked command in *some* agent's session. Reader = whoever the human
injects it into (`commands.ts:531-542`, injected with "Do not take action yet — wait for their
instruction").

What is absent, from the code:
- **No notification** to any participant that a card changed. No file watcher, no socket event;
  `admin-main.ts` re-reads on request, `commands.ts` re-reads on command.
- **No per-participant read cursor / ack**. Nothing records who has read which Entry.
- **No attribution of "who this Entry answers"** beyond the free-text body; Entry ids are
  per-card, so an Entry id is not addressable across cards.
- **No cross-machine path** (ADR 0014: use directory sync, zero code). Entry ids are `max+1` over
  the local directory (`board.ts:72-79`), which is exactly the id scheme that collides under
  concurrent bidirectional file sync.
- **No lifecycle**: `CONTEXT.md:52-53` — "no lifecycle statuses, cleanup happens only when the human
  explicitly runs del / clean". Entry `type` is a label that "drives no logic" (`CONTEXT.md:54-56`,
  `board.ts:27-34`).

So today the Board can carry *a human-curated record of what agents said*, not a conversation
between agents that progresses on its own. Both ends of every hop are the human (ADR 0009 records
this as intended: "latency floor of one human round-trip per hop",
`docs/adr/0009-xfer-board-command-driven.md:59-62`).

---

## 5. Duplicate delivery and dedupe: mesh yes, local no, adapterd only structurally

### 5.1 Mesh — a 3-entry sliding window in durable actor state

- `XferInstanceState.delivered?: string[]` — "Handoff ids already delivered, oldest first. Absent on
  actors that never received one." (`mesh-engine.ts:18-23`).
- `DELIVERED_WINDOW_SIZE = 3` (`mesh-engine.ts:32`), with a doc comment stating *why* three: the
  only expected redeliveries land "next to the window's live edge" (`mesh-engine.ts:25-31`).
- `isDuplicateMeshHandoff` = `delivered.includes(id)` (`mesh-engine.ts:90-92`);
  `recordMeshDelivery` dedups the id, appends, then `slice(-3)` (`mesh-engine.ts:95-99`).
- Wiring: the actor run loop drops a hit and writes one `mesh duplicate` log record
  (`mesh-engine.ts:236-245` → `meshDuplicateLogLine` `mesh-engine.ts:102-108`); the miss path
  delivers and *then* records (`mesh-engine.ts:247-248`), i.e. **at-most-once per id within the
  window, at-least-once overall** — a crash between `onHandoff` and `recordMeshDelivery` repeats
  the delivery on redelivery.
- The window is bounded, so a genuine re-send under the same id after 3 more handoffs has landed is
  **not** deduped and will be delivered again. That is a documented bound, not a bug
  (`mesh-engine.ts:25-31`).
- A test asserts the window's edge behavior and that a failed delivery is not recorded
  (`mesh-dedupe.test.ts:110-113`, `mesh-dedupe.test.ts:172`) **[from tests]**.

### 5.2 Local socket — no dedupe at all

`server.ts:40-47` delivers every `xfer-notify` with a string `msg_id`. There is no recent-id set,
no file check, no comparison. `grep isDuplicateMeshHandoff` shows it is mesh-only (plus the
Cloudflare example, `examples/pi-durable-cf/src/mesh-actor.ts:44-61,84`). A sender retrying a local
`xfer_to` under the same `msg_id` **will** be delivered twice; nothing in the local path can tell.
`XferState` (`state.ts:8-20`) keeps identity/status only — no message bookkeeping.

### 5.3 adapterd — append-always, no id dedupe

`appendInbox` runs unconditionally on every delivery (`adapterd.src/daemon.ts:141-156`). Mesh-side
dedupe still applies (the `MeshNode` in `adapterd.src/daemon.ts:169-177` wraps the same
`createRivetEngine`), so a mesh redelivery inside the window never reaches the inbox. A **local**
delivery reaches the inbox every time, including a byte-identical retry. `InboxRecord.id` is the
`msg_id` (`adapterd.src/inbox.ts:9-21`), so dedupe *could* be done by a consumer, but nothing in the
tree does it.

### 5.4 The broker's own last-write-wins maps

Two module-level maps keyed **only by target name**:
`latestHandoffByTarget: Map<string,string>` and `latestTabIdByTarget: Map<string,string>`
(`broker-main.ts:529`, `broker-main.ts:538`), written on every successful `annotation.submit`
(`broker-main.ts:395`, `broker-main.ts:400`). `routePageTool` reads them to decide *which tab* the
next `page.request` goes to and stamps `handoff_id: latestHandoffByTarget.get(target) ?? "demo"`
(`broker-main.ts:596-612`).

- Two browser tabs submitting to the same target: the **second** submission wins both maps; the
  first tab stops receiving follow-ups until it submits again (fallback is broadcast only if the
  recorded tab is *gone* — `broker-main.ts:601-603`).
- The reverse channel therefore carries the id of the *most recent* handoff only; there is no
  per-tab or per-handoff routing. Undocumented consequence: a targeted `page.request` answers
  whatever the tab currently is, regardless of which handoff the tool call was meant for.
- These maps are `const` at module scope and are **not reset by `startBroker`** (unlike `tabConns`
  at `broker-main.ts:721`), so a restarted broker in one process (tests, or an embedded restart)
  inherits the previous instance's entries.

---

## 6. End-of-exchange semantics: convention, not enforcement

### 6.1 What is asserted

`kind: task` "comes back with exactly one conclusion (done, blocked, or needing input)"
(`index.ts:7`-area tool description `index.ts:88`, and `xfer_mesh_to`'s `index.ts:146`); the
receiving envelope repeats it as a prompt line (`controller.ts:57-59`): "Send exactly one reverse
handoff … A bare acknowledgement is not a conclusion." `notification` gets the opposite line —
"Do not reply" (`controller.ts:60`).

### 6.2 What is enforced

**Nothing.** Enumerating every mechanism that could close a task:

| Mechanism | Present? | Cite |
|---|---|---|
| Reply wait / blocking | No — "returns immediately … (no reply wait)" | `index.ts:88`, `index.ts:146`, ADR 0018 "no reply wait" `docs/adr/0018-handoff-kind-sender-declares.md` |
| Local socket closes after ack | Yes — `sock.end()` after the matching ack | `client.ts:44-48` |
| Mesh send resolves at enqueue | Yes — `handle.send(...)`, then return | `mesh-engine.ts:255-262` |
| Pending-exchange record on the sender | **No** — no table keyed by handoff id anywhere (sender side has no `state` beyond identity/status, `state.ts:8-20`) | — |
| "Exactly one" enforced (2nd reply rejected) | **No** — a second reverse handoff is a brand-new handoff; the receiver-side dedupe only drops *the same id* | §5.1 |
| Timeout / stale-task detection | **No** — `doctor.ts` has five checks (socket dir, peers, broker, admin, mesh) and none looks at outstanding handoffs | `doctor.ts:67-73`, `doctor.ts:184-206` |
| Sender-notified-on-no-reply | **No** | — |
| Kind read back on an inbound to *close* a chain | Kind is read and shown (`controller.ts:37`), never compared against anything outstanding | — |

ADR 0018 states this deliberately as a consequence: "A Task's reply is an obligation on the
receiver, not a delivery guarantee … a sender must not block on it"
(`docs/adr/0018-handoff-kind-sender-declares.md:14-16`). So `kind: task` is a **social contract
carried by a markdown line plus a prompt sentence**.

Two adjacent facts about *declaring* the kind, worth recording separately:
- The pi tools require `kind` as a tool parameter and stamp it (`index.ts:92-96`, `index.ts:112` /
  `index.ts:151-153`, `index.ts:168`), so a model cannot omit it.
- The adapterd CLI requires `--kind` and fails without it (`adapterd.src/main.ts:178-182`,
  `adapterd.src/main.ts:245-249`).
- The **broker's picker docs hard-code task**: `renderHandoffDoc` always emits
  `formatHandoffKind("task")` (`handoff-doc.ts:226`) with the comment "A submit is a Task". A
  web-picker submit therefore always asks for output, and `controller.deliverInbound` also routes
  it to the web-picker branch, which emits neither the task nor the notification obligation text
  (`controller.ts:54-58` walks only the agent branch) — it points at the page-tool CLI instead
  (`controller.ts:55-65`). The Kind line is in the doc but not in the envelope for that sender.
- A doc with no kind line **and** unreadable head reads as `notification`
  (`handoff-kind.ts:27`, `handoff-kind.ts:53-62`), i.e. an older or corrupt handoff silently asks
  for nothing.

### 6.3 Where an exchange dead-ends today

- Sender sends a task; receiver never picks it up. Mesh: the only signal is the enqueue verdict
  (`not-delivered` / `unknown` / `failed`, `mesh-engine.ts:610-700`), which is about the *queue*,
  not the human or model. Local: `sendNotify` resolves on the transport ack (`client.ts:44-48`).
- Sender's session ends before the reply arrives. Nothing holds the id; the inbound envelope of the
  reply will simply be a fresh message from the other side, with no marker that it answers anything.
- Receiver dies mid-task. Mesh redelivery repeats the work (window of 3, §5.1); local does not (the
  socket write already acked).

---

## 7. What was not checked

- **pi's `deliverAs: "steer"` semantics** — whether a steer message reaches the running turn
  immediately, is appended to the pending user messages, or can be dropped, is defined in
  `@earendil-works/pi-coding-agent`, not here. `controller.test.ts` does not assert the option
  object at all (its fake `pi` records `{customType, content}` only, `controller.test.ts:20-34`), so
  even the *choice* of steer vs followUp is untested; only the content is.
- **RivetKit's queue-actor ordering and redelivery guarantees** for a multi-producer queue. The
  code assumes FIFO per Node and redelivery near the live edge (`mesh-engine.ts:25-31`), but that
  assumption is documented in a comment, not asserted against the engine anywhere in the tree.
- **Whether a second `annotation.submit` from a second tab while the first tab's page-tool call is
  in flight** can starve the first tab — inferable from `latestTabIdByTarget` being last-write-wins
  (§5.4) but not exercised by a test.
- **Behaviour under real concurrency for the Board single `pending` slot** — no test covers two
  overlapping `/xfer board write` calls; the overwrite is read off the code.
- **Cross-machine `/tmp` id collision** and its practical rate — bounded by §2 only.
- **The `examples/pi-durable-cf` actor's dedupe** was read but not exercised (per `AGENTS.md` it has
  no local stand-in).
- Nothing was run: no `npm test`, no engine, no admin page, no tmux smoke.

---

## 核对与存疑

核对方式：逐条对着工作树重读被引用的行；没有运行任何测试或引擎，因此除标注 **[from tests]**
的两处外，所有行为断言都来自源码阅读。

已在阅读中自查并修正的几处：
- `index.ts` 的工具描述行号是 `:88` / `:146`（`xfer_to` / `xfer_mesh_to`），`kind` 参数分别是
  `:92-96` / `:151-153`；先前草记成 156 一类的旧行号，已按当前树更正。
- `mesh.ts` 的 `onHandoff` 行号 `:304-323`、doc 写入 `:308`，与 `notes-mesh-peer-identity.md`
  verification notes 里"行号已漂移 ~20-30 行"的提醒一致，本文全部用当前树行号。
- `state.ts` 的 `setStatus` / `isRuntimeIdle` 是 `:68` / `:73`（不是文件头注释所说的一处集中
  区块），`grep -n` 复核过。

存疑（未能在本仓内解决，列为开放问题，不构成建议）：
1. **`steer` 与 `followUp` 的真实排序语义**在 pi runtime 内。本仓只选择了其中一支
   （`controller.ts:70-72`），并把它当作"忙时插话、闲时排队"。多发送方并发时，这是整个
   协调语义最关键的一处外部依赖，而本仓既无测试断言选择本身，也无法断言其效果。
2. **Board 的单一 `pending` 槽**（`board.ts:150-151`）与 ADR 0009 的"two-phase writes … nothing
   half-written"（`docs/adr/0009-xfer-board-command-driven.md:42-47`）之间存在张力：ADR 保证的是
   单个写入不会写半张卡，代码确实做到了；但两次重叠的 write 会让第一次的意图**静默消失**，
   这不是"half-written"，却也不是任何一处文档描述过的状态。是否算 ADR 覆盖范围之外，留给人判断。
3. **`CONTEXT.md` 说 Inbox「There is no durable storage behind it」（`:44-48`），而 adapterd 的
   Inbox 恰恰是一个 append-only JSONL 文件**（`adapterd.src/inbox.ts:8-21,38-42`），只有在 `take`
   之前才是持久的。用词本身不矛盾（语义是 take-to-read），但"no durable storage"这句话在
   阅读代码时容易被读成"不落盘"。
4. **handoff id 的两套语法**（`utils.ts:9-11` vs `broker-main.ts:255-258`）共存，且 `handoff_id`
   字段在 web-picker 文档里写作 `demo` 兜底（`broker-main.ts:610`）。是否有下游会把这个兜底当成
   真实 id，本仓内看不出来。
5. **`latestHandoffByTarget` / `latestTabIdByTarget` 不被 `startBroker` 重置**
   （`broker-main.ts:529,538` vs `broker-main.ts:721` 的 `tabConns = new Map()`）。这是否会影响
   开发中的 broker 重启与测试隔离，未验证。
6. **`xfer_to` 一次发送 = 一个 `/tmp` 文件，无人回收**。是否有意为之（`/tmp` 依赖系统清理），
   文档未说；`gc.ts` 明确只管 socket 与 metadata。

Related: `docs/adr/0009-xfer-board-command-driven.md`、`docs/adr/0014-board-stays-machine-local.md`、
`docs/adr/0018-handoff-kind-sender-declares.md`、`CONTEXT.md`（Handoff / Notification / Task /
Board / Card / Entry / Conversation / Inbox 条目）。
