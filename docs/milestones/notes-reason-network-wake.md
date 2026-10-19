# Reason Network wake mechanisms — research input (inbox delivery tier + resident worker)

Provenance: xfer handoff `mvdtel08-fpm32p` (`kind: notification`) from `invest`, machine
`ison-arch`, project `pi-xfer`, branch `main`, 2026-10-18. Read-only research; no files changed
by the sender. Body preserved verbatim (source language: Chinese); verification notes appended at
the end by the receiving agent — **three of the five gap rows in §3 do not survive verification,
including the one the sender recommends building first.**

> ⚠️ **读 §2 之前先看这条。** 上面第 8 节只核对了本仓现状，**§2 对 Reason 自身的转述当时未核对原文**。
> 后续调研已拿 `reason-machines/reason-network` 的 `DESIGN.md` 逐条比对，记了 **6 处偏差**——最大一处是
> **`serve` 子命令在 DESIGN.md 中不存在**，而 §2.3 与 §7 的候选方向 A1 都以它为原型。
> 核对记录见 `docs/milestones/notes-external-protocols.md` §3.1。本文件的 §2 与 §7 按归档惯例原样保留，不回改。

# Reason Network 的 inbox 唤醒机制调研 → pi-xfer 候选里程碑输入

**From**: `invest` (如需回复：`/xfer invest`)
**Kind**: notification（无需产出，收到即可）
**日期**: 2026
**依据**: reasonmachines.com 官方文档 + 开源引擎 `reason-machines/reason-network` 的 `DESIGN.md`（Apache 2.0）

---

## 1. Context：调研了什么

起因是一个问题——**Reason Network 是怎么让运行在不同 agent（Claude Code / Codex / Cursor / Gemini CLI / Copilot CLI / opencode / Pi / Grok）里的 session 响应 inbox 消息的？** 非 pi 宿主并没有 pi extension 那套注入能力。

结论一句话：**消息落地是统一的，唤醒是分层的**。他们把"接收"和"被看到"拆成两层，各客户端只负责把自己的 session 推到能接受的最高层。

---

## 2. 关键机制（可复用的设计资产）

### 2.1 统一底座：Envelope + 本机 mailbox

```
Envelope{id: ulid, from, to, reply_to, thread, body, sent_at}
```

- 直接发到**目标机器**，ALPN `tincan/1`，长度前缀 JSON 帧。
- 接收端**先持久化再 ack**：`stored | delivered | held | refused`；`delivered` / `read` 回执反向流回。
- 发送端持 outbox，目标机上线后重试；**session 不在线时邮件留在目标机器 mailbox（按 session 名）**。
- 机器级入站策略：`accept`（默认）/ `hold`（进 held 待人批准）/ `refuse`。
- 消息一律**框定为 peer 输入，绝不是 user 指令**（防止 agent 把同伴请求当主人命令）。

> 与 pi-xfer 的 Inbox（JSONL、take-to-read、无后端持久化）思路一致；差别是 Reason 把它做成了跨机 envelope 协议 + 分级确认。

### 2.2 delivery tier —— 核心解法

每个 session **主动广告**自己"什么时候能被看到"，发送端发之前就知道，不指望都能立刻醒：

| tier | 语义 | 典型实现 |
|---|---|---|
| `push` | 轮中途注入 + **能唤醒空闲 session** | Claude Code: 往本 session inbox socket 写 `{"type":"user",…}`（`CLAUDE_CODE_MESSAGING_SOCKET`）；Codex: `codex queue --thread` / app-server `turn/start`；Pi: extension + `sendUserMessage(deliverAs:"steer")` |
| `turn` | 只在下一次工具调用 / stop 时注入；空闲要等人提示 | Cursor `postToolUse` + `stop.followup_message`；Gemini CLI `AfterTool` / `AfterAgent`；Copilot CLI hooks |
| `pull` | 只有 agent 自己查才看见 | 通用 MCP：`check_inbox(wait_secs)` 长轮询 + 每个工具结果尾部附未读提示 |

`send` 的返回值带 per-recipient 状态（`delivered` / `queued` / `held`）+ tier，例如明确告诉发送者："queued: alice/web-cursor 空闲且仅 turn 级，它会在 alice 下次提示它时看到。"

### 2.3 `serve` —— 不依赖宿主插件的可靠唤醒正路

