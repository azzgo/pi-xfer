# Xfer — Language

## Mesh (opt-in cross-machine transport)

**Mesh**:
The opt-in cross-machine transport where an agent instance joins a shared actor network to discover and message remote peers. Joining is per-instance and manual; local Unix-socket delivery is unaffected and remains the default path.
_Avoid_: network, cluster, swarm, overlay

**Node**:
One actor on the Mesh engine — one name, one outbound engine connection, one independent participant. The unit of joining, addressing, and liveness; host-agnostic (a pi instance and an Adapter Daemon join the same way).
_Avoid_: peer (reserved for local socket discovery), bridge, worker, session

**Runner / pool**:
A live process on a machine that can host a Node's actor, and the named group of them on the engine (`runner_name_selector`; an absent name is the engine's `default` pool). A Node's actor only ever runs inside a runner from its own pool — a Node whose pool has none is on the engine but cannot receive anything.
_Avoid_: worker, envoy (the engine's own word for it — keep it in engine-facing code only), host

**Delivery verdict**:
What a listing says about one Node's ability to receive a Handoff, derived from the actor record joined with the runners in its pool. Always about a Node, never about one Handoff — that other axis is the **Handoff outcome**. Distinct from **actor status** (`Running` / `Sleeping` / `Idle` / `Crashed` / `Pending`), which is what the engine says about the actor alone: the record can read `no_envoys` while its pool has a live runner, so a verdict is never a status.
_Avoid_: health, presence (presence belongs to local peers), online/offline, outcome


## Adapter Daemon (non-pi Agent Hosts)

**Agent Host**:
The kind of host software an agent runs in (pi / Cursor / grok bot / …). It determines the install artifacts and how handoffs are delivered, not the agent's online identity.
_Avoid_: client, IDE, runtime, harness (too broad)

**Adapter Daemon**:
The bundle process that adapts a non-pi Agent Host to the xfer network — it owns a Node's local socket and Inbox and speaks the same wire protocol as the extension, so hosts are peers on equal footing.
_Avoid_: bridge, proxy, gateway, connector

**Inbox**:
A Node's JSONL receive file with take-to-read semantics: `inbox take` atomically reads and deletes the consumed records. There is no durable storage behind it.
_Avoid_: mailbox, queue (implies persistence and dispatch), log

**Install**:
Fixing a skill into a target directory for one Agent Host, producing the host config and a recommended launch command so the host never constructs adapter flags itself.
_Avoid_: deploy, setup, onboarding
Glossary for the xfer extension. Implementation details live in `docs/`; this file only fixes terms.

## Example (copyable scaffold)

**Scaffold**:
A directory under `examples/` meant to be copied and adapted, never depended on: it imports nothing from the extension itself and is never published to npm. Its contract is "it runs as written once you edit the named places", so every file states exactly one job, and a fact a copier must change is named at the place that carries it. A guarantee that only exists inside this repository — a conformance test against the extension, say — lives outside the Scaffold, never inside a shipped file.
_Avoid_: template, starter, sample, demo, reference implementation, example (too loose — an example is any illustration; a Scaffold is meant to be taken)

## Board (async cross-agent collaboration)

**Board**:
The cross-project, machine-local collaboration space (`~/.pi/xfer/board/`). Holds Cards; agents join and leave freely — the human orchestrates who reads and writes, so no agent needs to stay online.
_Avoid_: task queue, message bus, ticket system (the Board is for discussion and analysis, not dispatch)

**Card**:
One async topic of collaboration. A Markdown file whose header carries id/title/created_by and whose body is the Conversation. Stateles by design — a shared document, not a ticket: no lifecycle statuses, cleanup happens only when the human explicitly runs del / clean.
_Avoid_: topic, ticket, issue, workflow state

**Entry**:
One append-only contribution on a Card. Free-form Markdown text with author and an optional type label (note / finding / question / answer); the label is metadata only and drives no logic.
_Avoid_: comment, post, message

**Conversation**:
The ordered sequence of Entries in a Card body. The Card states the topic; Entries are the discussion; there is no formal confirmation step — the conversation just ends when the human cleans the Card up.
_Avoid_: thread, log

## Web Picker


## Admin (local web console)

**Admin**:
The local, globally-singleton web console (`/xfer admin`) for observing and lightly controlling xfer on its machine: live event stream, local and mesh presence, board list/view, and control buttons (gc, broker start/stop). Binds localhost only; write operations on board content are delegated to the system (open folder / open in editor), never handled in-page. Distinct from the Broker, which serves the web picker, not the human.
_Avoid_: dashboard (implies observe-only), panel, UI
## Language

**Marker**:
The common shape of everything the picker hands to the agent: a lightweight pointer at something on the page (an element, an action) plus human-written or captured context. The agent is *pulled into understanding* by markers, not by dumps.
_Avoid_: annotation dump, full DOM snapshot, payload

**Pick**:
A static marker — "look at this element". A selected element with selector/tag/text and an optional note, optionally aggregated into a `group`.
_Avoid_: selection, highlight, annotation (too vague next to the handoff document)

**Record**:
A temporal marker sequence — "this is what I did and what happened". One user-operated capture span (start → stop) holding ordered events with time offsets plus the console/network scene data sliced over the same window. The record object is itself the sequence; it rides a submit the way picks do, as the temporal analogue of a pick's `group`.
_Avoid_: replay, recording session, log (it is a bounded, hand-curated capture, not a log stream)

**Scene Data**:
The always-on ring-buffer captures (console entries, network requests) sliced to a Record's time window and attached to it. Not new collection — a view over existing capture.
_Avoid_: telemetry, logs, tracing output

**Handoff**:
The document one node delivers to a target node. Carries a Kind, and the reverse message is itself a Handoff — never a "reply" or "receipt". In a web-picker submit, Picks and Records are its sections; both are markers at different axes (space vs time). A Handoff carries a message, not memory — state that must survive a session belongs to the Board.
_Avoid_: prompt, message, report, reply, receipt, acknowledgement

**Handoff outcome**:
Where one Handoff came to rest, as far as the network can honestly tell — the sender's side of that one send. Never whether it was read: a Handoff that reached a session was handed to a run, not consumed.
_Avoid_: receipt, acknowledgement, verdict (that is the Node axis), status

**Notification**:
A Handoff Kind that informs without asking for output. Silent by default: a receiver sends a reverse Handoff only when it lacks information, or when the document conflicts with fact.
_Avoid_: FYI, broadcast (handoffs are point-to-point by name)

**Task**:
A Handoff Kind that asks for output. A receiver always sends a reverse Handoff once it has a conclusion — done, blocked, or needing input.
_Avoid_: request, job, ticket (implies lifecycle)
