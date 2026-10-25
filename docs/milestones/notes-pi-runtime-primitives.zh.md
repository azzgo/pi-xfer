> 中文版 · 英文原文：[notes-pi-runtime-primitives.md](notes-pi-runtime-primitives.md)

# pi 运行时原语：agent 间消息、会话注入与调度 —— 研究输入（pi 1.3.0 扩展 API 表面）

来源：对已安装 pi 发行版的只读调研，作为 pi-xfer 设计的背景材料。没有改动任何代码；没有接触任何部署；`XFER_ALLOW_REMOTE` 未被设置。来源：`~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/`（文档在 `docs/*.md`，声明在 `dist/core/extensions/types.d.ts`，实现在 `dist/core/agent-session.js`）以及本仓库树（`index.ts`、`controller.ts`、`commands.ts`、`board.ts`、`state.ts`，外加 `docs/adr/`）。下文每条断言都带出处；凡属我从实现读出的推断而非文档陈述，均标注 **[inferred]**。

术语遵循 `CONTEXT.md`（Handoff、Kind、Node、Board、Card、Entry、Inbox、Adapter Daemon）。

## 0. 范围说明：本文的 "pi" 指什么

已安装的发行版是 1.3.0；仓库的 `node_modules` 解析到 1.1.0。两者在下面引用的每个签名上都一致（抽查 `sendUserMessage`，1.1.0 的 `dist/core/extensions/types.d.ts:1243` 对 1.3.0 的 `:1267` —— 参数列表相同）。除注明外行号取 1.3.0。

pi 暴露三个集成平面，它们*不*可互换：

| 平面 | 边界 | 控制模型 | 来源 |
|---|---|---|---|
| Extension API（`pi.*`） | 进程内 | TypeScript 方法 + `pi.on()` 事件 | `docs/extensions.md:3` |
| SDK（`createAgentSession()`） | 进程内 | 直接调用 `AgentSession` 方法 | `docs/sdk.md:5-7` |
| RPC 模式（`pi --mode rpc`） | 子进程 | stdin/stdout 上的 JSONL | `docs/rpc.md:3-9` |

Extension API 是 pi-xfer 所在的平面。扩展"运行在 Pi 进程内，拥有相同的操作系统权限"（`docs/extensions.md:5`）。除另有说明，§1–§4 都在扩展平面上。

## 1. 注入原语

### 1.1 签名

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

两者在 `ExtensionAPI` 上都是 fire-and-forget（`void`）。`ReplacedSessionContext` 变体（`types.d.ts:329-337`）上同样的两个方法返回 `Promise<void>`，且只能在 `withSession` 回调内获得。

按声明与实现给出的语义：

- **`sendMessage`** 追加一条 `custom_message` entry —— "custom content stored and sent to the model"（`docs/extensions.md:219-220` 表格）。它是带 `customType` 的内容，不是一次用户回合。
- **`sendUserMessage`** —— "Send a user message to the agent. **Always triggers a turn.** When the agent is streaming, use deliverAs to specify how to queue the message."（`types.d.ts:1264-1266`）。`expandPromptTemplates` "Set … to dispatch extension commands and expand skill commands and prompt templates" —— 默认 false（`dist/core/agent-session.js:1893` javadoc）。

### 1.2 `sendCustomMessage` 的四情形分发

这是承重的表。来源：`dist/core/agent-session.js:1801-1815`（javadoc）与 `:1816-1859` 的分支顺序。

| `isStreaming` | `triggerTurn` | `deliverAs` | 结果 |
|---|---|---|---|
| false | falsy | 任意 | 立即追加到 state/session，不触发回合 |
| false | `true` | 任意**除 `"nextTurn"` 外** | 追加，**启动新 run** |
| false | `true` | `"nextTurn"` | 推入 `_pendingNextTurnMessages`，此路径绝不启动 run |
| true | `!== false` | `"steer"`（默认） | `agent.steer(msg)` —— 入队 |
| true | `!== false` | `"followUp"` | `agent.followUp(msg)` —— 入队 |
| true | `false` | 任意 | 推入 `_pendingCustomMessages`，当前回合结束时冲刷，**不开新回合** |

有后果的注记：