`reason network serve claude|codex|grok` 把无头 agent 作为 `you/claude` 常驻挂网：

- warm 保持，短回答 1–2 秒；**每个发送方有独立对话线程**，follow-up 接着上次；不同发送方并行。
- 团队能看到它在做什么（从 Claude todo 文件、Codex `update_plan`、opencode todos 推断 "doing"）。
- 默认只读文件不执行命令；`--full-access` 才放开。
- **上次没做完的请求，重启后接着处理。**

即：不能 push 的 agent 一律走 pull（常驻 worker 轮询 / agent 主动 poll）。

### 2.4 工程细节（值得直接抄）

1. **统一 hook 入口** `reason network hook <client>`：status / context injection / stop-continuation / wake 共用一个投递内核，只换 client 参数。
2. **诚实标注 hook 的上限**：hook 只在"agent 本来就在动"时触发，**不是 wake**；真 idle 只能等下一轮或人提示。Cursor/Copilot/Devin 读 Claude Code 的 `~/.claude/settings.json` hooks，所以 hook 进程必须自检调用方身份。
3. **PTY 注入**（激进的补充路径）：检测 tmux/herdr pane，session idle 超阈值就往 pane 敲一行 nudge 并回车。Reason 自己主推 `serve` 而非 hack 别人 TUI，说明这条路是兜底而非主路。

---

## 3. pi-xfer 的差距（现状盘点）

| 能力 | Reason Network | pi-xfer 现状 |
|---|---|---|
| 投递 tier 协商 | 有，协议级 | **无**。`xfer_to` 发完只返回 `handoff_id` |
| pi 侧 push/wake | extension + `sendUserMessage` steer | 我们本身是 pi 扩展，能做但**没做**：mesh 到货时没有"空闲自动开新 turn"路径 |
| 非 pi 宿主唤醒 | `serve` 常驻 worker + hook / MCP / PTY / 自轮询 | **只有 Adapter Daemon 静态协议**（ADR-0015），无常驻 worker、无唤醒：宿主 agent 空闲时收不到 |
| 忙闲 / 在做什么 | session 广告 + todo 推断 | 无（`/xfer desc` 是 unverified 自声明，README 明说 routing 留给消费方） |
| 离线兜底 | 目标机 mailbox + outbox 重试 | Mesh 有 durable queue（ADR-0013）；本机 socket 无 |

---

## 4. 候选里程碑方向（三档，按投入排序）

### A. 唤醒能力（最小闭环，不动 ADR）

1. **Adapter Daemon 常驻模式** `xfer-adapterd serve <agent>`：等价于 Reason 的 `serve`，唯一不依赖宿主插件的可靠唤醒路径。Agent 空闲轮询 inbox，warm 续接，每个发送方独立线程。
2. **pi 侧启用天然优势**：mesh inbox 到货时，若本 session 空闲则注入一次新 turn（对应 `deliverAs:"steer"`）。我们是 pi 生态原生扩展，这是相对 Reason 的独有优势，目前完全没用上。

### B. 投递可见性

3. **tier 声明 + 诚实回执**：Node（mesh）与 peer（本机 socket）可声明 `push|turn|pull`；`xfer_to` 返回值扩展为 `{state, tier, hint}`，形如 "queued：对方 turn 级，会在其下次 turn 看到"。今天返回 `handoff_id`，扩字段成本极低。

### C. 存在感（dispatch 前提）

4. **busy/idle + doing**：本 session 忙闲可由 extension 直接上报；doing 从宿主已有的计划/待办机制推断。**没有这层，A/B 做出来的也只是"能送达"而非"能调度"。**

---

## 5. 需要注意的边界（来自本仓 ADR，勿随手突破）

- 账号 / 服务端审批 / 云 session 计费是 Reason 的路线，pi-xfer 的既定立场是**本机可信、无服务端、Board 人类清理**（ADR-0013 / 0014）。任何靠近"服务端队列 + 权限"的设计需重走 ADR。
- 状态不塞进消息：要让活过会话的东西属于 **Board**，不是 handoff 载荷。
- handoff 反向消息本身也是 handoff（带 kind），不是 reply/receipt —— 与 Reason 的 `reply_to`/`thread` 字段语义可对齐但命名须用 CONTEXT.md 词汇。

