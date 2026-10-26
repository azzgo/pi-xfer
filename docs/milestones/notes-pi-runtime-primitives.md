# Pi runtime primitives for agent-to-agent messaging, session injection and scheduling — research input (pi 1.3.0 extension API surface)
[简体中文](notes-pi-runtime-primitives.zh.md)

Provenance: read-only survey of the installed pi release, requested as background material for
pi-xfer design. No code was changed; no deployment was contacted; `XFER_ALLOW_REMOTE` was not set.
Sources: `~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/`
(docs in `docs/*.md`, declarations in `dist/core/extensions/types.d.ts`, implementation in
`dist/core/agent-session.js`) and the repo tree (`index.ts`, `controller.ts`, `commands.ts`,
`board.ts`, `state.ts`, plus `docs/adr/`). Every claim below carries a source; where the claim is
my inference from reading implementation rather than something the docs state, it is marked
**[inferred]**.

Terminology follows `CONTEXT.md` (Handoff, Kind, Node, Board, Card, Entry, Inbox, Adapter Daemon).

## 0. Scope note: what "pi" means here

The installed release is 1.3.0; the repo's `node_modules` resolves 1.1.0. Both agree on every
signature cited below (spot-checked `sendUserMessage` at `dist/core/extensions/types.d.ts:1243`
in 1.1.0 vs `:1267` in 1.3.0 — same parameter list). Line numbers are 1.3.0 unless noted.

pi exposes three integration planes, and they are *not* interchangeable:

| Plane | Boundary | Control model | Source |
|---|---|---|---|
| Extension API (`pi.*`) | in-process | TypeScript methods + `pi.on()` events | `docs/extensions.md:3` |
| SDK (`createAgentSession()`) | in-process | direct `AgentSession` methods | `docs/sdk.md:5-7` |
| RPC mode (`pi --mode rpc`) | child process | JSONL on stdin/stdout | `docs/rpc.md:3-9` |

The extension API is the plane pi-xfer occupies. An extension "runs inside the Pi process with the
same operating-system permissions" (`docs/extensions.md:5`). Everything in §1–§4 is
extension-plane unless stated.

## 1. Injection primitives

### 1.1 Signatures

```
// dist/core/extensions/types.d.ts:1258-1262
sendMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
): void

// dist/core/extensions/types.d.ts:1267-1271   (docstring at 1264-1266)
sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }
): void
```

Both are fire-and-forget (`void`) on `ExtensionAPI`. The `ReplacedSessionContext` variant
(`types.d.ts:329-337`) returns `Promise<void>` for the same two methods, and is only obtainable
inside a `withSession` callback.

Semantics per the declarations and implementation:

- **`sendMessage`** appends a `custom_message` entry — "custom content stored and sent to the
  model" (`docs/extensions.md:219-220` table). It is content with a `customType`, not a user turn.
- **`sendUserMessage`** — "Send a user message to the agent. **Always triggers a turn.** When the
  agent is streaming, use deliverAs to specify how to queue the message."
  (`types.d.ts:1264-1266`). `expandPromptTemplates` "Set … to dispatch extension commands and
  expand skill commands and prompt templates" — default false
  (`dist/core/agent-session.js:1893` javadoc).

### 1.2 The four-case dispatch of `sendCustomMessage`

This is the load-bearing table. Source: `dist/core/agent-session.js:1801-1815` (javadoc) and the
branch order at `:1816-1859`.

| `isStreaming` | `triggerTurn` | `deliverAs` | Result |
|---|---|---|---|
| false | falsy | any | appended to state/session immediately, no turn |
| false | `true` | any **except `"nextTurn"`** | appended, **starts a new run** |
| false | `true` | `"nextTurn"` | pushed to `_pendingNextTurnMessages`, never starts a run from this path |
| true | `!== false` | `"steer"` (default) | `agent.steer(msg)` — queue |
| true | `!== false` | `"followUp"` | `agent.followUp(msg)` — queue |
| true | `false` | any | pushed to `_pendingCustomMessages`, flushed at end of the current turn, **no new turn** |

Notes with consequences:

- **Branch order matters.** The `deliverAs === "nextTurn"` check is first and is unconditional on
  streaming state (`agent-session.js:1824-1826`), so `nextTurn` never reaches the `triggerTurn`
  branch. `nextTurn` is the only delivery mode with no counterpart in `sendUserMessage`.