- **分支顺序重要。** `deliverAs === "nextTurn"` 的检查在最前，且不依赖 streaming 状态（`agent-session.js:1824-1826`），因此 `nextTurn` 永远到不了 `triggerTurn` 分支。`nextTurn` 是唯一在 `sendUserMessage` 中没有对应物的投递模式。
- **streaming 期间 `triggerTurn: false` 是推迟，不是丢弃。** 代码注释解释了为何拒绝立即追加：它"would put the message between an assistant tool call and its result, which providers that validate message order reject on replay. Defer to the end of the turn."（`agent-session.js:1836-1841`）。被推迟的消息由 `_flushPendingCustomMessages()` 冲刷（`:1878-1888`）。
- **`agent_settled` 正在发射期间收到 `triggerTurn: true` 会自我重新入队。** `_isEmittingAgentSettled` 使该调用被推入 `_deferredSettledActions` 并稍后重跑（`:1833-1837`）。**[inferred]** 与任何从 `agent_before_settle` 处理器注入的设计相关。
- 投递时默认模式是 steer：若在 streaming 且省略 `deliverAs`，`else` 分支调 `agent.steer`（`:1830-1834`）。

### 1.3 `steer` 与 `followUp` —— 精确区别

| | steering | follow-up |
|---|---|---|
| 文档一行 | "Steering messages enter after the current assistant turn." | "Follow-up messages enter after the agent has finished its pending work."（`docs/how-pi-works.md:13`） |
| agent 循环钩子 | `getSteeringMessages` —— "Called after the current assistant turn finishes executing its tool calls, unless `finishTurn` ends the run. If messages are returned, they are added to the context **before the next LLM call**. Tool calls from the current assistant message are not skipped."（`pi-agent-core/dist/types.d.ts:239-247`） | `getFollowUpMessages` —— "Called when the agent has **no more tool calls and no steering messages**."（`:248-256`） |
| RPC 措辞 | "delivered after the current assistant turn finishes executing its tool calls, before the next LLM call"（`docs/rpc-commands.md:26`） | "Wait until the agent finishes. Message is delivered only when agent stops."（`docs/rpc-commands.md:27`） |
| 排空策略 | `steeringMode`：`"all"` 或 `"one-at-a-time"`（默认）（`docs/rpc-commands.md:340-341`） | `followUpMode`（`docs/rpc-commands.md:348`） |

所以：**steer = run 中途，距一个回合边界之遥；followUp = 在 run 本会停止之后。** 两者都不是"立即" —— 没有任何原语能把消息插进一条生成中的 assistant 消息内部，或插在 tool call 与其结果之间。

排空模式是设置，不是按调用，扩展无法设置它们：`pi.setSteeringMode` / `pi.setFollowUpMode` 不出现在 `ExtensionAPI` 表面（`types.d.ts:1190-1406`）；这些模式在 `AgentSession`（`dist/core/agent-session.js` 的 `setSteeringMode`）和 RPC 表面（`docs/rpc-commands.md:331-365`）上。**[inferred]** 需要 `"all"` 的扩展拿不到它。

### 1.4 注入时机：回合中 vs 回合末

- run 生命周期："A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`."（`docs/extensions.md:62`）
- "Pi counts as busy while a run starts, including the compaction check and `before_agent_start`, so messages sent meanwhile go into the starting run."（`docs/extensions.md:63`）—— 即与 run 启动竞速的注入会被该 run 吸收而不是被拒绝。
- `agent_end` *不是*终点："Automatic retries, recovery, compaction, or queued work can continue afterward."（`docs/extensions.md:64`）最终边界是 `agent_settled`（`docs/extensions.md:66`、`docs/json.md:48`）。
- `turn_end` 与 `agent_before_settle` 是仅有的两个"可动手的边界"，其处理器可追加 `custom`、`custom_message`、`context_edit` 或 `compaction` entry 并返回 `continue: true` 换取恰好一次额外的模型请求（`docs/extensions.md:154`）。

### 1.5 内容变换原语（不是注入，但相邻）

`context` 在不接管 prompt/工具系统消息的前提下变换对话；Pi 随后恢复其状态（`docs/extensions.md:150`、`types.d.ts:679-694`）。`context_with_system` 让处理器拥有*完整*逐字稿，包括系统消息（`types.d.ts:688-692`）。`message_end` "can replace a finalized message while preserving its role"（`docs/extensions.md:146`）。这些改变模型看到的内容，但不添加队列 entry。

## 2. 状态与调度原语

### 2.1 Idle / busy

```
// ExtensionContext, types.d.ts:213-253
isIdle(): boolean
signal: AbortSignal | undefined      // "or undefined when the agent is not streaming" (:239)
abort(): void                        // "Abort the current agent operation" (:241)
hasPendingMessages(): boolean        // "Whether there are queued messages waiting" (:243)
```