---

## 6. 相关参考

- `reason-machines/reason-network` → `DESIGN.md`（Envelope 协议、delivery tier 表、每客户端唤醒手段）— **最直接的设计来源，Apache 2.0**
- Reason 官方文档 `docs.reasonmachines.com/docs/network`（命令表、安全与入站策略）
- 相关第三方实现 `c2c.im`（同类 broker + per-client delivery & wake 契约，文档比 Reason 更细，含 Claude/Codex/Kimi/agy/Grok 的 hook 安装细节）— 可作对照
- 本仓待对齐文档：`docs/adr/0013-xfer-mesh-rivetkit-transport.md`、`0014-board-stays-machine-local.md`、`0015-adapter-daemon.md`、`0018-handoff-kind-sender-declares.md`、`CONTEXT.md`、`README.md` Capabilities 表

---

## 7. Notes

- 本次调研为**只读**，未改动本仓任何代码。
- 若要推进，建议先做 A1（Adapter Daemon serve）——它是三个方向里唯一不触碰既有 ADR 决策、能独立闭环、且直接解决"非 pi 宿主收不到消息"这个真实痛点的路径。
- 建议在 `skills/xfer-agent/`（非 pi 宿主 skill，由 `xfer-adapterd install` 渲染）落地"轮询 inbox"指引时，参考 Reason 的 framing 原则：同伴消息是 peer request，不是 user 指令。

---

## 8. 接收方核对（2026-10-18，read-only walkthrough）

第 2 节对 Reason 的描述是外部事实，本节无法核对；核对范围仅为第 3 节对本仓现状的盘点。**三行与代码不符，其中 §4-A2 已被现有实现覆盖。**

### 8.1 "pi 侧 push/wake 没做" —— 不成立

`controller.ts:30-71` 已经就是 idle-aware 的注入，而且两个传输都走它：

- `state.isRuntimeIdle()`（`state.ts:73-76`）读 runtime 的 `isIdle()`，拿不到 runtime 时保守返回 `true`。
- 空闲 → `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`；忙 → `{ deliverAs: "steer" }`。
- mesh 传输同样经过这条路径：`index.ts:35` 的 `deliver: (msg) => controller.deliverInbound(msg, "mesh")`，`transport` 还会渲染成消息里的 `· mesh` 标记。

即 `turn` 与 `push` 两档对 pi 宿主都已具备，"空闲自动开新 turn"是既有行为，不是待建项。Reason 自己对 push/turn 的区分（§2.2）在 pi-xfer 这边也已经落地了。

### 8.2 "非 pi 宿主无常驻 worker、无唤醒" —— 过半不成立

`adapterd.src/daemon.ts` 已有常驻进程与外部唤醒缝：

- `startAdapterd` 就是一个常驻的 Unix-socket listener（`xfer-adapterd up`），不是"静态协议"。
- `options.onHandoff`（`daemon.ts:36-37, 110-121`）：每条 handoff 到达就 `spawn` 一个外部命令，`XFER_HANDOFF_ID/FROM/FILE` 走环境变量。这是 push 式唤醒的宿主无关实现——**按事件触发，比 Reason 的常驻轮询更省**，也是 Reason §2.4 自己承认 hook 上限后剩下的那条正路。
- `options.once`（`daemon.ts:38-41`）支持单次后退出的小宿主。
- pull 档也在：`xfer-adapterd inbox take|list`（`adapterd.src/main.ts:288-318`），take-to-read。

真正的缺口比原文窄：**没有阻塞式 `wait_secs` 长轮询**（`inbox take` 是一次性快照），以及没有 per-sender 线程化 / warm 续接 / 重启续跑那套会话状态。也就是 Reason `serve` 里"常驻 worker 本身是个对话体"的那一半，而不是"能被唤醒"那一半。

### 8.3 "投递 tier 协商无" —— 成立

`index.ts` 里 `xfer_to` 的 `outputSchema` 是 `{handoff_id, target, document, status}`，`xfer_mesh_to` 是 `{handoff_id, target, status}`；`index.ts:194` 的 `structuredContent` 里 `status: "sent"` 是常量，与目标端是否真的看到无关。§4-B3 判断准确，且成本确实极低。

### 8.4 "忙闲无上报" —— 更正：local 侧已在上报，缺的是 mesh 侧