- **`triggerTurn: false` while streaming defers, it does not drop.** The code comment explains why
  appending immediately is refused: it "would put the message between an assistant tool call and
  its result, which providers that validate message order reject on replay. Defer to the end of the
  turn." (`agent-session.js:1836-1841`). Deferred messages are flushed by
  `_flushPendingCustomMessages()` (`:1878-1888`).
- **`triggerTurn: true` while `agent_settled` is being emitted re-queues itself.**
  `_isEmittingAgentSettled` causes the call to be pushed to `_deferredSettledActions` and re-run
  later (`:1833-1837`). **[inferred]** Relevant to any design that injects from an
  `agent_before_settle` handler.
- Under delivery the default mode is steer: if streaming and `deliverAs` is omitted, the `else`
  branch calls `agent.steer` (`:1830-1834`).

### 1.3 `steer` vs `followUp` — exact difference

| | steering | follow-up |
|---|---|---|
| Docs, one line | "Steering messages enter after the current assistant turn." | "Follow-up messages enter after the agent has finished its pending work." (`docs/how-pi-works.md:13`) |
| Agent-loop hook | `getSteeringMessages` — "Called after the current assistant turn finishes executing its tool calls, unless `finishTurn` ends the run. If messages are returned, they are added to the context **before the next LLM call**. Tool calls from the current assistant message are not skipped." (`pi-agent-core/dist/types.d.ts:239-247`) | `getFollowUpMessages` — "Called when the agent has **no more tool calls and no steering messages**." (`:248-256`) |
| RPC phrasing | "delivered after the current assistant turn finishes executing its tool calls, before the next LLM call" (`docs/rpc-commands.md:26`) | "Wait until the agent finishes. Message is delivered only when agent stops." (`docs/rpc-commands.md:27`) |
| Drain policy | `steeringMode`: `"all"` or `"one-at-a-time"` (default) (`docs/rpc-commands.md:340-341`) | `followUpMode` (`docs/rpc-commands.md:348`) |

So: **steer = mid-run, one turn boundary away; followUp = after the run would otherwise stop.**
Neither is "immediate" — there is no primitive that inserts a message inside an in-flight assistant
message or between a tool call and its result.

Drain modes are settings, not per-call, and an extension cannot set them:
`pi.setSteeringMode` / `pi.setFollowUpMode` do not appear in the `ExtensionAPI` surface
(`types.d.ts:1190-1406`); the modes live on `AgentSession` (`dist/core/agent-session.js`
`setSteeringMode`) and on the RPC surface (`docs/rpc-commands.md:331-365`). **[inferred]** An
extension that needs `"all"` cannot get it.

### 1.4 Injection timing: mid-turn vs end-of-turn

- Run lifecycle: "A run proceeds from input and `before_agent_start`, through model, message, and
  tool events, to `agent_end`." (`docs/extensions.md:62`)
- "Pi counts as busy while a run starts, including the compaction check and `before_agent_start`,
  so messages sent meanwhile go into the starting run." (`docs/extensions.md:63`) — i.e. an
  injection that races the start of a run is absorbed by that run rather than rejected.
- `agent_end` is *not* the end: "Automatic retries, recovery, compaction, or queued work can
  continue afterward." (`docs/extensions.md:64`) The final boundary is `agent_settled`
  (`docs/extensions.md:66`, `docs/json.md:48`).
- `turn_end` and `agent_before_settle` are the two "actionable boundaries" whose handlers may
  append `custom`, `custom_message`, `context_edit`, or `compaction` entries and return
  `continue: true` for exactly one further model request (`docs/extensions.md:154`).

### 1.5 Content transformation primitives (not injection, but adjacent)

`context` transforms the conversation without owning prompt/tool system messages; Pi restores its
state afterwards (`docs/extensions.md:150`, `types.d.ts:679-694`). `context_with_system` lets a
handler own the *complete* transcript, including system messages (`types.d.ts:688-692`).
`message_end` "can replace a finalized message while preserving its role"
(`docs/extensions.md:146`). These change what the model sees without adding a queue entry.

## 2. State and scheduling primitives

### 2.1 Idle / busy

```
// ExtensionContext, types.d.ts:213-253
isIdle(): boolean
signal: AbortSignal | undefined      // "or undefined when the agent is not streaming" (:239)
abort(): void                        // "Abort the current agent operation" (:241)
hasPendingMessages(): boolean        // "Whether there are queued messages waiting" (:243)
```

