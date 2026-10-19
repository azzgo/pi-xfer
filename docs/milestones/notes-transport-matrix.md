# Transport matrix — research input (end-to-end capability of every messaging surface in the tree)

Provenance: direct read-only code walkthrough by the pi session in project `pi-xfer`
(branch `main`), 2026-10-19. No file was created or
modified except this one. No engine was started, no tunnel/relay contacted,
`XFER_ALLOW_REMOTE` was never set, and no test was run — source plus the tree's
own hermetic test files were read only. Terminology follows `CONTEXT.md`
(Mesh / Node / Runner / pool / Delivery verdict / Adapter Daemon / Inbox / Board /
Card / Entry / Web Picker / Marker / Pick / Record / Handoff / Notification /
Task / peer).

Scope: this file is a fact sheet, not a decision. It records **what each
transport does today**, **what a sender can learn from it**, **what happens to
the message on the receiving side**, **what the channel structurally cannot do**,
and **what error text a failure produces**. No ordering, no recommendation, no
ADR is proposed. Where the implementation sits in tension with a settled ADR, it
is recorded as an open question in §9.

## 1. The six surfaces, in one view

| # | Surface | Direction | Entry points |
|---|---|---|---|
| A | local Unix socket (peer) | one-way Handoff, per message | `xfer_to` (`index.ts:74`), `xfer-adapterd send` (`adapterd.src/main.ts:169`) |
| B | Mesh (RivetKit) | one-way Handoff, per message | `xfer_mesh_to` (`index.ts:158`), `/xfer mesh <name> <request>` (`commands.ts:444`), `xfer-adapterd mesh send` (`adapterd.src/main.ts:236`) |
| C | broker + Web Picker (page → agent) | one-way Handoff, page-originated | `annotation.submit` (`broker-main.ts:333`) |
| D | broker page-tool (agent → page) | synchronous request/response | `POST /page-tool` (`broker-main.ts:699`), CLI `broker-main.ts page-tool` (`broker-main.ts:956`) |
| E | Adapter Daemon Inbox | one-way Handoff, non-pi host | `xfer-adapterd up` (`adapterd.src/daemon.ts:82`), `inbox take\|list` (`adapterd.src/main.ts:288`) |
| F | Board | append-only Card Entries, human-commanded | `/xfer board …` (`commands.ts:475`, `board.ts:84`) |

A/B are the two transports of the same Handoff protocol; C rides A on the
receiving leg; D is the only channel in the tree that is not a Handoff; E is the
same A/B wire with a different receiver; F carries no message at all.

---

## 2. Row A — local Unix socket (peer)

**End-to-end path.** Sender tool branches by transport, then hands a JSON line to
the peer's socket file.

1. `xfer_to` mints `msgId()`, stamps Kind + sender-cwd anchor into the document,
   writes it to `os.tmpdir()/pi-xfer-<msg_id>.md` (mode 0600)
   (`index.ts:97-105`).
2. `sendNotify` resolves `endpointForName(target)` = `<xfer-dir>/<encoded>.sock`
   and `net.createConnection`s to it (`client.ts:12-20`).
3. On connect it writes one JSON line `{type:"xfer-notify", msg_id, from, file,
   summary}` and arms an ack timer (`client.ts:47-51`).
4. The receiver's `createServer` parses JSON lines, and for a frame with
   `type === "xfer-notify"` and a string `msg_id` calls `delivery.deliver(msg)`
   and only then writes `{type:"ack", msg_id}` on the same socket
   (`server.ts:36-39`).
5. `XferController.deliverInbound` renders the message into the session via
   `pi.sendMessage({customType:"xfer-inbound"}, …)`, idle-aware:
   `followUp + triggerTurn: true` when idle, `steer` when busy
   (`controller.ts:30-70`). The document body is **not** inlined into the
   message — the agent is told the `Doc` path and told to read it
   (`controller.ts:41-45`).

**Confirmation semantics.** Exactly one ack, of the coarsest possible grain: the
bytes were parsed and handed to `deliver()`. The ack carries nothing but the
echoed `msg_id` (`server.ts:38`). It says nothing about whether the model saw
the message, whether the document was read, or whether the session was idle.
`client.ts` resolves on the matching ack (`client.ts:78-82`). Nothing else on
this channel is confirmed. A reverse Handoff (the Task conclusion) is *a new A
message in the other direction*, not a reply frame — ADR 0018 makes Kind a
property of the document, and `controller.ts:60-64` only instructs the model, it
does not carry a return channel.

**Persistence.** Nothing durable. The document lives in `os.tmpdir()` forever
(`index.ts:103`); the sender deletes it only when the send *fails*
(`index.ts:120`), so every successful handoff leaks one file into the temp
directory. There is no gc path for `pi-xfer-*.md` in `gc.ts` — `gc.ts` covers
only `<name>.sock` / `<name>.json` (`gc.ts:18-24`, `gc.ts:117-155`). The inbound
message itself exists only as the injected conversation content. If the receiving
process dies between writing the doc and the agent reading it, the content is
unreachable-by-pointer but present on disk until the OS cleans temp.