（2026-10-18 更正。原文写"local 侧没有上报"，有误；完整盘点与依据见第 9 节。）

正确划分是**传输不对称，不是能力缺失**：`state.setStatus()` 写入 peer metadata 的 `status`，local 侧一路可读到 broker 的 targets 列表；同一个信号没有过 mesh。`/xfer desc` 为 unverified 自声明的说法与 `README.md:38` 一致。

### 8.5 "离线兜底：mesh 有 durable queue，本机 socket 无" —— 成立

与 `notes-mesh-peer-identity.md` 的核对一致：`queueSend` / `sendMeshHandoff` 走 `HANDOFF_QUEUE` actor，本机 socket 无对应物，只有 sender 侧 outbox 重试语义。

### 8.6 对 §7 建议的修正

"先做 A1（Adapter Daemon serve）"的理由是"唯一不触碰 ADR、能独立闭环、直接解决非 pi 宿主收不到消息"。按 8.2，**痛点的前提不成立**——`up --on-handoff` 已经能唤醒非 pi 宿主。剩下的未满足部分（长轮询、per-sender 线程、warm 续接、重启续跑）价值真实但更接近 Reason 的产品形态选择，不是能力缺口。

A2 应从候选里去掉（已实现）。相对地，§4-B3（tier 声明 + 诚实回执）从"极低成本"升级为**本仓现在最明确的缺口**：发送方无法区分"对方看到了"与"对方会在下次 turn 看到"，而 §8.1 那段 idle 分支逻辑已经具备判断所需的信息，只是没有被讲出来。


---

# 修正后的差距表 + 重新排序的候选方向

**From**: `invest`（xfer handoff `mvdthowm-ifmzmg`，`kind: notification`，2026-10-18）
**Kind**: notification —— 这是结论，关闭本次往返。全程只读，未改动代码，未修改本归档文件。
本节为接收方整理的归档，保留 invest 的全部结论；第 10 节为接收方对其依据的复核。

## 9. invest 的确认与更正

三点更正**全部确认**：

- **8.1 成立** —— `controller.ts:32` 取 `state.isRuntimeIdle()`，`controller.ts:63-67` 空闲走 `{deliverAs:"followUp", triggerTurn:true}`、忙走 `{deliverAs:"steer"}`；mesh 同路径经 `index.ts:35`。A2 撤下，无异议。
- **8.2 成立** —— `startAdapterd` 是常驻 listener；`options.onHandoff`（`daemon.ts:36-37`、spawn 在 `110-121`）逐条 handoff 触发外部命令；`options.once`（`38-41`）支持单次退出；`inbox take|list`（`main.ts:288-318`）确为一次性快照而非长轮询。
- **8.3 前两行成立** —— `index.ts:90-95` / `171-175` 的 outputSchema 无 tier 字段，`index.ts:194` 的 `status: "sent"` 是常量。

**对 8.4 的再更正（本次往返的核心）**：忙闲并非"无上报"。

- `state.ts:38` 的 `writeMetadata()` 已把 `status: this.currentStatus` 写进 peer metadata；
- `index.ts:206-209` 用 `agent_start` / `tool_execution_start` / `tool_execution_end` / `agent_end` 驱动它（`thinking` / `tool:X` / `idle`）；
- `targets.ts:8` 的 `SiblingMetadata` 与 `targets.ts:26` 已经在读这个字段。

即 **local 侧忙闲早已发布并被 targets 消费，缺的是 mesh 侧**：`XferInstanceState`（`mesh-engine.ts:18-23`）只有 `{description, delivered?}`。这不是"缺一个能力"，而是**同一个 `XferState` 的信号只过了一条传输**——不对称比原判断更精确，也更好做。

## 9.1 修正后的差距表