Implementation of idle:

```
// dist/core/agent-session.js:1056-1059
/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
get isIdle() { return !this._isAgentRunActive && !this.isCompacting; }
```

Two observations that matter:

- `isIdle` does **not** consult the pending-message count, even though its own comment mentions
  queued continuation. Queue state is a separate predicate, `hasPendingMessages()`
  (`= pendingMessageCount > 0`, wired at `agent-session.js:2787-2793`).
- `_isAgentRunActive` is a plain boolean set at run entry and cleared in a `finally`
  (`agent-session.js:1393,1400`), so it is accurate between events but says nothing about
  *scheduled* work (a retry sleep, a deferred `_deferredSettledActions` entry).
- `ctx.signal` is undefined outside a turn. "Use `ctx.signal` for nested work owned by an active
  turn; commands and idle session events often have no operation signal."
  (`docs/extensions.md:158`)

### 2.2 Abort, queue control, shutdown

- `ctx.abort()` — extension-visible, but routed through an injected `_extensionAbortHandler` when
  the host installed one (`agent-session.js:2789-2792`). **[inferred]** In the CLI the handler and
  `session.abort()` converge, but the indirection means an embedder can substitute behaviour.
- `SessionManager.abort()` "stops the active operation and waits for the session to become idle";
  `waitForIdle()` "waits without aborting it" (`docs/sdk.md:78-79`). At the extension plane,
  `waitForIdle()` exists **only** on `ExtensionCommandContext` (`types.d.ts:289`), not on plain
  `ExtensionContext`.
- Clearing queues: `clearQueue()` exists on `AgentSession` and as the RPC `clear_queue` command
  (`docs/rpc-commands.md:107-128`), but has **no extension API counterpart** — the extension
  surface exposes only `hasPendingMessages()` (a read). **[inferred]** An extension can enqueue and
  observe, but cannot dequeue.
- `ctx.shutdown()` — "Gracefully shutdown pi and exit. Available in all contexts."
  (`types.d.ts:245-246`).

### 2.3 Sessions: new / fork / switch / tree

All of these are **command-only**, on `ExtensionCommandContext` (`types.d.ts:286-327`):

| Method | Signature core | Source |
|---|---|---|
| `newSession` | `(opts?: { parentSession?, setup?, withSession? }) => Promise<{cancelled: boolean}>` | `types.d.ts:290-299` |
| `fork` | `(entryId, opts?: { position?: "before"\|"at", withSession? }) => Promise<{cancelled}>` | `types.d.ts:301-307` |
| `navigateTree` | `(targetId, opts?: { summarize?, customInstructions?, replaceInstructions?, label? })` | `types.d.ts:309-318` |
| `switchSession` | `(sessionPath, opts?: { withSession? })` | `types.d.ts:321-325` |
| `reload` | `() => Promise<void>` — reloads extensions, skills, prompts, themes, context files | `types.d.ts:327` |

Why they are command-only: "These operations are command-only because calling them from lifecycle
handlers can deadlock the runtime." (`docs/extensions.md:207`) And: "Session replacement invalidates
the old context. Capture only plain data before switching, then use the fresh context supplied to
`withSession`" (`docs/extensions.md:209`).

What replacement actually does, mechanically (`dist/core/agent-session-runtime.js:136-172`):
`teardownCurrent(reason, …)` runs, then a whole new runtime is created with
`sessionStartEvent: { type: "session_start", reason: "new" | "resume" | "fork", previousSessionFile }`.
So a session switch tears the extension runtime down and re-emits `session_shutdown` then
`session_start` — observable to a plain `pi.on` handler. Reasons enumerated at
`types.d.ts:578` (`"startup" | "reload" | "new" | "resume" | "fork"`) and `types.d.ts:641`
(shutdown: `"quit" | "reload" | "new" | "resume" | "fork"`).

### 2.4 Sub-agents / concurrent agents: not a pi concept

There is **no** sub-agent, worker, or parallel-agent primitive in the extension API. The only
proximity in the vocabulary is:

- parallel *tool calls* within one assistant message: "Tool calls from one assistant message can run
  in parallel." (`docs/extensions.md:156`) — concurrency of tool execution, not of agents.
- `ctx.executeTool(name, args, …)` runs another tool "through the same validation, hooks, and
  permission checks as model-issued calls", with nested `toolCallId` `<parent id>/<n>`
  (`types.d.ts:269-285`, `docs/extensions.md:139-143`). Nested calls "do not add transcript
  entries". This is tool composition, not a subordinate agent.