idle 的实现：

```
// dist/core/agent-session.js:1056-1059
/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
get isIdle() { return !this._isAgentRunActive && !this.isCompacting; }
```

两条要紧的观察：

- `isIdle` **不**查询待处理消息计数，尽管它自己的注释提到了 queued continuation。队列状态是另一个谓词，`hasPendingMessages()`（`= pendingMessageCount > 0`，接线于 `agent-session.js:2787-2793`）。
- `_isAgentRunActive` 是一个普通布尔，run 进入时置位、在 `finally` 中清除（`agent-session.js:1393,1400`），因此它在事件之间是准确的，但对*已排定*的工作（重试睡眠、一条被推迟的 `_deferredSettledActions` 项）一无所知。
- `ctx.signal` 在回合之外是 undefined。"Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal."（`docs/extensions.md:158`）

### 2.2 中止、队列控制、关停

- `ctx.abort()` —— 扩展可见，但当宿主装入了 `_extensionAbortHandler` 时会经其路由（`agent-session.js:2789-2792`）。**[inferred]** 在 CLI 中该处理器与 `session.abort()` 汇合，但这个间接层意味着嵌入者可以替换行为。
- `SessionManager.abort()` "stops the active operation and waits for the session to become idle"；`waitForIdle()` "waits without aborting it"（`docs/sdk.md:78-79`）。在扩展平面上，`waitForIdle()` **只**存在于 `ExtensionCommandContext`（`types.d.ts:289`），不在普通 `ExtensionContext` 上。
- 清空队列：`clearQueue()` 在 `AgentSession` 上存在，也是 RPC 的 `clear_queue` 命令（`docs/rpc-commands.md:107-128`），但**没有扩展 API 对应物** —— 扩展表面只暴露 `hasPendingMessages()`（一个读操作）。**[inferred]** 扩展能入队和观察，但不能出队。
- `ctx.shutdown()` —— "Gracefully shutdown pi and exit. Available in all contexts."（`types.d.ts:245-246`）。

### 2.3 会话：新建 / fork / 切换 / 树

这些全部**仅限命令**，在 `ExtensionCommandContext` 上（`types.d.ts:286-327`）：

| 方法 | 签名要点 | 来源 |
|---|---|---|
| `newSession` | `(opts?: { parentSession?, setup?, withSession? }) => Promise<{cancelled: boolean}>` | `types.d.ts:290-299` |
| `fork` | `(entryId, opts?: { position?: "before"\|"at", withSession? }) => Promise<{cancelled}>` | `types.d.ts:301-307` |
| `navigateTree` | `(targetId, opts?: { summarize?, customInstructions?, replaceInstructions?, label? })` | `types.d.ts:309-318` |
| `switchSession` | `(sessionPath, opts?: { withSession? })` | `types.d.ts:321-325` |
| `reload` | `() => Promise<void>` —— 重载扩展、技能、prompt、主题、context 文件 | `types.d.ts:327` |

它们仅限命令的原因："These operations are command-only because calling them from lifecycle handlers can deadlock the runtime."（`docs/extensions.md:207`）以及："Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession`"（`docs/extensions.md:209`）。

替换在机制上实际做什么（`dist/core/agent-session-runtime.js:136-172`）：先跑 `teardownCurrent(reason, …)`，再创建一个全新的 runtime，带 `sessionStartEvent: { type: "session_start", reason: "new" | "resume" | "fork", previousSessionFile }`。所以一次会话切换会把扩展 runtime 整个拆掉并重新发射 `session_shutdown` 再 `session_start` —— 对普通 `pi.on` 处理器可观察。枚举的 reason 在 `types.d.ts:578`（`"startup" | "reload" | "new" | "resume" | "fork"`）和 `types.d.ts:641`（shutdown：`"quit" | "reload" | "new" | "resume" | "fork"`）。

### 2.4 子 agent / 并发 agent：不是 pi 的概念

扩展 API 中**没有**子 agent、worker 或并行 agent 原语。词汇里最接近的只有：

- 一条 assistant 消息内的并行*tool call*："Tool calls from one assistant message can run in parallel."（`docs/extensions.md:156`）—— 是工具执行的并发，不是 agent 的并发。
- `ctx.executeTool(name, args, …)` 以"与模型发起的调用相同的验证、钩子与权限检查"运行另一个工具，嵌套 `toolCallId` 为 `<parent id>/<n>`（`types.d.ts:269-285`、`docs/extensions.md:139-143`）。嵌套调用"do not add transcript entries"。这是工具组合，不是下级 agent。
- 对 `docs/*.md` 做 `sub-agent|subagent|sub agent|concurrent agent|parallel agent` 的 grep 无任何结果。