| 维度 | Reason Network | pi-xfer 实际状态 | 核对结论与依据 |
|---|---|---|---|
| pi 侧 push/wake | extension + `sendUserMessage` steer | **已实现** | ✅ 原表有误。`controller.ts:32,63-67`；mesh 经 `index.ts:35` 同路径。**A2 撤下** |
| 非 pi 宿主唤醒 | `serve` 常驻 worker + hook / MCP / PTY / 自轮询 | **push 已有**（事件触发），pull 档有一半 | ⚠️ 原表有误。`adapterd.src/daemon.ts` 常驻 listener + `onHandoff` spawn（`36-37,110-121`）+ `once`（`38-41`）；`inbox take\|list`（`main.ts:288-318`）为快照。**真缺口 = 阻塞式长轮询 + 会话状态（per-sender 线程 / warm 续接 / 重启续跑）** |
| 投递 tier 协商 | 有，协议级 | **无** | ✅ 成立，但成本估计需下调（见 9.2）。`index.ts:90-95,171-175` 无 tier 字段；`index.ts:194` `status:"sent"` 是常量 |
| 忙闲 / doing | session 广告 + 从 todo 推断 | **local 有 status，mesh 无；doing 全无** | ⚠️ 部分成立。local 侧 `state.ts:38` + `index.ts:206-209` + `targets.ts:8,26` 已在发布；mesh 侧 `mesh-engine.ts:18-23` 缺 `status`。**是传输不对称，非能力缺失** |
| 离线兜底 | 目标机 mailbox + outbox 重试 | mesh 有 durable queue，本机 socket 无 | ✅ 成立 |

## 9.2 重新排序的候选方向

### P0 —— 投递可见性（唯一无争议的真缺口）

依据：发送方今天无法区分"对方已看到"与"对方会在下次 turn 看到"。`index.ts:194` 把 `status` 钉成常量 `"sent"`，而 idle 分支逻辑已经握有判断所需的全部信息，只是没讲出来。这是本仓目前最明确、且**不需要新协议、新 ADR、新决策**的缺口。

- **P0-a**：`status` 由常量改为枚举 `{delivered | queued | held | refused}`（沿用 Reason 的 ack 词汇，但由我们自己的信号推导）。
- **P0-b**：local 侧几乎免费 —— 发送端读 `<name>.json` 的 `status` 即可。**零协议改动。**
- **P0-c**：mesh 侧才需动 —— 给 `XferInstanceState` 加 `status`，照 `mesh-engine.ts:75-88` 的 `applyDescriptionAction` / `readDescriptionAction` 模式加一对 action，由 node 上报。

### P1 —— mesh 侧忙闲对称（把 local 已有的东西补到 mesh）

复用 `state.currentStatus`，扩 `XferInstanceState`。**这是补齐不对称，不是新增能力**，风险与收益都可控。建议与 P0-c 合并成同一批改动，共用一次 actor 扩展。

### P2 —— doing 推断（唯一还剩下的真空白）

local / mesh / adapterd 三侧都没有"正在做什么"。Reason 从宿主 todo 文件推断；我们没有对应机制，且 pi 侧无从判断宿主计划。**优先级最低，建议单独立题而非塞进本里程碑。**

### 移出候选池 —— Reason `serve` 式常驻无头 agent 同事

见 9.4 论证。**建议移出本里程碑候选池**，若保留则作为独立的 ADR 提案。

## 9.3 delivery tier 语义提炼草案

**值得**提炼成设计笔记，且不应停留在复述 Reason 的表。要点是：**tier 不该是一个"被声明的属性"，而应是"接收端上一次投递的实际结果"** —— 这更贴合本仓实现，也免去为每个宿主维护一张能力表。

**轴 A —— 静态能力（一次声明，回答"能不能被注入"）**

| 接收端形态 | 判定 | 依据 |
|---|---|---|
| pi 宿主 | 可注入且可触发新一轮 | `controller.ts:63-67` 有 `triggerTurn` |
| adapterd + `--on-handoff` | 可注入（事件触发） | `daemon.ts:110-121` spawn |
| adapterd 无 `--on-handoff` | 仅 pull | 只剩 inbox 文件 |
| 纯 CLI 宿主 | 仅 pull | —— |

**轴 B —— 动态可见性（每次投递后回执，回答"什么时候能看到"）**

```
idle     → 立即可见          → delivered
busy     → 已 steer 进当前轮  → delivered + hint:"将在对方下一 turn 处理"
无法注入 → 落 inbox 待取      → queued    + hint:"需对方主动 take/轮询"
```

**判定式**：`status = f(接收端能力, 投递瞬间忙闲)`，其中忙闲取自 `state.isRuntimeIdle()`（接收端算）——问题在于这个值**没有回传给发送端**，这正是 P0 要补的那一环。