- A grep of `docs/*.md` for `sub-agent|subagent|sub agent|concurrent agent|parallel agent` returns
  nothing.

**[inferred]** Multi-agent topologies must therefore be built *outside* pi (separate pi processes,
each with its own session), which is exactly what pi-xfer's socket/mesh layer does.

### 2.5 Queues

The only queues pi owns are the per-session `steeringQueue` / `followUpQueue`
(`pi-agent-core/dist/agent.d.ts:39-40`) plus the two internal pending lists
(`_pendingCustomMessages`, `_pendingNextTurnMessages`, `agent-session.js:1821-1845`). There is no
general-purpose work queue, scheduler, timer, or cron primitive. Single-session scope: one
`AgentSession` "owns one conversation, its model and tools, queued messages, compaction state, and
extension runtime" (`docs/sdk.md:29`).

There is also `pi.events` — an `EventBus` (`emit(channel, data)` / `on(channel, handler) =>
unsubscribe`, `dist/core/event-bus.d.ts:1-4`), described as a "Shared event bus for extension
communication" (`types.d.ts:1405-1406`). **[inferred]** It is an in-process object created per
runtime; it cannot cross a process boundary. The bundled example uses it purely for same-process
extension-to-extension chatter (`examples/extensions/event-bus.ts`).

## 3. The event surface

`pi.on()` returns an unsubscribe function; handlers run in extension load and registration order;
"changes do not affect a dispatch already in progress" (`docs/extensions.md:132`). Full list from
`types.d.ts:1190-1206`:

| Event | Payload (load-bearing fields) | Useful for |
|---|---|---|
| `session_start` | `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`, `previousSessionFile?` | bind per-session resources |
| `session_info_changed` | `name?: string` | rename tracking |
| `session_before_switch` / `session_before_fork` | `reason`, `targetSessionFile`, `entryId`, `position` | cancellable |
| `session_before_compact` | `preparation`, `branchEntries`, `reason: "manual"\|"threshold"\|"overflow"`, `willRetry`, `signal` | cancellable / custom compaction |
| `session_compact` / `session_compact_failed` | `compactionEntry`, `reason`, `aborted`, `willRetry`, `fromExtension` | |
| `session_shutdown` | `reason: "quit"\|"reload"\|"new"\|"resume"\|"fork"`, `targetSessionFile?` | clean up |
| `session_before_tree` / `session_tree` | `preparation`, `newLeafId`, `oldLeafId`, `summaryEntry?` | |
| `mcp_servers_change`, `resources_discover`, `project_trust` | see `types.d.ts:535-574` | |
| `context` / `context_with_system` | `messages` | transform what the model sees |
| `cache_warming_decision` | — | `{action:"warm"\|"stop"}` |
| `before_provider_request` | `payload` | replace payload |
| `before_provider_headers` | `headers` (mutable) | |
| `after_provider_response` | `status`, `headers` | |
| `provider_stream_event` | `provider`, `api`, `model`, `data` | read-only, not persisted |
| `before_agent_start` | `systemPrompt`, `systemPromptOptions`, plus `messageType: "user"` with `prompt`/`images` **or** `messageType: "custom"` with `message` | run-start discrimination |
| `agent_start` / `agent_end` | `agent_end.messages: AgentMessage[]` | busy/idle edges |
| `agent_before_settle` | `entries`, `continue`, `context: {contextEntries, contextMessages, llmMessages, pendingMessages, canContinue}`, `outcome` | last actionable boundary |
| **`agent_settled`** | `aborted: boolean` | **"Pi will not continue automatically"** |
| `ui_prompt_start` / `ui_prompt_end` | `kind: "select"\|"confirm"\|"input"\|"editor"\|"custom"`, `title?` | Pi is blocked on the human |
| `turn_start` / `turn_end` | `turnIndex`, `timestamp` / `message`, `toolResults`, `messageEntryId`, `toolResultEntryIds` | |
| `message_start` / `message_update` / `message_end` | `message`, `assistantMessageEvent` | |
| `tool_execution_start` / `_update` / `_end` | `toolCallId`, `toolName`, `args`, `parentToolCallId?` / `result`, `isError`, `durationMs?` | what the agent is doing |
| `model_select` / `thinking_level_select` | `model`, `previousModel`, `source: "set"\|"cycle"\|"restore"` | |
| `tool_call` / `tool_result` | typed per built-in, `toolCallId`, `parentToolCallId?` | mutate / block / compose |
| `user_bash` | `command`, `excludeFromContext`, `cwd` | |
| `input` | `text`, `images`, `source: "interactive"\|"rpc"\|"extension"`, `streamingBehavior?: "steer"\|"followUp"` | |