**[inferred]** 因此多 agent 拓扑必须建在 pi *之外*（各自持有独立会话的独立 pi 进程），这正是 pi-xfer 的 socket/mesh 层所做的事。

### 2.5 队列

pi 自己拥有的队列只有每会话的 `steeringQueue` / `followUpQueue`（`pi-agent-core/dist/agent.d.ts:39-40`）外加两个内部待处理列表（`_pendingCustomMessages`、`_pendingNextTurnMessages`，`agent-session.js:1821-1845`）。没有通用工作队列、调度器、定时器或 cron 原语。单会话范围：一个 `AgentSession` "owns one conversation, its model and tools, queued messages, compaction state, and extension runtime"（`docs/sdk.md:29`）。

还有 `pi.events` —— 一个 `EventBus`（`emit(channel, data)` / `on(channel, handler) => unsubscribe`，`dist/core/event-bus.d.ts:1-4`），被描述为 "Shared event bus for extension communication"（`types.d.ts:1405-1406`）。**[inferred]** 它是每个 runtime 创建一次的进程内对象；不能跨进程边界。自带示例把它纯粹用于同进程的扩展间闲聊（`examples/extensions/event-bus.ts`）。

## 3. 事件表面

`pi.on()` 返回一个退订函数；处理器按扩展加载与注册顺序运行；"changes do not affect a dispatch already in progress"（`docs/extensions.md:132`）。完整列表来自 `types.d.ts:1190-1206`：

| 事件 | 载荷（承重字段） | 用途 |
|---|---|---|
| `session_start` | `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`、`previousSessionFile?` | 绑定每会话资源 |
| `session_info_changed` | `name?: string` | 改名跟踪 |
| `session_before_switch` / `session_before_fork` | `reason`、`targetSessionFile`、`entryId`、`position` | 可取消 |
| `session_before_compact` | `preparation`、`branchEntries`、`reason: "manual"\|"threshold"\|"overflow"`、`willRetry`、`signal` | 可取消 / 自定义压缩 |
| `session_compact` / `session_compact_failed` | `compactionEntry`、`reason`、`aborted`、`willRetry`、`fromExtension` | |
| `session_shutdown` | `reason: "quit"\|"reload"\|"new"\|"resume"\|"fork"`、`targetSessionFile?` | 清理 |
| `session_before_tree` / `session_tree` | `preparation`、`newLeafId`、`oldLeafId`、`summaryEntry?` | |
| `mcp_servers_change`、`resources_discover`、`project_trust` | 见 `types.d.ts:535-574` | |
| `context` / `context_with_system` | `messages` | 变换模型所见 |
| `cache_warming_decision` | —— | `{action:"warm"\|"stop"}` |
| `before_provider_request` | `payload` | 替换 payload |
| `before_provider_headers` | `headers`（可变） | |
| `after_provider_response` | `status`、`headers` | |
| `provider_stream_event` | `provider`、`api`、`model`、`data` | 只读，不持久化 |
| `before_agent_start` | `systemPrompt`、`systemPromptOptions`，外加带 `prompt`/`images` 的 `messageType: "user"` **或**带 `message` 的 `messageType: "custom"` | run 起点甄别 |
| `agent_start` / `agent_end` | `agent_end.messages: AgentMessage[]` | busy/idle 边沿 |
| `agent_before_settle` | `entries`、`continue`、`context: {contextEntries, contextMessages, llmMessages, pendingMessages, canContinue}`、`outcome` | 最后一个可动手的边界 |
| **`agent_settled`** | `aborted: boolean` | **"Pi will not continue automatically"** |
| `ui_prompt_start` / `ui_prompt_end` | `kind: "select"\|"confirm"\|"input"\|"editor"\|"custom"`、`title?` | Pi 正在等人 |
| `turn_start` / `turn_end` | `turnIndex`、`timestamp` / `message`、`toolResults`、`messageEntryId`、`toolResultEntryIds` | |
| `message_start` / `message_update` / `message_end` | `message`、`assistantMessageEvent` | |
| `tool_execution_start` / `_update` / `_end` | `toolCallId`、`toolName`、`args`、`parentToolCallId?` / `result`、`isError`、`durationMs?` | agent 正在做什么 |
| `model_select` / `thinking_level_select` | `model`、`previousModel`、`source: "set"\|"cycle"\|"restore"` | |
| `tool_call` / `tool_result` | 按内建工具定型、`toolCallId`、`parentToolCallId?` | 改写 / 阻断 / 组合 |
| `user_bash` | `command`、`excludeFromContext`、`cwd` | |
| `input` | `text`、`images`、`source: "interactive"\|"rpc"\|"extension"`、`streamingBehavior?: "steer"\|"followUp"` | |