Who cleans: nobody in the repo. Board cleanup is explicit human action
(`board.ts:202-213`); peer-socket cleanup is `/xfer gc`; the temp documents have
no owner.

**Capability ceiling.**

- No buffering: the target must have a live socket file *and* a listener at send
  time. The existence check is `fs.existsSync(endpoint)` (`client.ts:15`) — a
  stale `.sock` from a crashed peer passes it and then fails at connect.
- No addressing beyond a filesystem name. `xfer_to` cannot reach a Mesh Node, an
  Adapter Daemon that is not running a local listener, a web page, or a Board.
- No reply relation: there is no `reply_to`/thread field (`types.ts:15-21` —
  `XferNotifyMessage` is `{type, msg_id, from, file, summary}`, full stop).
- 1 MiB per frame, enforced by destroying the socket
  (`server.ts:18-21`), so the *document is not in the frame* — only its path,
  which is why this channel cannot cross machines.

**Busy/idle visibility.** The sender can read `<name>.json` before sending, and
`targets.ts:18-33` exposes `sessionName`/`cwd`/`status`/`description`. `status`
is the receiver's own event-driven string (`thinking` / `tool:X` / `idle`)
written by `state.setStatus` (`index.ts:206-209`, `state.ts:38`). But **the ack
does not carry it**: a sender who did not read the file beforehand learns
nothing about the receiver's state from the send itself. The metadata is a
read-time snapshot — the writer polls at `METADATA_POLL_MS` = 1 s
(`constants.ts:16`, `state.ts:56-59`) and `targets.ts` does no polling of its
own (`targets.ts:57-73`).

**Failure modes (actual text).**

| Condition | Text | Source |
|---|---|---|
| No socket file | `peer "<target>" not found` | `client.ts:17` |
| No listener / connect fails | the raw `net` error (e.g. `connect ECONNREFUSED …`) | `client.ts:83` |
| Connect too slow (5 s) | `connect timeout` | `client.ts:25-27`, `CONNECT_TIMEOUT_MS` `constants.ts:13` |
| Frame written, no ack (5 s) | `ack timeout` | `client.ts:51`, `ACK_TIMEOUT_MS` `constants.ts:14` |
| Peer closes first | `peer closed before ack` | `client.ts:85-87` |
| Ack unparseable | `invalid ack` | `client.ts:66-74` |
| Ack larger than 1 MiB | `ack frame too large` | `client.ts:55-58` |

`xfer_to` wraps all of these: `xfer: failed to notify "<target>" — <message>`
and appends a long hint when the message matches `/not found/` explaining that a
web-picker sender is not an agent (`index.ts:122-127`). The tool's
`structuredContent.status` is the **constant** `"sent"` on success
(`index.ts:151`) — it is not derived from the ack at all.

---

## 3. Row B — Mesh (RivetKit)

**End-to-end path.**

1. `MeshNode.up` resolves config, builds the engine, lists nodes, refuses a
   same-name `Running` actor, checks pool match, then `ensureNode`
   (`mesh.ts:145-190`).
2. `createRivetEngine.ensureNode` loads the native addon, defines the
   `xfer-instance` actor with `state = {description, delivered}`,
   actions `setDescription`/`getDescription`, queue `handoff`, a `run` loop over
   `c.queue.iter()`, and `setup({… noWelcome, logging: baseLogger, envoy.poolName})`
   (`mesh-engine.ts:224-262`).
3. Send: `MeshNode.send` → `engine.preflight(target)` → `engine.queueSend`
   (`mesh.ts:239-250`). `queueSend` = `client.get(XFER_INSTANCE_ACTOR, [target])
   .send(HANDOFF_QUEUE, message, {signal: AbortSignal.timeout(30_000)})`
   (`mesh-engine.ts:300-306`, timeout `mesh-engine.ts:188`).
4. Receive: the actor's `run` loop deduplicates against `state.delivered`
   (`mesh-engine.ts:239-246`), calls `onHandoff(message.body, selfKey)`, then
   records delivery (`mesh-engine.ts:247-248`; window size 3,
   `mesh-engine.ts:32`).
5. `MeshNode.onHandoff` refuses a misroute (`message.to !== selfKey`) and
   otherwise writes the inline document to `os.tmpdir()/pi-xfer-<id>.md` and
   calls `deliver` (`mesh.ts:303-323`).
6. `index.ts:35` wires `deliver` to
   `controller.deliverInbound(msg, "mesh")` — **the identical local pipeline**,
   with `· mesh` appended to the header (`controller.ts:33`,
   `controller.ts:58`).