### 3.1 Which signals reliably answer "busy / idle"

| Signal | What it actually tells you | Source |
|---|---|---|
| `ctx.isIdle()` | no active run **and** not compacting | `agent-session.js:1057-1059` |
| `ctx.hasPendingMessages()` | steering+followUp queue non-empty | `agent-session.js:2793` |
| `agent_start` fired, `agent_settled` not yet | a run is active or automatically continuing | `docs/json.md:48,56` |
| `agent_end` | one low-level run ended — **retries/compaction/queue can still follow** | `docs/extensions.md:64` |
| `agent_settled` | no automatic continuation will happen | `docs/extensions.md:66` |
| `ui_prompt_start` / `_end` | the human is being asked something (a distinct kind of "busy") | `types.d.ts:808-820` |

The trap the docs are explicit about is treating `agent_end` as "idle". pi-xfer currently does
exactly that (see §4.1).

### 3.2 Is there a todo / plan signal?

**No.** There is no todo, plan, or task-list event, field, or context method anywhere in the
extension API. The only "todo" in the release is a *sample extension that implements one itself*:
`examples/extensions/todo.ts` "Registers a `todo` tool for the LLM to manage todos" and rebuilds its
state by scanning `toolResult` messages with `toolName === "todo"`
(`examples/extensions/todo.ts:5-6,121`); `docs/extensions.md:151` lists it as an example, not a
feature. **[inferred]** "What the agent intends to do next" is only recoverable by reading the
transcript: `agent_end.messages`, `ctx.sessionManager.getBranch()`, or the assistant's tool-call
names via `tool_execution_start` / `tool_call`. There is no structured plan object.

## 4. What pi-xfer uses, and what it does not

### 4.1 Used today

| Primitive | Where | Why it is used / what depends on it |
|---|---|---|
| `pi.registerFlag("xfer", …)` | `index.ts:26-30` | `--xfer` name override |
| `pi.on("session_start")` | `index.ts:44-46` → `controller.start()` | binds the Unix socket, derives the identity name, starts metadata polling (`controller.ts:86-118`) |
| `pi.on("before_agent_start")` | `index.ts:66-68` → `syncXferToolAvailability()` | re-evaluates peer liveness each turn |
| `pi.registerCommand("xfer")` | `commands.ts:81` | the whole command surface |
| `pi.registerTool("xfer_to")` / `("xfer_mesh_to")` | `index.ts:73`, `:157` | outbound Handoff send |
| `pi.sendMessage` + `deliverAs` | `controller.ts:64-70` | inbound delivery, with the only steer/followUp fork in the repo |
| `pi.sendUserMessage` | `commands.ts:452, 514, 537, 559, 670` | command → agent prompt (Handoff Request, board new/read/write) |
| `ctx.isIdle()` | `state.ts:74-76`, read at `controller.ts:32` | picks `followUp`+`triggerTurn` vs `steer` |
| `ctx.ui.notify` / `ctx.ui.setStatus` / `ctx.ui.confirm` | throughout | human-facing feedback |
| `ctx.model` | `controller.ts:102` | recorded in metadata |
| `ctx.sessionManager.getSessionName()` | `state.ts:20-26` | metadata |
| `pi.getActiveTools()` | `index.ts:61` | read inside `syncXferToolAvailability` |
| `pi.on("agent_start"/"tool_execution_start"/"tool_execution_end"/"agent_end"/"model_select")` | `index.ts:206-214` | the local status string published to peers (`thinking` / `tool:<name>` / `idle`) |
| `pi.on("agent_end")` | `board.ts:248-…` | two-phase Board write: parse the `board-entry` block out of `event.messages` |
| `pi.on("session_shutdown")` | `index.ts:216-219` | mesh down + socket/metadata cleanup |
| `toolResult` `details` as the guidance carrier | `xfer_to` / `xfer_mesh_to` return values | tool-result shape per `docs/extensions.md:127-129` |

The inbound fork is the one piece of genuine steering policy in the repo:

```
// controller.ts:32, 64-70
const isIdle = state.isRuntimeIdle();
pi.sendMessage({ customType: "xfer-inbound", content, display: true },
  isIdle ? { deliverAs: "followUp", triggerTurn: true }
         : { deliverAs: "steer" });
```

Reading it against §1.2: when idle, `followUp` + `triggerTurn: true` takes the "not streaming +
triggerTurn" branch and starts a run; the `followUp` label is inert there. When streaming, it takes
the steer branch. **[inferred]** So the pair is effectively "start a run if idle, else steer",
which is what the code intends; the `deliverAs: "followUp"` in the idle arm has no observable
effect *in this release* and would only matter if the idle check went stale between the read and
the call.

### 4.2 Not used — enumerated

| Primitive | Status | Reason trail |
|---|---|---|
| `pi.sendMessage` `deliverAs: "nextTurn"` | unused | no comment anywhere in the tree mentions it; nothing needs "hold until the next turn boundary" |
| `triggerTurn: false` (deferred append while streaming) | unused | xfer always wants the message to influence work |
| `pi.appendEntry` | unused | no durable non-context extension state to keep; identity lives in the `<name>.json` file and status in memory (`state.ts:10-18`) |
| `agent_settled` | **unused** | status is set to `idle` on `agent_end` (`index.ts:209`) — this is the divergence from §3.1, and `AGENTS.md` / `docs/adr` carry no note about it |
| `agent_before_settle` | unused | no continuation semantics wanted |
| `turn_start` / `turn_end` | unused | per-turn granularity never needed |
| `message_start` / `_update` / `_end` | unused | the status string uses agent+tool events instead |
| `input` | unused | xfer does not rewrite what the human types |
| `user_bash` | unused | |
| `tool_call` / `tool_result` handlers | unused | `xfer_to` is a plain tool; no confirm/redact step. `board.ts` reads `agent_end.messages` rather than `tool_result` |
| `context` / `context_with_system` | unused | ADR 0009 chose prompt injection over context rewriting for Board content (`docs/adr/0009-xfer-board-command-driven.md:42-47`) |
| `before_provider_request` / `_headers` / `after_provider_response` / `provider_stream_event` | unused | |
| `session_before_compact` / `session_compact*` | unused | compaction is off-topic for xfer |
| `session_info_changed` | unused — **gap** | rename is tracked by `getSessionName()` at write time (`state.ts:20-26`) + `METADATA_POLL_MS` polling, not by the event |
| `session_before_switch` / `session_before_fork` / `session_tree` | unused | |
| `ui_prompt_start` / `_end` | unused | the closest thing to "the human is present" and it is not consulted |
| `ctx.hasPendingMessages()` | unused | `controller.ts:32` asks only `isIdle` — so a queued-but-not-yet-running turn reads as idle |
| `ctx.abort()` | unused | xfer never cancels a run |
| `ctx.signal` | unused | tools ignore the injected signal (they take `_signal`/`signal` and do not forward it) |
| `ctx.shutdown()` | unused | |
| `ctx.getContextUsage()` / `ctx.compact()` | unused | |
| `ctx.getSystemPrompt()` / `getSystemPromptOptions()` | unused | system prompt untouched |
| `before_agent_start` prompt surgery (`systemPromptOptions`, `systemPrompt`, `forceSystemPrompt`) | unused | returns nothing; only the tool-availability recompute. `docs/extensions.md:144` points at the supported route ("Prefer changing prompt sections, selected tools, or guidelines") |
| `before_agent_start.messageType` | unused | `messageType` would distinguish a Board/HH injection run from a human turn; never read |
| `pi.setActiveTools` | unused — **the bug shape** | `syncXferToolAvailability()` reads `pi.getActiveTools()` into a local `active` and returns (`index.ts:57-63`); nothing calls `setActiveTools`, so the "keep the tool description out of the prompt when no peer exists" intent in the comment at `index.ts:48-52` is not implemented. Note this interacts with `commands.ts:452` etc., which call `sendUserMessage` expecting the agent to use `xfer_to` — if availability gating were implemented as written, a `/xfer <target>` with no live peer would prompt the agent to call a non-declared tool |
| `pi.getAllTools` / `getSettings` / `getCommands` | unused | |
| `pi.setSessionName` / `getSessionName` / `setLabel` | unused (read indirectly) | `getSessionName` is read via `ctx.sessionManager`, not `pi` |
| `pi.exec` | unused | |
| `pi.registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer` / `registerToolRenderer` | unused | `customType: "xfer-inbound"` therefore renders with the default custom-message renderer. That is the exact hook `docs/extensions.md:225` names for "when custom stored content should appear in the transcript" |
| `pi.registerShortcut` | unused | `/xfer` covers it |
| `pi.events` (event bus) | unused | in-process only; every consumer xfer serves is out-of-process (another pi, `admin.cjs`, the broker, the userscript). The `examples/extensions/handoff.ts` example is the precedent for what `pi.events`*is* for |
| `ctx.newSession` / `fork` / `navigateTree` / `switchSession` / `reload` | unused | `examples/extensions/handoff.ts` shows the intended use: generate a prompt, `ctx.newSession({parentSession, withSession})`. pi-xfer's Handoff deliberately lands in *another agent's* session, not a new session of its own — see the CONTEXT.md Handoff definition ("A Handoff carries a message, not memory") |
| `outputSchema` / `structuredContent` | **used** for both tools | `index.ts:96-101, 170-175` |
| `annotations` | used | `index.ts:80-82` |
| `exposure` / namespaces / `reachesTools` / `prepareLoadout` | unused | both tools are `direct` by default |
| `ctx.executeTool` | unused | |