### 3.1 哪些信号能可靠回答 "busy / idle"

| 信号 | 它实际告诉你什么 | 来源 |
|---|---|---|
| `ctx.isIdle()` | 无活动 run **且**未在压缩 | `agent-session.js:1057-1059` |
| `ctx.hasPendingMessages()` | steering+followUp 队列非空 | `agent-session.js:2793` |
| `agent_start` 已发、`agent_settled` 未发 | 有 run 在活动或正在自动继续 | `docs/json.md:48,56` |
| `agent_end` | 一个低层 run 结束了 —— **重试/压缩/队列仍可能跟上** | `docs/extensions.md:64` |
| `agent_settled` | 不会再有自动继续 | `docs/extensions.md:66` |
| `ui_prompt_start` / `_end` | 人类正被问某个问题（另一类 "busy"） | `types.d.ts:808-820` |

文档明确警告的陷阱是把 `agent_end` 当 "idle"。pi-xfer 现在正是这么做的（见 §4.1）。

### 3.2 有没有 todo / plan 信号？

**没有。** 扩展 API 中没有任何 todo、plan 或任务列表事件、字段或 context 方法。这个发行版里唯一的 "todo" 是一个*自己实现了 todo 的示例扩展*：`examples/extensions/todo.ts` "Registers a `todo` tool for the LLM to manage todos"，并通过扫描 `toolName === "todo"` 的 `toolResult` 消息重建状态（`examples/extensions/todo.ts:5-6,121`）；`docs/extensions.md:151` 把它列为示例，不是特性。**[inferred]** "agent 接下来打算做什么" 只能靠读逐字稿恢复：`agent_end.messages`、`ctx.sessionManager.getBranch()`，或经 `tool_execution_start` / `tool_call` 读 assistant 的 tool-call 名。没有结构化的 plan 对象。

## 4. pi-xfer 用了什么、没用什么

### 4.1 今天在用

| 原语 | 位置 | 为何用 / 什么依赖它 |
|---|---|---|
| `pi.registerFlag("xfer", …)` | `index.ts:26-30` | `--xfer` 名字覆盖 |
| `pi.on("session_start")` | `index.ts:44-46` → `controller.start()` | 绑定 Unix socket、派生身份名、启动元数据轮询（`controller.ts:86-118`） |
| `pi.on("before_agent_start")` | `index.ts:66-68` → `syncXferToolAvailability()` | 每回合重估 peer 存活 |
| `pi.registerCommand("xfer")` | `commands.ts:81` | 整个命令表面 |
| `pi.registerTool("xfer_to")` / `("xfer_mesh_to")` | `index.ts:73`、`:157` | 出站 Handoff 发送 |
| `pi.sendMessage` + `deliverAs` | `controller.ts:64-70` | 入站投递，仓库里唯一的 steer/followUp 分叉 |
| `pi.sendUserMessage` | `commands.ts:452, 514, 537, 559, 670` | 命令 → agent prompt（Handoff Request、board new/read/write） |
| `ctx.isIdle()` | `state.ts:74-76`，在 `controller.ts:32` 读 | 选 `followUp`+`triggerTurn` 还是 `steer` |
| `ctx.ui.notify` / `ctx.ui.setStatus` / `ctx.ui.confirm` | 全篇 | 面向人类的反馈 |
| `ctx.model` | `controller.ts:102` | 记入元数据 |
| `ctx.sessionManager.getSessionName()` | `state.ts:20-26` | 元数据 |
| `pi.getActiveTools()` | `index.ts:61` | 在 `syncXferToolAvailability` 内读 |
| `pi.on("agent_start"/"tool_execution_start"/"tool_execution_end"/"agent_end"/"model_select")` | `index.ts:206-214` | 发布给 peer 的本地状态串（`thinking` / `tool:<name>` / `idle`） |
| `pi.on("agent_end")` | `board.ts:248-…` | 两阶段 Board 写入：从 `event.messages` 解析 `board-entry` 块 |
| `pi.on("session_shutdown")` | `index.ts:216-219` | mesh 下线 + socket/元数据清理 |
| `toolResult` 的 `details` 作为引导载体 | `xfer_to` / `xfer_mesh_to` 返回值 | 工具结果形状见 `docs/extensions.md:127-129` |