**Confirmation semantics.** Three-valued, and deliberately so. The enqueue
either returns (the engine accepted the message into the target actor's queue) or
throws a `MeshSendError` whose `kind` is the triage of the failure
(`mesh-engine.ts:341-360`):

- `not-delivered` — the engine answered `guard.actor_ready_timeout`; nothing
  entered the queue (`mesh-engine.ts:352-355`).
- `unknown` — the enqueue was never answered (client wait expired / connection
  dropped); it may still arrive (`mesh-engine.ts:356`).
- `failed` — any other refusal (`mesh-engine.ts:357`).

Before the enqueue, `preflightMeshSend` runs one engine round over `/actors` +
`/envoys` with a 6 s deadline (`mesh-engine.ts:436-441`, `PREFLIGHT_TIMEOUT_MS`
`mesh-engine.ts:510`). It throws `MeshPreflightError` for "no runner in pool",
"engine did not answer /envoys", "no such node" (`mesh-engine.ts:520-600`).
A preflight hit means **nothing was sent** — a strictly stronger statement than
anything row A can make.

Still, no branch of this is delivery confirmation. Whether the receiving agent
read the message is invisible to the sender, exactly as in row A. The receiver's
`state.delivered` window (3 ids) is for redelivery suppression
(`mesh-engine.ts:26-32`), not a receipt — no action exposes it to a sender.

**Persistence.** The message is durable inside the target actor's queue on the
engine; ADR 0013 records that the buffer only exists once the target actor has
been created. On the receiving machine the document is written to
`os.tmpdir()/pi-xfer-<id>.md` (`mesh.ts:308-309`) and never removed — same leak
as row A. `mesh.log` records ids, node names, byte counts and the doc path, never
body text (`docs/dev/mesh-log.md`, "Handoff bodies never reach the log"), and it
is append-only with no rotation anywhere in `mesh-log.ts` (`mesh-log.ts:22`
through the append helpers). Who cleans: nobody; `mesh.log` grows unbounded and
is documented as a human-read file.

**Capability ceiling.**

- One-way. A Task's conclusion is a fresh Mesh Handoff in the other direction.
- The document is a static snapshot: ADR 0013 removes the web-picker "Follow-up
  channel" section for mesh deliveries, i.e. **a mesh handoff has no reverse
  query channel**. (Note `handoff-doc.ts:122-135` always renders the section when
  `brokerCliPath` is passed; the removal is done by the callers that build mesh
  docs, not by the renderer.)
- A Node whose pool has no Runner cannot receive, but is still listed: the
  verdict vocabulary (`Running` / `Sleeping` / `NoRunner` / `Mismatch` /
   `Crashed` / `Pending` / `Unknown`, `mesh-engine.ts:407`) is a *derived* join of
  actor record and `/envoys`, and CONTEXT.md forbids calling it a status.
- `MESH_NODE_DESCRIPTION` (≤ 500 chars, `mesh-engine.ts:36`) is the only
  self-declared field. `XferInstanceState` is `{description, delivered?}`
  (`mesh-engine.ts:17-24`) — **no status, no busy/idle, no doing**.
- `down()` destroys the actor and with it the queued handoffs and the
  description (`mesh.ts:194-217`); ADR 0013 accepts this.
- No encryption: ADR 0019 settles that the payload is plaintext in transit and at
  rest, and that TLS is a deployment property.

**Busy/idle visibility.** `async state()` / `nodeState(target)` give the
delivery verdict (`mesh.ts:112-125`), which is what `/xfer mesh list` renders
(`mesh-status.ts:51-130`). That is availability, not busy/idle. The local
`currentStatus` signal exists only in row A's metadata file and never crosses to
Mesh (see §8, open question 1).

**Failure modes (actual text).**

| Condition | Text | Source |
|---|---|---|
| Not online (tool) | `mesh is not online — run /xfer mesh up first` | `mesh.ts:245`, `mesh-engine.ts:301` |
| Target has no actor | `mesh: no mesh node named "<target>" on the engine — … Nothing was sent` | `mesh-engine.ts:592-598` |
| Target actor alive, pool has no Runner | `"<t>" is online but cannot receive: no runner in pool "<pool>". Nothing was sent — start a runner for pool "<pool>" …` | `mesh-engine.ts:522-527`, remedy `mesh-engine.ts:437` |
| Actor reads idle but pool has a Runner | warning only: `"<t>" reads idle (no runner) … the engine places it on the next send` | `mesh-engine.ts:528-536` |
| Preflight could not reach the engine (6 s) | `mesh: could not check "<t>" before sending — engine did not answer /actors + /envoys within <ms> ms (…). Nothing was sent; the check is deliberately fail-closed …` | `mesh-engine.ts:573-583` |
| `/envoys` unanswered | `mesh: could not check "<t>" … engine did not answer /envoys … Nothing was sent` | `mesh-engine.ts:584-590` |
| Enqueue refused (`actor_ready_timeout`) | `enqueue to "<t>" was refused by the engine (engine said: …): no runner is serving the target's pool, so handoff <id> never entered its queue and nothing was sent` | `mesh-engine.ts:717-723` |
| Enqueue unanswered | `enqueue of handoff <id> to "<t>" got no answer before the client stopped waiting (…), so delivery is UNKNOWN — the engine may have accepted it and may still deliver it once a runner appears` | `mesh-engine.ts:726-732` |
| Any other refusal | `enqueue of handoff <id> to "<t>" failed (…), and whether it reached the target is unknown` | `mesh-engine.ts:734` |
| `up` conflicts with a Running owner | `mesh node "<name>" is already Running on another host — run /xfer mesh down there first (先在那边 /xfer mesh down)` | `mesh.ts:168-171` |
| `up` adopts an actor in another pool | `mesh node "<name>" was placed in <actual> but this config targets <desired> — an existing actor cannot change pools. …` | `mesh.ts:286-292` |
| Misroute on receive | delivered into the session as `⚠️ mesh misroute: handoff <id> from "<from>" was addressed to "<to>" but reached "<self>" — refusing to deliver it here` | `mesh.ts:334-352` |

`xfer_mesh_to` rethrows the `MeshSendError` kinds untouched so the triage
wording survives (`index.ts:197-198`); other errors get the prefix
`xfer mesh: could not send to "<target>" — <message>` (`index.ts:199`).
`structuredContent.status` is again the constant `"sent"` (`index.ts:194`), with
an optional `warning` carried in `details` (`index.ts:193`).

---

## 4. Row C — broker + Web Picker (page → agent)

**End-to-end path.**

1. The userscript opens `ws://127.0.0.1:<port>/ws`, sends `hello` with a stable
   tab id, receives `welcome` (`broker-main.ts:817-832`).
2. `annotation.submit` carries `{id, page, picks, prompt, target:{namespace:"local",name}, record?}`
   (`docs/dev/web-picker.md`, wire table).
3. The broker validates (`broker-main.ts:341-360`), refuses a non-`local`
   namespace (`broker-main.ts:366-369`), mints `msg_id`, renders the handoff doc
   from Picks (+ optional Record) for **the target's own xfer name**
   (`broker-main.ts:371-388`), writes it to `os.tmpdir()/pi-xfer-<msg_id>.md`
   (`broker-main.ts:392-397`), and remembers `latestHandoffByTarget` /
   `latestTabIdByTarget` for the reverse channel (`broker-main.ts:400-408`).
4. It then pushes the **same `xfer-notify` frame row A uses** to the target's
   local socket, with `from` stamped `"web-picker"` (`broker-main.ts:410-418`,
   `wire.ts:78`), and only on ack sends `ack{handoff_id, doc}` to the tab
   (`broker-main.ts:419-424`).
5. Receiver side: identical to row A, except `controller.ts:46-60` detects
   `from === FROM_WEB_PICKER`, **suppresses the cwd stamp** (a browser has no
   working directory), and injects an explicit instruction not to `xfer_to` back
   but to use the page-tool CLI, with a runnable command line.

**Confirmation semantics.** Two nested acks, both coarse:

- The broker→tab `ack{handoff_id, doc}` means "the peer socket acked" — i.e. row
  A's ack was received. It still does not mean the agent saw anything
  (`broker-main.ts:419-424`).
- On failure the tab gets `error{code}`: `target_not_found` when the socket file
  is missing, otherwise `delivery_failed` (`broker-main.ts:425-435`,
  `pushXferNotify` classifies at `broker-main.ts:258-266`).

Nothing tells the page the delivery was *read*. The reverse query channel (row D)
is the only way for the agent to answer, and it is a separate protocol.

**Persistence.** The rendered document lands in `os.tmpdir()` (0600) and is
explicitly kept even on delivery failure (`broker-main.ts:246-248` comment;
`broker-main.ts:433` logs `doc kept at`). No `pi-xfer-*.md` reaper exists. The
submit itself is not stored: `latestHandoffByTarget` and `latestTabIdByTarget`
are in-memory maps with no eviction (`broker-main.ts:530`, `broker-main.ts:543`),
so a broker restart forgets which tab owns which target and follow-ups fall back
to broadcasting (`broker-main.ts:600-604`).

**Capability ceiling.**

- The page can only address a **local** target: `namespace !== "local"` is
  refused outright (`broker-main.ts:366-369`). ADR 0013 keeps
  web-picker/broker off the engine permanently.
- The submit is one-shot. `annotation.compose` renders the same doc without
  writing or notifying (`broker-main.ts:436-478`) — a copy-prompt path for hosts
  that have no xfer at all; the resulting document then deliberately has **no**
  Follow-up channel (`docs/dev/web-picker.md:237-240`,
  `web-picker-offline-doc.test.ts:1-7`).
- The reverse channel is bound to an origin/page permission: on a site whose
  policy blocks the websocket the picker composes the document locally and the
  send button is hidden (`docs/dev/web-picker.md:218-240`).
- Write ops (`dom.click`, `dom.setValue`) are gated per origin and refuse targets
  inside the picker's own overlay (`docs/dev/web-picker.md:262-275`).

**Busy/idle visibility.** `targets.list` returns
`listTargetsWithDescriptions` (`broker-main.ts:498-508`): local socket files plus
best-effort `sessionName`/`cwd`/`status`/`description` (`targets.ts:57-73`). So the
page sees row A's status string. It sees nothing about Mesh nodes — the
`description` field is a *mesh actor description looked up per local target*
(`mesh-describer.ts`, via `targets.ts:76-96`), not a mesh node listing. A mesh
node without a local socket never appears in the picker.

**Failure modes (actual text/code).**

| Condition | Answer | Source |
|---|---|---|
| Missing prompt/picks/target.name | `error{invalid_payload}` `missing or invalid: …` | `broker-main.ts:352-356` |
| Malformed `record` | `error{invalid_payload}` `malformed record: expected {id, start, events:[{seq,t,kind}…]}` | `broker-main.ts:357-360` |
| Non-local namespace | `error{bad_target}` `namespace "<ns>" out of scope (v0: local only)` | `broker-main.ts:368` |
| Malformed picks | `error{invalid_payload}` `malformed picks: …` | `broker-main.ts:389` |
| Doc write fails | `error{delivery_failed}` `cannot write doc: …` | `broker-main.ts:394-397` |
| Target socket missing | `error{target_not_found}` `peer "<target>" not found` | `broker-main.ts:258-261` |
| Any other socket failure | `error{delivery_failed}` with the socket's own message | `broker-main.ts:264-266`, `broker-main.ts:425-435` |
| Frame before `hello` | `error{auth_failed}` `hello first` | `broker-main.ts:836-841` |
| Unknown frame type | `error{unsupported_version}` `unknown frame type <t>` | `broker-main.ts:846` |

---

## 5. Row D — broker page-tool (agent → page, the only synchronous channel)

**End-to-end path.**

1. Agent runs `node broker-main.ts page-tool <target> <op> [paramsJSON]`
   (`broker-main.ts:956-1045`), which reads `broker.json` for the port and
   `POST`s `{target, tool:{op, params?}, timeoutMs?}` to `/page-tool`
   (`broker-main.ts:1003-1024`).
2. `handlePageToolHttp` validates and calls `runPageTool` (`broker-main.ts:700-780`).
3. `routePageTool` picks the tab: the one that submitted the latest handoff for
   that target if it is still connected, else broadcast to every welcomed tab
   (`broker-main.ts:591-604`). It emits a `page.request{id, handoff_id, from, tool, timeoutMs}`
   frame and registers a pending entry with a timer (`broker-main.ts:606-638`).
4. The page runs one of the fixed ops (`wire.ts:32-44`: `page.info`, `dom.query`,
   `dom.html`, `console.logs`, `network.log`, `network.sse`,
   `framework.inspect`, `dom.click`, `dom.setValue`, `page.wait`) and answers
   `page.response{id, ok, text|error}`.
5. `handlePageResponse` correlates by id; **first response wins**, late or
   unknown responses are logged and dropped without any frame back
   (`broker-main.ts:670-687`).
6. The HTTP layer returns `{ok:true, result:<parsed JSON>}` or
   `{ok:true, text}` when the text is not JSON, else `{ok:false, error}` with HTTP
   200 (`broker-main.ts:760-775`); the CLI prints the JSON on stdout and exits 0,
   or prints the error on stderr and exits 1 (`broker-main.ts:1027-1036`).

**Confirmation semantics.** This is the only surface in the tree with a real
round trip: the caller blocks until the page answers or the deadline passes, and
the answer is the page's own payload. The ack is per-call and content-bearing.

**Persistence.** None on either side. `pendingPageRequests` is an in-memory map
pruned only when it exceeds 128 settled entries (`broker-main.ts:551-553`,
`broker-main.ts:572-582`). The page keeps console/network data in always-on ring
buffers (200 entries) and SSE content under a 1 MB budget
(`docs/dev/web-picker.md`, Record-mode section) — bounded, in-page, and lost on
reload. No result is written to disk anywhere.

**Capability ceiling.**

- Fixed op table, no free-form code and no eval (`wire.ts:26-45`).
- Bound to a live tab. `no_tabs` is returned immediately and **no request is
  created** (`broker-main.ts:592-596`, `broker-main.ts:655-658`).
- The target name in this channel is the *local* xfer name, not a mesh node —
  the broker only knows local tabs.
- `page.request` inbound (page→broker) is a protocol misuse and is silently
  logged (`broker-main.ts:780-783`).
- 1 MiB request cap → HTTP 413 `payload_too_large` (`broker-main.ts:713-720`).
- ADR 0007 forbids any replay path; the record exists to be *read by the agent*,
  not replayed.

**Busy/idle visibility.** None about the agent side. The broker knows the tab
count (`/status` returns `clients`, `broker-main.ts:850-855`) and per-target which
tab last submitted. Whether the page is foregrounded, throttled, or the user is
at the keyboard is invisible.

**Failure modes (actual text).**

| Condition | Text | Source |
|---|---|---|
| No welcomed tab | `no_tabs` | `broker-main.ts:594`, `broker-main.ts:657` |
| Deadline (default 30 s, `BROKER_PAGE_TIMEOUT_MS` or per-call) | `timeout` | `broker-main.ts:635`, `DEFAULT_PAGE_TIMEOUT_MS` `broker-main.ts:526` |
| Unknown/settled request id | `no_such_request` (in-process); the HTTP path logs and ignores | `broker-main.ts:646`, `broker-main.ts:672-677` |
| Broker not running | CLI: `broker not running in <dir> (no broker.json)`, exit 1 | `broker-main.ts:1011` |
| Broker unreachable | CLI: `broker unreachable on 127.0.0.1:<port> (…)`, exit 1 | `broker-main.ts:1023` |
| Body not JSON / bad fields | HTTP 400 `invalid_json`, `invalid_payload: …` | `broker-main.ts:723-755` |
| Oversize body | HTTP 413 `payload_too_large` | `broker-main.ts:714-719` |
| Page refused (write op without authorization) | the page answers `ok:false` with `denied_op: …` → `{ok:false, error:"denied_op: …"}` | `docs/dev/web-picker.md:262-275` |

Note the asymmetry: `timeout` says nothing about whether the page eventually ran
the op — a late `page.response` is discarded (`broker-main.ts:675-677`).

---

## 6. Row E — Adapter Daemon Inbox

**End-to-end path.**

1. `xfer-adapterd up` creates the same local Unix-socket listener the extension
   has, via the shared `createServer` (`adapterd.src/daemon.ts:188-190`), and
   writes peer metadata with `kind: "adapterd"`, `host`, `inbox` fields
   (`adapterd.src/daemon.ts:84-99`).
2. Incoming row-A frames go to `delivered(msg, "local")`; if `--mesh` was given,
   a `MeshNode` runs the same actor loop and its inbound goes to
   `delivered(msg, "mesh")` (`adapterd.src/daemon.ts:192-215`).
3. `delivered` reads the document from `msg.file`, appends **one JSONL record**
   to `<dir>/<encoded>.inbox.jsonl` and only then runs the optional
   `--on-handoff` command (`adapterd.src/daemon.ts:159-183`).
4. `appendInbox` is a single `fs.appendFileSync` (`adapterd.src/inbox.ts:30-33`);
   `takeInbox` renames the file aside and deletes it after parsing, so a
   concurrent append lands in a fresh file (`adapterd.src/inbox.ts:61-74`);
   `listInbox` peeks without consuming (`adapterd.src/inbox.ts:45-56`).
5. `--on-handoff` spawns the command with the record on stdin and
   `XFER_HANDOFF_ID` / `XFER_HANDOFF_FROM` / `XFER_HANDOFF_FILE` in the env
   (`adapterd.src/daemon.ts:114-146`). A spawn failure is logged and swallowed.
6. `--once` closes the daemon after the first delivered handoff
   (`adapterd.src/daemon.ts:177-181`).

**Confirmation semantics.** On the wire, **row A's ack is reused verbatim** — the
daemon's `createServer` writes the ack right after `deliver()` returns
(`server.ts:36-39`). So the sender's guarantee on rows A/B is, for an adapterd
receiver, "a JSONL line was appended to a file". `--on-handoff` success is
**not** in the ack: the spawn happens after the ack path is entered and its exit
code never reaches the sender. The CLI's `send` prints the msg id on success and
`❌ send to "<target>" failed: <msg>` on failure (`adapterd.src/main.ts:222-226`).

**Persistence.** This is the only surface with a receive-side store: a JSONL file
per daemon name, holding the **full document body** captured at receive time
(`adapterd.src/inbox.ts:11-25` — `document: string | null`). It is
take-to-read — a record is gone once `inbox take` consumes it, and ADR 0015
states there is no durable storage behind it. Who cleans: the consumer via
`take`, or the human via `--inbox <path>`. `gc.ts` does **not** touch
`.inbox.jsonl` (its skip list is only `broker.json`/`settings.json`,
`gc.ts:41`, and it only looks at `*.json` / `*.sock`, `gc.ts:126-133`) — so an
abandoned daemon leaves its Inbox behind indefinitely, with document bodies in
it.

**Capability ceiling.**

- `inbox take` is a one-shot snapshot, not a long poll: no `wait_secs`, no
  blocking read (`adapterd.src/main.ts:300-329`).
- No per-sender threading, no warm continuation, no restart resumption — the
  Inbox is a file, not a conversation.
- `inbox` with an explicit `--name` requires the daemon's socket to exist, else
  it errors rather than reporting an empty inbox (`adapterd.src/main.ts:315-319`).
- The `url` deliver strategy (HTTP POST) is deliberately not implemented and not
  reserved as a flag (`adapterd.src/daemon.ts:112-114`, ADR 0015).
- The daemon's metadata `status` is a hard-coded `"idle"`
  (`adapterd.src/daemon.ts:91`) — an adapterd peer never reports
  `thinking`/`tool:X`.

**Busy/idle visibility.** Same as row A (the metadata file), except that the
value is a constant `"idle"` and therefore uninformative. `meshOnline` is exposed
on the handle (`adapterd.src/daemon.ts:52`) and printed in the up banner
(`adapterd.src/main.ts:180`).

**Failure modes (actual text).**

| Condition | Text | Source |
|---|---|---|
| Local send, target missing | row A's `peer "<target>" not found` | `client.ts:17` via `adapterd.src/main.ts:224` |
| Inbox append fails | log: `[xfer-adapterd] inbox append failed for <id>: <err>`; the record is **not** retried and the ack still happens | `adapterd.src/daemon.ts:170-174` |
| `--on-handoff` spawn fails | log: `[xfer-adapterd] --on-handoff failed to spawn: <err>` | `adapterd.src/daemon.ts:130-132` |
| `--kind` missing | `❌ --kind must be "task" or "notification" — … a handoff that declares no kind reads as a notification and never comes back` | `adapterd.src/main.ts:208-210`, `adapterd.src/main.ts:270-272` |
| Mesh join fails during `up` | the daemon unwinds: listener closed, socket+metadata unlinked, then rethrows (`mesh up` errors as row B) | `adapterd.src/daemon.ts:201-215` |
| `--mesh` without config | `❌ --mesh requested but mesh is not configured — <err>` | `adapterd.src/main.ts:158` |
| `inbox` with no daemon | `no adapter daemon found in <dir> — start one with \`xfer-adapterd up\` or pass --name/--inbox` | `adapterd.src/main.ts:338` |
| `inbox --name` for a dead daemon | `no daemon "<name>" — start one with \`xfer-adapterd up --name <name>\`` | `adapterd.src/main.ts:317` |
| Two daemons, no `--name` | `multiple adapter daemons in <dir> — pass --name or --inbox` | `adapterd.src/main.ts:340` |

---

## 7. Row F — Board

**End-to-end path.** There is no message and no transport in the sense of §2–§6.
A Card is a Markdown file under `~/.pi/xfer/board/` (`board.ts:8`); an Entry is
an appended `### e-XXXX · type · author · timestamp` section (`board.ts:86-89`).
Writes are two-phase and human-commanded: `/xfer board write <id> <intent>`
records `pending` and injects a prompt (`commands.ts:558-570`), then the
`agent_end` hook parses a fenced `board-entry` block out of the assistant reply
and either creates the Card or appends the Entry (`board.ts:248-276`,
`board.ts:257-262`). `read` injects the Card verbatim
(`commands.ts:536-543`).

**Confirmation semantics.** The only "ack" is the human's notification:
`🆕 <id> — <title> (e-0001 appended)` or `📥 <e-id> · <type> appended to <card>`
(`board.ts:267-272`), or the abort warnings `⚠️ board write aborted — no reply
from the agent` / `— reply had no ```board-entry block; nothing written`
(`board.ts:254-262`). No other agent is involved, so there is no one to confirm
to. There is no formal confirmation step by design (CONTEXT.md, Conversation).

**Persistence.** The Card file is the storage. Lifetime is until the human runs
`del` or `clean` (`board.ts:202-213`); nothing in `gc.ts` touches the board
directory. Concurrent writers are uncoordinated: `append` reads the card, then
`writeFileSync`s the whole body back (`board.ts:238-243`) — two sessions
appending simultaneously can lose an Entry. No locking, no atomic rename.

**Capability ceiling.**

- No push. An agent learns of a Card only when a human injects it; ADR 0009
  forbids `pi.registerTool` for board operations, and ADR 0014 keeps the board
  machine-local (cross-machine sharing is a file-sync concern, not code).
- No addressing: a Card has an author per Entry but no recipient.
- Machine-local only; there is no actor, no queue, no engine involvement.
- Entry type is metadata only and drives no logic (`board.ts:82-85` parse,
  `board.ts:86-89` render).

**Busy/idle visibility.** None. Nothing observes another agent.

**Failure modes.** `card not found: <id>` when appending to a missing Card
(`board.ts:241`); `/xfer board read|write` with an unknown id notifies
`❌ Card not found: <id> — see /xfer board list`
(`commands.ts:534`, `commands.ts:551`). A `read` on a Card whose front matter
lacks `id` returns `null` silently (`board.ts:148`).

---

## 8. Cross-cutting observations (facts, not judgements)

1. **The status signal crosses only one transport.** `state.currentStatus` is
   written into `<name>.json` (`state.ts:38`) and read back by `targets.ts:26`
   for the picker; `XferInstanceState` has no status field
   (`mesh-engine.ts:17-24`), and adapterd hard-codes `"idle"`
   (`adapterd.src/daemon.ts:91`). This asymmetry was already recorded in
   `notes-reason-network-wake.md` §9; nothing in the transport matrix above is a
   correction to it — it is the same finding reached from the send side.
2. **`status: "sent"` is a constant on both tools**
   (`index.ts:151`, `index.ts:194`), independent of the ack that was actually
   received. Row B additionally carries a preflight verdict in `details.warning`
   (`index.ts:193`) that the constant does not reflect.
3. **Four different ack granularities coexist:**

   | Surface | What the ack means | Not covered |
   |---|---|---|
   | A | parsed and handed to `deliver()` | read by the model |
   | B | accepted into the target actor's queue (or `unknown`) | any receiving-side step |
   | C | row A's ack was received | read by the model |
   | D | the page ran the op and returned a payload | whether the op succeeded semantically |
   | E | a JSONL line was appended | `--on-handoff` exit status |
   | F | the human's command completed | whether any other agent ever reads it |

4. **Temp documents are written by three surfaces and cleaned by none.** Row A
   `index.ts:103`, row B `mesh.ts:308`, row C `broker-main.ts:363`. `gc.ts`
   covers only sockets and metadata (`gc.ts:1-24`). The adapterd Inbox
   (`adapterd.src/inbox.ts:29-32`) and `mesh.log` (`mesh-log.ts:98-110`) also
   have no reaper in the tree.
5. **A misroute is surfaced, not corrected.** Row B refuses delivery and injects
   a `⚠️` message into the *wrong* node's session (`mesh.ts:334-352`) while the
   sender has already seen a successful enqueue. Row C has no equivalent: a
   frame addressed to a target whose socket exists but whose listener is a
   different process is acked by whoever is behind the file.
6. **Only row D blocks.** Every other surface returns before the receiver has
   done anything with the content.

## 9. What this matrix did not establish

Left as open questions for a human node — deliberately not resolved here:

1. Whether `XferInstanceState.status` should exist at all (row B reports
   availability via the delivery verdict but no busy/idle), and which of the two
   local idle signals is authoritative — `state.isRuntimeIdle()`
   (`state.ts:73-76`) or the event-driven `currentStatus` (`index.ts:206-209`).
   Both already disagree in principle (a tool-gap can read `idle` by one and
   `tool:X` by the other).
2. Whether the temp-document leak (§8.4) matters, given no ADR mentions it. It
   is not covered by ADR 0013's or 0015's stated boundaries.
3. Whether `--on-handoff` exit status should ever reach the sender. Today the
   ack is written before the spawn result could exist
   (`adapterd.src/daemon.ts:159-183` vs `server.ts:36-39`), so this is a protocol
   question, not a bug fix.
4. Whether `latestTabIdByTarget` / `latestHandoffByTarget` need a bound: both are
   unbounded maps that survive only in memory (`broker-main.ts:530`,
   `broker-main.ts:543`), unlike `pendingPageRequests`, which is pruned at 128
   (`broker-main.ts:551-553`).
5. Whether the Board's lost-update window (`board.ts:238-243`) is acceptable
   under ADR 0009's "human orchestrates" premise — this matrix only records that
   no lock exists.

## 核对与存疑

- Every `file.ts:line` cited above was read directly in this walkthrough; line
  numbers are those of the current working tree on `main`, and several existing
  docs in this directory carry stale line references (see
  `notes-mesh-peer-identity.md`, "Verification notes"), so prefer re-reading over
  trusting these numbers after further commits.
- Not verified, and therefore not asserted: (a) whether a `getDescription` probe
  on a foreign `xfer-instance` actor is distinguishable from an offline target —
  the same gap already flagged in `notes-mesh-peer-identity.md`; (b) the exact
  userscript-side behaviour of the picker after a broker restart (read only from
  `docs/dev/web-picker.md:246-262`, not from `web-picker.src/`, which is out of
  scope per AGENTS.md); (c) whether `latestTabIdByTarget` can be poisoned by a
  tab that submits for a target it does not own — the map is keyed by
  `targetName` taken from the frame's `target.name` (`broker-main.ts:400-408`),
  and no ownership check exists between that and `xfer_dir` socket existence.
- Not exercised: no engine, broker, daemon, admin or pi session was started; no
  `NODE_TEST_CONTEXT` process ran; `XFER_ALLOW_REMOTE` was not set. Everything in
  §2–§7 is read from source and from the hermetic tests' fixtures, not from an
  observed run.
- Tension worth noting (recorded, not argued): ADR 0013 says the mesh document is
  a static snapshot with *no* Follow-up channel, but `handoff-doc.ts:122-135`
  renders that section unconditionally whenever `brokerCliPath` is supplied. The
  removal today lives in the mesh callers not supplying it — a caller-side
  convention rather than a renderer guarantee.