Reasons that come from a crate doc, not from my reading:

- **Board scope is command-driven by decision, not by omission.** ADR 0009 states "All board
  operations live under `/xfer board …`. No `pi.registerTool`. Agents never touch the board
  unprompted; the human orchestrates", and the two-phase write is "prompt injection + `agent_end`
  interception" (`docs/adr/0009-xfer-board-command-driven.md:38-47`). Its Consequences section even
  anticipates a later `registerTool` switch. So `sendUserMessage` + `agent_end` in `commands.ts` /
  `board.ts` is the decided shape.
- **The Inbox is take-to-read by decision.** `docs/adr/0015-adapter-daemon.md:31-36` — "There is no
  durable storage design behind the Inbox"; the Adapter Daemon gives a non-pi Agent Host an Inbox
  plus an optional `--on-handoff <cmd>` stdin strategy instead of any pi-plane injection, because a
  non-pi host has no `pi.sendMessage`. That is the structural reason pi-xfer needs its own wire
  format at all.

## 5. Hard limits on the pi side

These are the constraints that make whole classes of design impossible, as opposed to merely
unimplemented.

1. **Injection does not cross a process.** `pi.sendMessage` / `pi.sendUserMessage` are methods on an
   in-process `ExtensionAPI`. `pi.events` is an in-process `EventBus`
   (`dist/core/event-bus.d.ts:1-8`). Nothing in the extension API addresses another pi process.
   The only cross-process planes are the Unix socket pi-xfer already built, and RPC mode
   (`docs/rpc.md:3-9`), which requires the *target* be a `pi --mode rpc` child — a launch-mode
   change for the peer, not something an extension can assume.
2. **Injection does not cross a session.** A message lands in the session of the extension runtime
   that sent it. Reaching a different session means the command-only `switchSession` /
   `newSession` / `fork` (`types.d.ts:286-327`), which *replaces* the active session and invalidates
   the old context (`docs/extensions.md:209`) — i.e. it moves you there, it does not post there. No
   primitive posts a message into a session you are not currently in. **[inferred]** This is why
   the Board is files on disk: a Card is the only thing that reaches a session you are not in, and
   it reaches it only when a human runs `/xfer board read`.
3. **No mid-generation injection.** steer waits for the current assistant turn's tool calls
   (`pi-agent-core/dist/types.d.ts:239-247`); there is no hook into an in-flight response.
   `provider_stream_event` is explicitly read-only and unpersisted (`docs/extensions.md:148`).
4. **Session control is command-only.** Lifecycle handlers calling `newSession`/`fork`/`switch`/
   `waitForIdle` "can deadlock the runtime" (`docs/extensions.md:207`). So an extension cannot, e.g.,
   autonomously fork a session in response to an inbound Handoff from inside `pi.on`.
5. **Queue drain policy is not extension-controlled.** `steeringMode` / `followUpMode` are
   session/settings-level (`docs/rpc-commands.md:331-365`); the extension surface exposes no setter
   (§1.3). And an extension cannot dequeue (`hasPendingMessages` is read-only; no `clearQueue`
   on `ExtensionAPI`).