入站分叉是仓库里唯一一段真正的 steering 策略：

```
// controller.ts:32, 64-70
const isIdle = state.isRuntimeIdle();
pi.sendMessage({ customType: "xfer-inbound", content, display: true },
  isIdle ? { deliverAs: "followUp", triggerTurn: true }
         : { deliverAs: "steer" });
```

对照 §1.2 来读：idle 时，`followUp` + `triggerTurn: true` 走"非 streaming + triggerTurn"分支并启动 run；`followUp` 标签在那里是惰性的。streaming 时走 steer 分支。**[inferred]** 所以这一对的实际效果是"idle 就启动 run，否则 steer"，正是代码的意图；idle 臂里的 `deliverAs: "followUp"` *在本发行版中*没有可观察的效果，只有当 idle 检查在读与调用之间失效时才会有意义。

### 4.2 未使用 —— 逐一列举

| 原语 | 状态 | 理由踪迹 |
|---|---|---|
| `pi.sendMessage` 的 `deliverAs: "nextTurn"` | 未用 | 树中任何注释都未提及；没有东西需要"hold 到下一个回合边界" |
| `triggerTurn: false`（streaming 中推迟追加） | 未用 | xfer 总是希望消息影响工作 |
| `pi.appendEntry` | 未用 | 没有要保留的持久非 context 扩展状态；身份在 `<name>.json` 文件里，状态在内存里（`state.ts:10-18`） |
| `agent_settled` | **未用** | 状态在 `agent_end` 上置 `idle`（`index.ts:209`）—— 这是与 §3.1 的偏离，且 `AGENTS.md` / `docs/adr` 里没有关于它的记录 |
| `agent_before_settle` | 未用 | 不想要继续语义 |
| `turn_start` / `turn_end` | 未用 | 从不需要每回合粒度 |
| `message_start` / `_update` / `_end` | 未用 | 状态串用的是 agent+tool 事件 |
| `input` | 未用 | xfer 不改写人类输入 |
| `user_bash` | 未用 | |
| `tool_call` / `tool_result` 处理器 | 未用 | `xfer_to` 是普通工具；没有 confirm/redact 步骤。`board.ts` 读 `agent_end.messages` 而非 `tool_result` |
| `context` / `context_with_system` | 未用 | ADR 0009 为 Board 内容选择了 prompt 注入而非 context 改写（`docs/adr/0009-xfer-board-command-driven.md:42-47`） |
| `before_provider_request` / `_headers` / `after_provider_response` / `provider_stream_event` | 未用 | |
| `session_before_compact` / `session_compact*` | 未用 | 压缩与 xfer 无关 |
| `session_info_changed` | 未用 —— **缺口** | 改名靠写入时的 `getSessionName()`（`state.ts:20-26`）+ `METADATA_POLL_MS` 轮询，而不是事件 |
| `session_before_switch` / `session_before_fork` / `session_tree` | 未用 | |
| `ui_prompt_start` / `_end` | 未用 | 最接近"人类在场"的信号，却没有被参考 |
| `ctx.hasPendingMessages()` | 未用 | `controller.ts:32` 只问 `isIdle` —— 于是"已入队但尚未运行"的回合被读作 idle |
| `ctx.abort()` | 未用 | xfer 从不取消 run |
| `ctx.signal` | 未用 | 工具忽略注入的 signal（它们接收 `_signal`/`signal` 但不转发） |
| `ctx.shutdown()` | 未用 | |
| `ctx.getContextUsage()` / `ctx.compact()` | 未用 | |
| `ctx.getSystemPrompt()` / `getSystemPromptOptions()` | 未用 | 系统提示未动 |
| `before_agent_start` 的 prompt 手术（`systemPromptOptions`、`systemPrompt`、`forceSystemPrompt`） | 未用 | 什么都不返回；只做工具可用性重算。`docs/extensions.md:144` 指向受支持的路线（"Prefer changing prompt sections, selected tools, or guidelines"） |
| `before_agent_start.messageType` | 未用 | `messageType` 可以区分 Board/HH 注入 run 与人类回合；从未被读 |
| `pi.setActiveTools` | 未用 —— **即 bug 的形状** | `syncXferToolAvailability()` 把 `pi.getActiveTools()` 读进局部 `active` 然后返回（`index.ts:57-63`）；没有任何东西调用 `setActiveTools`，于是 `index.ts:48-52` 注释里"无 peer 时把工具描述挡在 prompt 外"的意图没有实现。注意这与 `commands.ts:452` 等交互 —— 它们调用 `sendUserMessage` 期望 agent 用 `xfer_to` —— 若可用性门控照注释实现，无活 peer 的 `/xfer <target>` 会引导 agent 调一个未声明的工具 |
| `pi.getAllTools` / `getSettings` / `getCommands` | 未用 | |
| `pi.setSessionName` / `getSessionName` / `setLabel` | 未用（间接读） | `getSessionName` 经 `ctx.sessionManager` 读，不经 `pi` |
| `pi.exec` | 未用 | |
| `pi.registerMessageRenderer` / `registerEntryRenderer` / `registerMarkdownTransformer` / `registerToolRenderer` | 未用 | 于是 `customType: "xfer-inbound"` 用默认 custom-message 渲染器渲染。那正是 `docs/extensions.md:225` 为 "when custom stored content should appear in the transcript" 点名的钩子 |
| `pi.registerShortcut` | 未用 | `/xfer` 已覆盖 |
| `pi.events`（事件总线） | 未用 | 仅进程内；xfer 服务的每个消费者都在进程外（另一个 pi、`admin.cjs`、broker、userscript）。`examples/extensions/handoff.ts` 示例是 `pi.events` *用途*的先例 |
| `ctx.newSession` / `fork` / `navigateTree` / `switchSession` / `reload` | 未用 | `examples/extensions/handoff.ts` 展示了预期用法：生成一段 prompt，`ctx.newSession({parentSession, withSession})`。pi-xfer 的 Handoff 刻意落在*另一个 agent 的*会话里，不是自己的新会话 —— 见 CONTEXT.md 的 Handoff 定义（"A Handoff carries a message, not memory"） |
| `outputSchema` / `structuredContent` | 两个工具都**在用** | `index.ts:96-101, 170-175` |
| `annotations` | 在用 | `index.ts:80-82` |
| `exposure` / namespaces / `reachesTools` / `prepareLoadout` | 未用 | 两个工具默认都是 `direct` |
| `ctx.executeTool` | 未用 | |