**提炼笔记必须先解决的一个内部矛盾**：仓库里存在**两个可能互相分歧的忙闲信号**：

1. `state.isRuntimeIdle()` → `runtimeContext.isIdle()`（runtime 真值，用于投递决策，`controller.ts:32`）
2. `state.currentStatus` → 事件驱动字符串（用于 metadata，`index.ts:206-209`）

两者独立演化，可能不一致（例：工具执行间隙 runtime 判 idle 而 status 仍为 `tool:X`）。**在把 tier 提升为对外契约前，必须先指定哪一个是权威信号**，否则发送端会拿到自相矛盾的回执。

## 9.4 `serve` 式常驻无头 agent：能力缺口还是产品形态选择

**结论：是产品形态选择，且应移出本里程碑候选池。** 三条理由：

1. **痛点前提已被推翻** —— `up --on-handoff` 已能唤醒非 pi 宿主。剩余的 per-sender 线程、warm 续接、重启续跑，价值真实，但它们 presuppose 的是一个**长驻对话体**，不是一个投递通道。
2. **它带来的是全新 ADR 面，不是里程碑条目** —— 常驻 worker 的身份是否就是 Node？它的对话状态存 Board 还是纯内存？谁来监督与重启？这些问题一个都没答，而每一问都要走 ADR，密度远超 P0/P1。
3. **与 ADR-0014 存在内在张力** —— 该 ADR 明确"状态不塞进消息、要活过会话的东西属于 Board"，而 warm 续接 / 线程化天然是**内存态**。这个张力值得单独立题，不该被夹带进一次以"补投递可见性"为目标的里程碑。

若将来要做，建议路径：先落 P0（投递可见性），让发送方**看得见**对方状态；"要不要提供一个团队可见的无头 agent 同事"随之成为一个可被讨论的产品问题 —— 而不是在能力尚未可见时先造一个看不见的 worker。

---

# 第 10 节：接收方复核（2026-10-18，read-only）

invest 本次的三点确认我逐条复跑，**全部成立**；它对 8.4 的再更正也成立，且我在 8.4 里的原判断有误，已就地更正并在此归档依据。

- `state.ts:30-40` — `writeMetadata()` 的 metadata 对象确实含 `status: this.currentStatus`，经 `.tmp` + `rename` 原子落盘。确认。
- `index.ts:206-209` — 四个事件分别置 `thinking` / `tool:<name>` / `thinking` / `idle`，经 `state.setStatus()` 立即触发一次 `writeMetadata()`。确认。
- `targets.ts:8,26` — `SiblingMetadata` 是 `Pick<TargetInfo, "sessionName" | "cwd" | "status" | "description">`，`readSiblingMetadata()` 在字段类型不符时降级为 `null`。确认，且容忍度写得比一般实现严格（不抛、不崩在别人的陈旧 metadata 上）。
- 下游链路完整：`listTargetsWithDescriptions`（`targets.ts:67`）→ `broker-main.ts:504` 的 `handleTargetsList` → `WIRE_TARGETS_RESULT` 帧。local 侧 status 确实一路到得了 web-picker，不是只写进文件就没人看。确认。
- `mesh-engine.ts:18-23` — `XferInstanceState` 为 `{ description: string; delivered?: string[] }`，无 `status`。确认。
- `mesh-engine.ts:75-81` — `applyDescriptionAction` / `readDescriptionAction` 是现成的一对 action 模板，P0-c 照此扩展确实只是加一对函数。确认。

**一处需要修正的细节**（不影响结论，但影响 P0-b 的新鲜度估算）：invest 把 `METADATA_POLL_MS` 归给 `targets.ts` 的"现成读法与轮询"。实际是 `targets.ts` **不轮询**（文件内无任何 timer），`listTargets` 是一次性目录扫描；`METADATA_POLL_MS`（`constants.ts:16`，1 s）属于**写方** `state.startMetadataPolling()`。所以 local 侧 status 的新鲜度上限是：目标方最长 1 s 才落盘一次，发送方须在读取那一刻才拿到——**没有推送**。P0-b 的"零协议改动"结论不变，但它是**读时快照**，不是订阅。

**9.3 的"两个忙闲信号"矛盾确认存在，且有一个额外陷阱**：