6. **Extension runtime teardown is total on session replacement.** `teardownCurrent` then a new
   runtime (`agent-session-runtime.js:136-172`): every subscription and every `pi.on` registration
   is recreated. Anything held only in closure state is lost — which is why `state.ts` guards
   `sessionManager` access in try/catch and re-derives identity on each `session_start`.
7. **No multi-agent concept.** §2.4. No sub-agent spawn, no shared scheduler, no agent registry.
8. **No todo/plan signal.** §3.2.
9. **Status is a string pi-xfer invents.** The `thinking` / `tool:<name>` / `idle` vocabulary in
   `index.ts:206-209` is pi-xfer's own; pi publishes no such enum. Any peer-side use of
   `metadata.status` is reading a pi-xfer convention.
10. **`agent_end` ≠ quiescent.** Explicit in `docs/extensions.md:64`, `docs/json.md:48,56`. Any
    liveness/scheduling inference from `agent_end` inherits this.

## Open questions

1. **Does anything depend on `agent_end`-as-idle?** `index.ts:209` writes `idle` on `agent_end`;
   `agent_settled` exists for exactly that claim. Whether a peer or the Admin treats `status: idle`
   as "safe to send a Task now" is not documented in the tree. Unresolved by reading alone: it
   needs the Admin (`admin-main.ts`) and peer-consumer side checked for `status` usage.
2. **`sendUserMessage` receives a `triggerTurn` key it does not declare.** `commands.ts:469, 525,
   541, 570, 687` pass `{ deliverAs: "followUp", triggerTurn: true }`. `sendUserMessage`'s options
   are `{deliverAs, expandPromptTemplates}` only (`types.d.ts:1267-1271`; 1.1.0 `:1243-1246`), and
   the message "always triggers a turn". The extra key is inert today. Whether that is intentional
   (copy-paste from the `sendMessage` call in `controller.ts:69`) or a latent type error under a
   stricter compile is not determinable from the tree; `npm test` runs with `ts-resolve-hook.mjs`,
   not `tsc`, so nothing would have flagged it.
3. **Is `syncXferToolAvailability` meant to call `setActiveTools`?** See §4.2 — the comment states
   the intent, `getActiveTools()` is read into an unused local. Not a pi question, but the survey
   surfaced it and it interacts with limit 2 (a `direct` tool that is not active is not declared to
   the model).
4. **Does `ui_prompt_start` cover every human-blocking path?** It says "Pi starts waiting on a
   blocking user-facing extension UI prompt" with `reason: "ui_prompt"` (`types.d.ts:808-814`).
   Whether a native Pi dialog (a tool-call confirmation not mediated by an extension) emits it is
   not stated. Affects whether "the human is present" is fully observable.
5. **Ordering of `session_shutdown` vs. the old runtime's `context` being invalid.** pi-xfer closes
   the socket in `session_shutdown` and re-binds in `session_start`. Whether an inbound frame can
   arrive in the gap between the two — and what `deliverInbound` would do with a `pi` whose runtime
   is already invalidated — is not covered by any test in the tree that I found.
6. **Not checked:** `docs/cli-integration.md`, `docs/rpc-extension-ui.md`, `docs/codemode.md` were
   skimmed only for keywords, not read in full. If a future design leans on out-of-process control
   (limit 1), those are the pages to read properly, and `RpcClient` deserves its own pass.

## 核对与存疑

- 全部签名逐条对照 1.3.0 的 `dist/core/extensions/types.d.ts` 与仓内 1.1.0 的同名声明,两版一致;
  行号取 1.3.0。
- `docs/extensions.md` 只有 277 行且不含逐条签名,所以 `sendMessage` / `sendUserMessage` 的
  "四种情况"语义是从 `dist/core/agent-session.js:1801-1859` 的实现读出来的(文档侧只有
  `sendUserMessage` 的"always triggers a turn"一句与 `how-pi-works.md:13` 的一行)。凡属推断均
  标 **[inferred]**。
- `agent_end` vs `agent_settled` 的差异是本仓实际行为与 pi 语义的一处偏离(`index.ts:209`),
  不是 pi 的文档不足。
- "pi 没有 sub-agent / todo 信号"两类否定断言,依据是 `docs/*.md` 全文 grep 加
  `types.d.ts` 的事件表穷举,而非官方声明的缺失清单 —— 属"未找到"而非"被明确排除"。
- 未运行任何测试,未启动 pi,未接触任何部署。仓库除本文件外无改动。