来自 crate 文档而非我个人阅读的理由：

- **Board 的命令驱动是决策，不是遗漏。** ADR 0009 写明 "All board operations live under `/xfer board …`. No `pi.registerTool`. Agents never touch the board unprompted; the human orchestrates"，两阶段写入是 "prompt injection + `agent_end` interception"（`docs/adr/0009-xfer-board-command-driven.md:38-47`）。其 Consequences 节甚至预见了日后改用 `registerTool`。所以 `commands.ts` / `board.ts` 里的 `sendUserMessage` + `agent_end` 是已定的形状。
- **Inbox 是 take-to-read 是决策。** `docs/adr/0015-adapter-daemon.md:31-36` —— "There is no durable storage design behind the Inbox"；Adapter Daemon 给非 pi 的 Agent Host 一个 Inbox 外加可选的 `--on-handoff <cmd>` stdin 策略，而不是任何 pi 平面注入，因为非 pi 宿主没有 `pi.sendMessage`。这就是 pi-xfer 需要自己的线上格式的结构性原因。

## 5. pi 侧的硬限制

这些是让整类设计变得不可能的约束，而不仅仅是未实现。

1. **注入不跨进程。** `pi.sendMessage` / `pi.sendUserMessage` 是进程内 `ExtensionAPI` 上的方法。`pi.events` 是进程内 `EventBus`（`dist/core/event-bus.d.ts:1-8`）。扩展 API 中没有任何东西寻址另一个 pi 进程。仅有的跨进程平面是 pi-xfer 已建好的 Unix socket，以及 RPC 模式（`docs/rpc.md:3-9`）—— 后者要求*目标*是 `pi --mode rpc` 子进程 —— 对 peer 是一种启动模式的改变，不是扩展能假设的。
2. **注入不跨会话。** 消息落在发送它的扩展 runtime 所在的会话里。到达另一个会话意味着仅限命令的 `switchSession` / `newSession` / `fork`（`types.d.ts:286-327`），它们*替换*活动会话并使旧 context 失效（`docs/extensions.md:209`）—— 即它把你搬过去，不是往那儿投递。没有原语能向一个你当前不在的会话投递消息。**[inferred]** 这正是 Board 是磁盘文件的原因：一张 Card 是唯一能到达你不在这个会话的东西，而且只有当有人运行 `/xfer board read` 时才到达。
3. **没有生成中注入。** steer 等待当前 assistant 回合的 tool call（`pi-agent-core/dist/types.d.ts:239-247`）；没有进入飞行中响应的钩子。`provider_stream_event` 明确只读且不持久化（`docs/extensions.md:148`）。
4. **会话控制仅限命令。** 生命周期处理器调用 `newSession`/`fork`/`switch`/`waitForIdle` "can deadlock the runtime"（`docs/extensions.md:207`）。于是扩展不能例如在 `pi.on` 内响应入站 Handoff 而自主 fork 会话。
5. **队列排空策略不受扩展控制。** `steeringMode` / `followUpMode` 在会话/设置层（`docs/rpc-commands.md:331-365`）；扩展表面没有 setter（§1.3）。而且扩展不能出队（`hasPendingMessages` 只读；`ExtensionAPI` 上没有 `clearQueue`）。
6. **会话替换时扩展 runtime 被整体拆毁。** `teardownCurrent` 然后新 runtime（`agent-session-runtime.js:136-172`）：每个订阅、每个 `pi.on` 注册都被重建。只存在于闭包状态里的东西都会丢 —— 这就是 `state.ts` 用 try/catch 守护 `sessionManager` 访问并在每个 `session_start` 重新派生身份的原因。
7. **没有多 agent 概念。** §2.4。没有子 agent 派生、没有共享调度器、没有 agent 注册表。
8. **没有 todo/plan 信号。** §3.2。
9. **状态串是 pi-xfer 自己发明的。** `index.ts:206-209` 的 `thinking` / `tool:<name>` / `idle` 词汇是 pi-xfer 自己的；pi 不发布这样的枚举。peer 侧对 `metadata.status` 的任何使用读的都是 pi-xfer 的约定。
10. **`agent_end` ≠ 静默。** `docs/extensions.md:64`、`docs/json.md:48,56` 明说了。任何从 `agent_end` 做出的存活/调度推断都继承这一点。