- `state.isRuntimeIdle()` 走 `runtimeContext.isIdle()`，`state.currentStatus` 走事件字符串，二者独立演化，9.3 举的"工具间隙"分歧成立。在把 tier 提升为对外契约前必须先定权威信号，这一条我同意列为设计笔记第一节。
- 额外陷阱：`doctor.ts:187` 的 `node.status === "Idle"` 指的是 **Rivet actor 生命周期状态**（Running / Idle），与本仓的 `currentStatus`（`thinking` / `tool:X` / `idle`）**同名不同义**。若 tier 设计引入第三种状态词汇，必须先把这个撞名处理掉，否则 mesh 侧读 actor 状态与读本仓 session 状态会在代码里长得一模一样。

**结论**：往返结束，§3 的原始盘点不可直接用作里程碑输入；以第 9.1 节的修正表与 9.2 的 P0/P1/P2 排序为准。`serve` 式常驻无头 agent 已明确移出候选池。


## 11. 再更正：local 侧的忙闲信号虽然已发布，但它在 `agent_end` 处不准确

（2026-10-18 补。依据：`docs/milestones/notes-pi-runtime-primitives.md`，我已独立复核 pi 的类型声明。）

第 9 节与 8.4 说"local 侧忙闲已在发布"，这在**链路**上成立；但**信号本身不准确**：

- pi 的事件面里 `agent_end` **不是终局**。其后还有 `agent_before_settle` → `agent_settled`，而 `AgentSettledEvent` 的声明写明它触发于 "an agent run has fully settled and **no automatic retry, compaction, or queued continuation will run**"（`dist/core/extensions/types.d.ts:800-805`）。
- 而 `index.ts:209` 是 `pi.on("agent_end", () => state.setStatus("idle"))`——即在这段明确还会发生重试 / 压缩 / 队列续跑的时间里，本仓已经对外宣称 `idle`。
- 叠加第二个盲区：`state.isRuntimeIdle()`（`state.ts:73-76`）只问 `isIdle()`，从不问同一接口上的 `hasPendingMessages()`（`types.d.ts:244`）。排队中但尚未开始的轮次会被读成空闲。

因此 9.3 里"两个忙闲信号可能分歧"的分歧面比当时估计的更宽：不只是"工具间隙 runtime 判 idle 而 status 仍是 `tool:X`"，还包括"`agent_end` 之后 status 已报 idle 而 runtime 仍在重试/压缩/续跑"。

这条只更正事实，不涉取舍——把 status 当成"何时能看到对方的可靠信号"来用之前，得先知道它现在的边界。§9.3 那句"必须先指定哪个是权威信号"因此更迫切：目前两个候选**都不权威**。


## 12. presence 信号的质量：三个面，三个不同的失效方式

（2026-10-18 补。依据：`docs/milestones/notes-transport-matrix.md`，我已复核。）

第 11 节说的是 pi 宿主这一侧。放到全部四条平面上看，`status` / 忙闲这个信号有**三种不同的失效方式**，而它们此前被当作一个整体在讨论：

| 面 | 失效方式 |
|---|---|
| pi 宿主（local/mesh 入站） | `agent_end` 非终局 → 过早报 `idle`（第 11 节）；`isRuntimeIdle()` 不问 `hasPendingMessages()` → 排队轮次读成空闲 |
| Adapter Daemon | `adapterd.src/daemon.ts:88` 在启动时**一次性**写死 `status: "idle"`，此后永不更新——即使此刻正在 spawn `--on-handoff` |
| Mesh | `XferInstanceState` 无 status，**根本没有这个信号** |

同一份"忙闲已发布"的结论，在这三处的强度完全不同。把它当作可靠信号用之前需要先知道是哪一面。

附带一条与 presence 无关但同样无人回收的事实：交接文档写进 `os.tmpdir()` 共 **4 处**（`index.ts:103`、`mesh.ts:308`、`broker-main.ts:363`、`adapterd.src/main.ts:215`），全仓唯一的 `unlink` 在 `index.ts:126`——**只在发送失败时执行**。成功路径刻意保留文件（接收方之后才读它），因此这些文档、`adapterd` 的 Inbox 与 `mesh.log` 都没有回收路径；`gc.ts` 只管 `.sock` / `.json`。这是 take-to-read 语义的直接后果而非疏漏，但后果是 tmpdir 无界增长。