## 悬而未决的问题

1. **有东西依赖 `agent_end`-即-idle 吗？** `index.ts:209` 在 `agent_end` 写 `idle`；`agent_settled` 正是为这一断言存在的。是否有 peer 或 Admin 把 `status: idle` 当作"现在发 Task 是安全的"，树中没有文档。仅靠读无法解决：需要检查 Admin（`admin-main.ts`）与 peer 消费侧对 `status` 的使用。
2. **`sendUserMessage` 收到了它未声明的 `triggerTurn` 键。** `commands.ts:469, 525, 541, 570, 687` 传 `{ deliverAs: "followUp", triggerTurn: true }`。`sendUserMessage` 的 options 只有 `{deliverAs, expandPromptTemplates}`（`types.d.ts:1267-1271`；1.1.0 的 `:1243-1246`），而该消息 "always triggers a turn"。多出的键今天是惰性的。这是有意的（从 `controller.ts:69` 的 `sendMessage` 调用复制粘贴）还是更严格编译下的潜在类型错误，无法从树中判定；`npm test` 跑的是 `ts-resolve-hook.mjs`，不是 `tsc`，所以没有任何东西会标记它。
3. **`syncXferToolAvailability` 是不是该调 `setActiveTools`？** 见 §4.2 —— 注释陈述了意图，`getActiveTools()` 被读进一个未用的局部变量。这不是 pi 的问题，但调研把它翻了出来，而且它与限制 2 交互（一个不 active 的 `direct` 工具不会被声明给模型）。
4. **`ui_prompt_start` 覆盖每一条阻塞人类的路径吗？** 它说 "Pi starts waiting on a blocking user-facing extension UI prompt"，带 `reason: "ui_prompt"`（`types.d.ts:808-814`）。原生的 Pi 对话框（不经扩展中介的 tool-call 确认）是否发射它没有说明。影响"人类在场"是否完全可观察。
5. **`session_shutdown` 与旧 runtime context 失效之间的顺序。** pi-xfer 在 `session_shutdown` 关 socket、在 `session_start` 重绑。两事件之间的缝隙里是否可能到达一帧入站消息 —— 以及 `deliverInbound` 会对一个 runtime 已失效的 `pi` 做什么 —— 我在树中找到的测试都没有覆盖。
6. **未检查：** `docs/cli-integration.md`、`docs/rpc-extension-ui.md`、`docs/codemode.md` 只为关键词略读，没有通读。如果未来的设计依赖进程外控制（限制 1），这几页需要正经读一遍，`RpcClient` 也值得单独过一遍。

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
