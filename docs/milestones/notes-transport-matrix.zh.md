> 中文版 · 英文原文：[notes-transport-matrix.md](notes-transport-matrix.md)

# 传输矩阵 —— 研究输入（树中每个消息表面的端到端能力）

来源：由 `pi-xfer` 项目（分支 `main`）中的 pi 会话直接进行的只读代码走查，2026-10-19。除本文件外没有创建或修改任何文件。没有启动 engine，没有接触 tunnel/relay，`XFER_ALLOW_REMOTE` 从未被设置，没有运行任何测试 —— 只读了源码和树自带的 hermetic 测试文件。术语遵循 `CONTEXT.md`（Mesh / Node / Runner / pool / Delivery verdict / Adapter Daemon / Inbox / Board / Card / Entry / Web Picker / Marker / Pick / Record / Handoff / Notification / Task / peer）。

范围：本文件是一份事实清单，不是决策。它记录**每个传输今天做什么**、**发送者能从中得知什么**、**消息在接收侧会发生什么**、**该通道在结构上做不到什么**，以及**失败时产生什么错误文本**。不做排序、不给建议、不提 ADR。凡实现与已定 ADR 存在张力之处，作为悬而未决问题记入 §9。

## 1. 六个表面，一图总览

| # | 表面 | 方向 | 入口 |
|---|---|---|---|
| A | 本地 Unix socket（peer） | 单向 Handoff，按条 | `xfer_to`（`index.ts:74`）、`xfer-adapterd send`（`adapterd.src/main.ts:169`） |
| B | Mesh（RivetKit） | 单向 Handoff，按条 | `xfer_mesh_to`（`index.ts:158`）、`/xfer mesh <name> <request>`（`commands.ts:444`）、`xfer-adapterd mesh send`（`adapterd.src/main.ts:236`） |
| C | broker + Web Picker（页面 → agent） | 单向 Handoff，由页面发起 | `annotation.submit`（`broker-main.ts:333`） |
| D | broker 页面工具（agent → 页面） | 同步请求/响应 | `POST /page-tool`（`broker-main.ts:699`）、CLI `broker-main.ts page-tool`（`broker-main.ts:956`） |
| E | Adapter Daemon Inbox | 单向 Handoff，非 pi 宿主 | `xfer-adapterd up`（`adapterd.src/daemon.ts:82`）、`inbox take\|list`（`adapterd.src/main.ts:288`） |
| F | Board | append-only 的 Card Entry，由人指挥 | `/xfer board …`（`commands.ts:475`、`board.ts:84`） |

A/B 是同一 Handoff 协议的两个传输；C 在接收段搭 A 的车；D 是树中唯一不是 Handoff 的通道；E 是同一套 A/B 线上格式换一个接收者；F 根本不携带消息。

---

## 2. 行 A —— 本地 Unix socket（peer）

**端到端路径。** 发送工具按传输分叉，然后把一行 JSON 交给 peer 的 socket 文件。

1. `xfer_to` 生成 `msgId()`，把 Kind + 发送者 cwd 锚点盖进文档，写到 `os.tmpdir()/pi-xfer-<msg_id>.md`（mode 0600）（`index.ts:97-105`）。
2. `sendNotify` 解析 `endpointForName(target)` = `<xfer-dir>/<encoded>.sock` 并对其 `net.createConnection`（`client.ts:12-20`）。
3. 连接后写一行 JSON `{type:"xfer-notify", msg_id, from, file, summary}` 并布防 ack 计时器（`client.ts:47-51`）。
4. 接收方的 `createServer` 逐行解析 JSON，对 `type === "xfer-notify"` 且 `msg_id` 为字符串的帧调用 `delivery.deliver(msg)`，之后才在同一 socket 上写 `{type:"ack", msg_id}`（`server.ts:36-39`）。
5. `XferController.deliverInbound` 经 `pi.sendMessage({customType:"xfer-inbound"}, …)` 把消息渲染进会话，感知 idle：idle 时 `followUp + triggerTurn: true`，busy 时 `steer`（`controller.ts:30-70`）。文档正文**不**内联进消息 —— agent 得到 `Doc` 路径并被要求去读（`controller.ts:41-45`）。

**确认语义。** 恰好一次 ack，且是可能的最粗粒度：字节被解析并交给了 `deliver()`。ack 除回显的 `msg_id` 外什么也不带（`server.ts:38`）。它不说明模型是否看到了消息、文档是否被读、会话是否空闲。`client.ts` 在匹配的 ack 上 resolve（`client.ts:78-82`）。该通道上没有其他任何东西被确认。反向 Handoff（Task 结论）是*反方向的一条新 A 消息*，不是回复帧 —— ADR 0018 把 Kind 定为文档的属性，而 `controller.ts:60-64` 只是对模型下指令，不携带返回通道。

**持久化。** 没有持久。文档永远留在 `os.tmpdir()`（`index.ts:103`）；发送者只在发送*失败*时删除它（`index.ts:120`），于是每次成功的 handoff 都向临时目录泄漏一个文件。`gc.ts` 中没有针对 `pi-xfer-*.md` 的回收路径 —— `gc.ts` 只管 `<name>.sock` / `<name>.json`（`gc.ts:18-24`、`gc.ts:117-155`）。入站消息本身只以注入的对话内容的形式存在。若接收进程在写文档与 agent 读它之间死掉，内容按指针不可达，但在操作系统清理 temp 之前一直在磁盘上。

谁来清理：仓库里没有人。Board 清理是显式的人工动作（`board.ts:202-213`）；peer socket 清理是 `/xfer gc`；临时文档没有属主。

**能力上限。**

- 无缓冲：目标在发送时必须既有活的 socket 文件*又有*监听者。存在性检查是 `fs.existsSync(endpoint)`（`client.ts:15`）—— 崩溃 peer 留下的过时 `.sock` 能通过它，然后在 connect 时失败。
- 除文件系统名字外无寻址。`xfer_to` 到不了 Mesh Node、没在跑本地监听的 Adapter Daemon、网页或 Board。
- 无回复关系：没有 `reply_to`/thread 字段（`types.ts:15-21` —— `XferNotifyMessage` 就是 `{type, msg_id, from, file, summary}`，仅此而已）。
- 每帧 1 MiB，超限即销毁 socket（`server.ts:18-21`），所以*文档不在帧里* —— 只有它的路径，这就是该通道不能跨机器的原因。

**Busy/idle 可见性。** 发送者可以在发送前读 `<name>.json`，`targets.ts:18-33` 暴露 `sessionName`/`cwd`/`status`/`description`。`status` 是接收方自己的事件驱动字符串（`thinking` / `tool:X` / `idle`），由 `state.setStatus` 写入（`index.ts:206-209`、`state.ts:38`）。但 **ack 不携带它**：事先没读文件发送者从发送本身对接收者状态一无所知。元数据是读时快照 —— 写方以 `METADATA_POLL_MS` = 1 秒轮询（`constants.ts:16`、`state.ts:56-59`），而 `targets.ts` 自己不做轮询（`targets.ts:57-73`）。

**失败模式（实际文本）。**

| 条件 | 文本 | 来源 |
|---|---|---|
| 无 socket 文件 | `peer "<target>" not found` | `client.ts:17` |
| 无监听 / 连接失败 | 原始 `net` 错误（如 `connect ECONNREFUSED …`） | `client.ts:83` |
| 连接过慢（5 秒） | `connect timeout` | `client.ts:25-27`、`CONNECT_TIMEOUT_MS` `constants.ts:13` |
| 帧已写、无 ack（5 秒） | `ack timeout` | `client.ts:51`、`ACK_TIMEOUT_MS` `constants.ts:14` |
| 对端先关闭 | `peer closed before ack` | `client.ts:85-87` |
| ack 无法解析 | `invalid ack` | `client.ts:66-74` |
| ack 超过 1 MiB | `ack frame too large` | `client.ts:55-58` |

`xfer_to` 包装以上全部：`xfer: failed to notify "<target>" — <message>`，并在消息匹配 `/not found/` 时追加一段长提示，解释 web-picker 发送者不是 agent（`index.ts:122-127`）。工具的 `structuredContent.status` 在成功时是**常量** `"sent"`（`index.ts:151`）—— 它完全不由 ack 推导。

---

## 3. 行 B —— Mesh（RivetKit）

**端到端路径。**

1. `MeshNode.up` 解析配置、构建 engine、列出 Node、拒绝同名的 `Running` actor、检查 pool 匹配，然后 `ensureNode`（`mesh.ts:145-190`）。
2. `createRivetEngine.ensureNode` 加载原生 addon，定义 `xfer-instance` actor，`state = {description, delivered}`，actions `setDescription`/`getDescription`，队列 `handoff`，一个跑 `c.queue.iter()` 的 `run` 循环，以及 `setup({… noWelcome, logging: baseLogger, envoy.poolName})`（`mesh-engine.ts:224-262`）。
3. 发送：`MeshNode.send` → `engine.preflight(target)` → `engine.queueSend`（`mesh.ts:239-250`）。`queueSend` = `client.get(XFER_INSTANCE_ACTOR, [target]).send(HANDOFF_QUEUE, message, {signal: AbortSignal.timeout(30_000)})`（`mesh-engine.ts:300-306`，超时 `mesh-engine.ts:188`）。
4. 接收：actor 的 `run` 循环对照 `state.delivered` 去重（`mesh-engine.ts:239-246`），调用 `onHandoff(message.body, selfKey)`，然后记录投递（`mesh-engine.ts:247-248`；窗口大小 3，`mesh-engine.ts:32`）。
5. `MeshNode.onHandoff` 拒绝误路由（`message.to !== selfKey`），否则把内联文档写到 `os.tmpdir()/pi-xfer-<id>.md` 并调 `deliver`（`mesh.ts:303-323`）。
6. `index.ts:35` 把 `deliver` 接到 `controller.deliverInbound(msg, "mesh")` —— **与本地完全相同的管线**，只在头部追加 `· mesh`（`controller.ts:33`、`controller.ts:58`）。

**确认语义。** 三值，且是刻意的。入队要么返回（engine 把消息收进了目标 actor 的队列），要么抛出 `MeshSendError`，其 `kind` 是对失败的分诊（`mesh-engine.ts:341-360`）：

- `not-delivered` —— engine 应答了 `guard.actor_ready_timeout`；什么都没进队列（`mesh-engine.ts:352-355`）。
- `unknown` —— 入队从未被应答（客户端等待过期 / 连接断开）；它可能仍会到达（`mesh-engine.ts:356`）。
- `failed` —— 任何其他拒绝（`mesh-engine.ts:357`）。

入队之前，`preflightMeshSend` 以 6 秒期限对 `/actors` + `/envoys` 做一轮 engine 询问（`mesh-engine.ts:436-441`、`PREFLIGHT_TIMEOUT_MS` `mesh-engine.ts:510`）。它对"pool 无 runner"、"engine 未应答 /envoys"、"无此 Node" 抛 `MeshPreflightError`（`mesh-engine.ts:520-600`）。preflight 命中意味着**什么都没发** —— 一个严格强于行 A 任何表述的陈述。

尽管如此，这些分支没有一个是投递确认。接收 agent 是否读了消息对发送者不可见，与行 A 完全一样。接收方的 `state.delivered` 窗口（3 个 id）用于抑制重投（`mesh-engine.ts:26-32`），不是回执 —— 没有 action 把它暴露给发送者。

**持久化。** 消息在 engine 上目标 actor 的队列内是持久的；ADR 0013 记录该缓冲只在目标 actor 被创建后才存在。在接收机器上，文档写到 `os.tmpdir()/pi-xfer-<id>.md`（`mesh.ts:308-309`）且从不删除 —— 与行 A 相同的泄漏。`mesh.log` 记录 id、Node 名、字节数和文档路径，从不记录正文（`docs/dev/mesh-log.md`，"Handoff bodies never reach the log"），且 append-only，`mesh-log.ts` 中任何地方都没有轮转（`mesh-log.ts:22` 起的各 append 辅助函数）。谁来清理：没有人；`mesh.log` 无界增长，且被文档定位为人读文件。

**能力上限。**

- 单向。Task 的结论是反方向的一条新 Mesh Handoff。
- 文档是静态快照：ADR 0013 为 mesh 投递移除了 web-picker 的"Follow-up channel"一节，即 **mesh handoff 没有反向查询通道**。（注意 `handoff-doc.ts:122-135` 只要传了 `brokerCliPath` 就总渲染该节；移除是由构建 mesh 文档的调用方完成的，不是渲染器。）
- pool 无 Runner 的 Node 收不到，但仍在列表中：verdict 词汇表（`Running` / `Sleeping` / `NoRunner` / `Mismatch` / `Crashed` / `Pending` / `Unknown`，`mesh-engine.ts:407`）是 actor 记录与 `/envoys` 的*派生*联查，CONTEXT.md 禁止把它称作状态。
- `MESH_NODE_DESCRIPTION`（≤ 500 字符，`mesh-engine.ts:36`）是唯一的自我声明字段。`XferInstanceState` 是 `{description, delivered?}`（`mesh-engine.ts:17-24`）—— **没有 status、没有 busy/idle、没有 doing**。
- `down()` 销毁 actor，连同排队中的 handoff 和 description（`mesh.ts:194-217`）；ADR 0013 接受这一点。
- 无加密：ADR 0019 裁定 payload 在传输与落盘时均为明文，TLS 是部署属性。

**Busy/idle 可见性。** `async state()` / `nodeState(target)` 给出 delivery verdict（`mesh.ts:112-125`），即 `/xfer mesh list` 渲染的内容（`mesh-status.ts:51-130`）。那是可用性，不是 busy/idle。本地 `currentStatus` 信号只存在于行 A 的元数据文件里，从不跨到 Mesh（见 §8，悬而未决问题 1）。

**失败模式（实际文本）。**

| 条件 | 文本 | 来源 |
|---|---|---|
| 不在线（工具） | `mesh is not online — run /xfer mesh up first` | `mesh.ts:245`、`mesh-engine.ts:301` |
| 目标无 actor | `mesh: no mesh node named "<target>" on the engine — … Nothing was sent` | `mesh-engine.ts:592-598` |
| 目标 actor 活着，pool 无 Runner | `"<t>" is online but cannot receive: no runner in pool "<pool>". Nothing was sent — start a runner for pool "<pool>" …` | `mesh-engine.ts:522-527`、补救 `mesh-engine.ts:437` |
| actor 读作 idle 但 pool 有 Runner | 仅警告：`"<t>" reads idle (no runner) … the engine places it on the next send` | `mesh-engine.ts:528-536` |
| Preflight 够不到 engine（6 秒） | `mesh: could not check "<t>" before sending — engine did not answer /actors + /envoys within <ms> ms (…). Nothing was sent; the check is deliberately fail-closed …` | `mesh-engine.ts:573-583` |
| `/envoys` 未应答 | `mesh: could not check "<t>" … engine did not answer /envoys … Nothing was sent` | `mesh-engine.ts:584-590` |
| 入队被拒（`actor_ready_timeout`） | `enqueue to "<t>" was refused by the engine (engine said: …): no runner is serving the target's pool, so handoff <id> never entered its queue and nothing was sent` | `mesh-engine.ts:717-723` |
| 入队无应答 | `enqueue of handoff <id> to "<t>" got no answer before the client stopped waiting (…), so delivery is UNKNOWN — the engine may have accepted it and may still deliver it once a runner appears` | `mesh-engine.ts:726-732` |
| 任何其他拒绝 | `enqueue of handoff <id> to "<t>" failed (…), and whether it reached the target is unknown` | `mesh-engine.ts:734` |
| `up` 与 Running 属主冲突 | `mesh node "<name>" is already Running on another host — run /xfer mesh down there first (先在那边 /xfer mesh down)` | `mesh.ts:168-171` |
| `up` 收养另一 pool 的 actor | `mesh node "<name>" was placed in <actual> but this config targets <desired> — an existing actor cannot change pools. …` | `mesh.ts:286-292` |
| 接收时误路由 | 作为 `⚠️ mesh misroute: handoff <id> from "<from>" was addressed to "<to>" but reached "<self>" — refusing to deliver it here` 注入会话 | `mesh.ts:334-352` |

`xfer_mesh_to` 原样重抛各 `MeshSendError` kind，使分诊措辞得以保留（`index.ts:197-198`）；其他错误加前缀 `xfer mesh: could not send to "<target>" — <message>`（`index.ts:199`）。`structuredContent.status` 又是常量 `"sent"`（`index.ts:194`），可选的 `warning` 放在 `details` 里（`index.ts:193`）。

---

## 4. 行 C —— broker + Web Picker（页面 → agent）

**端到端路径。**

1. userscript 打开 `ws://127.0.0.1:<port>/ws`，发送带稳定 tab id 的 `hello`，收到 `welcome`（`broker-main.ts:817-832`）。
2. `annotation.submit` 携带 `{id, page, picks, prompt, target:{namespace:"local",name}, record?}`（`docs/dev/web-picker.md`，线上表）。
3. broker 校验（`broker-main.ts:341-360`），拒绝非 `local` 命名空间（`broker-main.ts:366-369`），生成 `msg_id`，从 Picks（+ 可选 Record）为**目标自己的 xfer 名字**渲染 handoff 文档（`broker-main.ts:371-388`），写到 `os.tmpdir()/pi-xfer-<msg_id>.md`（`broker-main.ts:392-397`），并为反向通道记住 `latestHandoffByTarget` / `latestTabIdByTarget`（`broker-main.ts:400-408`）。
4. 然后把**行 A 用的同一 `xfer-notify` 帧**推给目标的本地 socket，`from` 盖为 `"web-picker"`（`broker-main.ts:410-418`、`wire.ts:78`），仅在收到 ack 后向 tab 发 `ack{handoff_id, doc}`（`broker-main.ts:419-424`）。
5. 接收侧：与行 A 相同，只是 `controller.ts:46-60` 检测 `from === FROM_WEB_PICKER`，**抑制 cwd 戚标**（浏览器没有工作目录），并注入一条明确指令：不要用 `xfer_to` 回信，改用页面工具 CLI，附可运行的命令行。

**确认语义。** 两层嵌套 ack，都粗：

- broker→tab 的 `ack{handoff_id, doc}` 意味着"peer socket ack 了" —— 即行 A 的 ack 已收到。它仍不意味着 agent 看到了任何东西（`broker-main.ts:419-424`）。
- 失败时 tab 得到 `error{code}`：socket 文件缺失时 `target_not_found`，否则 `delivery_failed`（`broker-main.ts:425-435`，`pushXferNotify` 的分类在 `broker-main.ts:258-266`）。

没有任何东西告诉页面投递被*读*了。反向查询通道（行 D）是 agent 应答的唯一途径，而那是另一个协议。

**持久化。** 渲染出的文档落在 `os.tmpdir()`（0600），且投递失败也显式保留（`broker-main.ts:246-248` 注释；`broker-main.ts:433` 记录 `doc kept at`）。没有 `pi-xfer-*.md` 回收器。submit 本身不落盘：`latestHandoffByTarget` 和 `latestTabIdByTarget` 是无淘汰的内存 map（`broker-main.ts:530`、`broker-main.ts:543`），所以 broker 重启后忘了哪个 tab 拥有哪个目标，follow-up 退化为广播（`broker-main.ts:600-604`）。

**能力上限。**

- 页面只能寻址**本地**目标：`namespace !== "local"` 被直接拒绝（`broker-main.ts:366-369`）。ADR 0013 让 web-picker/broker 永久远离 engine。
- submit 是一次性的。`annotation.compose` 渲染同一文档但不写入不通知（`broker-main.ts:436-478`）—— 给完全没有 xfer 的宿主的复制-prompt 路径；由此产生的文档刻意**没有** Follow-up channel（`docs/dev/web-picker.md:237-240`、`web-picker-offline-doc.test.ts:1-7`）。
- 反向通道绑定于来源/页面权限：在策略封锁 websocket 的站点上，picker 在本地组稿并隐藏发送按钮（`docs/dev/web-picker.md:218-240`）。
- 写操作（`dom.click`、`dom.setValue`）按 origin 门控，并拒绝 picker 自身 overlay 内部的目标（`docs/dev/web-picker.md:262-275`）。

**Busy/idle 可见性。** `targets.list` 返回 `listTargetsWithDescriptions`（`broker-main.ts:498-508`）：本地 socket 文件外加尽力而为的 `sessionName`/`cwd`/`status`/`description`（`targets.ts:57-73`）。于是页面看到的是行 A 的状态串。它对 Mesh Node 一无所知 —— `description` 字段是*按本地目标查到的 mesh actor description*（`mesh-describer.ts`，经 `targets.ts:76-96`），不是 mesh Node 列表。没有本地 socket 的 mesh Node 永远不出现在 picker 里。

**失败模式（实际文本/代码）。**

| 条件 | 应答 | 来源 |
|---|---|---|
| 缺 prompt/picks/target.name | `error{invalid_payload}` `missing or invalid: …` | `broker-main.ts:352-356` |
| `record` 畸形 | `error{invalid_payload}` `malformed record: expected {id, start, events:[{seq,t,kind}…]}` | `broker-main.ts:357-360` |
| 非 local 命名空间 | `error{bad_target}` `namespace "<ns>" out of scope (v0: local only)` | `broker-main.ts:368` |
| picks 畸形 | `error{invalid_payload}` `malformed picks: …` | `broker-main.ts:389` |
| 文档写入失败 | `error{delivery_failed}` `cannot write doc: …` | `broker-main.ts:394-397` |
| 目标 socket 缺失 | `error{target_not_found}` `peer "<target>" not found` | `broker-main.ts:258-261` |
| 任何其他 socket 失败 | `error{delivery_failed}`，带 socket 自己的消息 | `broker-main.ts:264-266`、`broker-main.ts:425-435` |
| `hello` 之前发帧 | `error{auth_failed}` `hello first` | `broker-main.ts:836-841` |
| 未知帧类型 | `error{unsupported_version}` `unknown frame type <t>` | `broker-main.ts:846` |

---

## 5. 行 D —— broker 页面工具（agent → 页面，唯一的同步通道）

**端到端路径。**

1. Agent 运行 `node broker-main.ts page-tool <target> <op> [paramsJSON]`（`broker-main.ts:956-1045`），它从 `broker.json` 读端口并向 `/page-tool` `POST` `{target, tool:{op, params?}, timeoutMs?}`（`broker-main.ts:1003-1024`）。
2. `handlePageToolHttp` 校验并调 `runPageTool`（`broker-main.ts:700-780`）。
3. `routePageTool` 选 tab：若为该目标提交最新 handoff 的 tab 仍连着就选它，否则向每个已 welcome 的 tab 广播（`broker-main.ts:591-604`）。它发出 `page.request{id, handoff_id, from, tool, timeoutMs}` 帧并登记一个带计时器的 pending 项（`broker-main.ts:606-638`）。
4. 页面运行固定 op 之一（`wire.ts:32-44`：`page.info`、`dom.query`、`dom.html`、`console.logs`、`network.log`、`network.sse`、`framework.inspect`、`dom.click`、`dom.setValue`、`page.wait`）并应答 `page.response{id, ok, text|error}`。
5. `handlePageResponse` 按 id 关联；**第一个应答胜出**，迟到或未知的应答被记录后丢弃，不回任何帧（`broker-main.ts:670-687`）。
6. HTTP 层返回 `{ok:true, result:<parsed JSON>}`，文本不是 JSON 时返回 `{ok:true, text}`，否则 `{ok:false, error}`，HTTP 200（`broker-main.ts:760-775`）；CLI 在 stdout 打印 JSON 并退出 0，或在 stderr 打印错误并退出 1（`broker-main.ts:1027-1036`）。

**确认语义。** 这是树中唯一有真正往返的表面：调用者阻塞直到页面应答或期限到达，且应答就是页面自己的 payload。ack 按调用计且携带内容。

**持久化。** 双侧皆无。`pendingPageRequests` 是内存 map，仅在已结算项超过 128 时修剪（`broker-main.ts:551-553`、`broker-main.ts:572-582`）。页面把 console/网络数据放在常开的环形缓冲（200 条），SSE 内容在 1 MB 预算下（`docs/dev/web-picker.md`，Record-mode 一节）—— 有界、在页面内、刷新即失。任何结果都不落盘。

**能力上限。**

- 固定 op 表，无自由代码、无 eval（`wire.ts:26-45`）。
- 绑定到活 tab。`no_tabs` 立即返回且**不创建任何请求**（`broker-main.ts:592-596`、`broker-main.ts:655-658`）。
- 该通道里的目标名是*本地* xfer 名，不是 mesh Node —— broker 只认识本地 tab。
- 入站（页面→broker）的 `page.request` 是协议误用，被静默记录（`broker-main.ts:780-783`）。
- 1 MiB 请求上限 → HTTP 413 `payload_too_large`（`broker-main.ts:713-720`）。
- ADR 0007 禁止任何重放路径；record 的存在是为了*被 agent 读*，不是被重放。

**Busy/idle 可见性。** 对 agent 侧一无所知。broker 知道 tab 数（`/status` 返回 `clients`，`broker-main.ts:850-855`）以及每个目标最后提交的 tab。页面是否前台、是否被节流、用户是否在键盘前，都不可见。

**失败模式（实际文本）。**

| 条件 | 文本 | 来源 |
|---|---|---|
| 无已 welcome 的 tab | `no_tabs` | `broker-main.ts:594`、`broker-main.ts:657` |
| 期限（默认 30 秒，`BROKER_PAGE_TIMEOUT_MS` 或按调用） | `timeout` | `broker-main.ts:635`、`DEFAULT_PAGE_TIMEOUT_MS` `broker-main.ts:526` |
| 未知/已结算的请求 id | `no_such_request`（进程内）；HTTP 路径记录并忽略 | `broker-main.ts:646`、`broker-main.ts:672-677` |
| broker 未运行 | CLI：`broker not running in <dir> (no broker.json)`，退出 1 | `broker-main.ts:1011` |
| broker 不可达 | CLI：`broker unreachable on 127.0.0.1:<port> (…)`，退出 1 | `broker-main.ts:1023` |
| body 非 JSON / 字段坏 | HTTP 400 `invalid_json`、`invalid_payload: …` | `broker-main.ts:723-755` |
| body 过大 | HTTP 413 `payload_too_large` | `broker-main.ts:714-719` |
| 页面拒绝（写操作无授权） | 页面应答 `ok:false` 带 `denied_op: …` → `{ok:false, error:"denied_op: …"}` | `docs/dev/web-picker.md:262-275` |

注意不对称性：`timeout` 对页面最终是否运行了 op 只字不提 —— 迟到的 `page.response` 被丢弃（`broker-main.ts:675-677`）。

---

## 6. 行 E —— Adapter Daemon Inbox

**端到端路径。**

1. `xfer-adapterd up` 经共享的 `createServer` 创建与扩展相同的本地 Unix-socket 监听（`adapterd.src/daemon.ts:188-190`），并写入带 `kind: "adapterd"`、`host`、`inbox` 字段的 peer 元数据（`adapterd.src/daemon.ts:84-99`）。
2. 到来的行 A 帧进入 `delivered(msg, "local")`；若给了 `--mesh`，一个 `MeshNode` 跑同一 actor 循环，其入站进入 `delivered(msg, "mesh")`（`adapterd.src/daemon.ts:192-215`）。
3. `delivered` 从 `msg.file` 读文档，向 `<dir>/<encoded>.inbox.jsonl` 追加**一条 JSONL 记录**，然后才运行可选的 `--on-handoff` 命令（`adapterd.src/daemon.ts:159-183`）。
4. `appendInbox` 是一次 `fs.appendFileSync`（`adapterd.src/inbox.ts:30-33`）；`takeInbox` 把文件改名挪开并在解析后删除，于是并发的追加落进一个新文件（`adapterd.src/inbox.ts:61-74`）；`listInbox` 只看不消费（`adapterd.src/inbox.ts:45-56`）。
5. `--on-handoff` 派生命令，记录在 stdin，环境变量里有 `XFER_HANDOFF_ID` / `XFER_HANDOFF_FROM` / `XFER_HANDOFF_FILE`（`adapterd.src/daemon.ts:114-146`）。派生失败被记录并吞掉。
6. `--once` 在第一份 handoff 投递后关闭 daemon（`adapterd.src/daemon.ts:177-181`）。

**确认语义。** 线上**原样复用行 A 的 ack** —— daemon 的 `createServer` 在 `deliver()` 返回后立即写 ack（`server.ts:36-39`）。于是对 adapterd 接收者而言，发送者在行 A/B 上的保证是"一条 JSONL 行被追加到了文件"。`--on-handoff` 的成功**不在** ack 里：派生发生在进入 ack 路径之后，其退出码永远到不了发送者。CLI 的 `send` 成功时打印 msg id，失败时打印 `❌ send to "<target>" failed: <msg>`（`adapterd.src/main.ts:222-226`）。

**持久化。** 这是唯一有接收侧存储的表面：每个 daemon 名一个 JSONL 文件，保存接收时抓取的**完整文档正文**（`adapterd.src/inbox.ts:11-25` —— `document: string | null`）。它是 take-to-read —— 一条记录被 `inbox take` 消费后即消失，且 ADR 0015 声明其背后没有持久存储设计。谁来清理：消费者经 `take`，或人经 `--inbox <path>`。`gc.ts` **不**碰 `.inbox.jsonl`（其跳过清单只有 `broker.json`/`settings.json`，`gc.ts:41`，且只看 `*.json` / `*.sock`，`gc.ts:126-133`）—— 于是被遗弃的 daemon 把它的 Inbox 连同其中的文档正文无限期留在磁盘上。

**能力上限。**

- `inbox take` 是一次性快照，不是长轮询：没有 `wait_secs`，没有阻塞读（`adapterd.src/main.ts:300-329`）。
- 没有按发送者的线程化、没有热续接、没有重启恢复 —— Inbox 是文件，不是对话。
- 带显式 `--name` 的 `inbox` 要求 daemon 的 socket 存在，否则报错而不是报告空 Inbox（`adapterd.src/main.ts:315-319`）。
- `url` 投递策略（HTTP POST）被刻意不实现，也未保留为标志（`adapterd.src/daemon.ts:112-114`，ADR 0015）。
- daemon 元数据的 `status` 是硬编码的 `"idle"`（`adapterd.src/daemon.ts:91`）—— 一个 adapterd peer 永远不报 `thinking`/`tool:X`。

**Busy/idle 可见性。** 与行 A 相同（元数据文件），只是值是常量 `"idle"`，因此不提供信息。`meshOnline` 暴露在句柄上（`adapterd.src/daemon.ts:52`）并打印在 up 横幅里（`adapterd.src/main.ts:180`）。

**失败模式（实际文本）。**

| 条件 | 文本 | 来源 |
|---|---|---|
| 本地发送，目标缺失 | 行 A 的 `peer "<target>" not found` | `client.ts:17` 经 `adapterd.src/main.ts:224` |
| Inbox 追加失败 | 日志：`[xfer-adapterd] inbox append failed for <id>: <err>`；记录**不**重试，ack 照发 | `adapterd.src/daemon.ts:170-174` |
| `--on-handoff` 派生失败 | 日志：`[xfer-adapterd] --on-handoff failed to spawn: <err>` | `adapterd.src/daemon.ts:130-132` |
| 缺 `--kind` | `❌ --kind must be "task" or "notification" — … a handoff that declares no kind reads as a notification and never comes back` | `adapterd.src/main.ts:208-210`、`adapterd.src/main.ts:270-272` |
| `up` 期间 mesh 加入失败 | daemon 回卷：关监听、unlink socket+元数据，然后重抛（`mesh up` 错误同行 B） | `adapterd.src/daemon.ts:201-215` |
| 有 `--mesh` 无配置 | `❌ --mesh requested but mesh is not configured — <err>` | `adapterd.src/main.ts:158` |
| `inbox` 且无 daemon | `no adapter daemon found in <dir> — start one with \`xfer-adapterd up\` or pass --name/--inbox` | `adapterd.src/main.ts:338` |
| `inbox --name` 指向死 daemon | `no daemon "<name>" — start one with \`xfer-adapterd up --name <name>\`` | `adapterd.src/main.ts:317` |
| 两个 daemon，无 `--name` | `multiple adapter daemons in <dir> — pass --name or --inbox` | `adapterd.src/main.ts:340` |

---

## 7. 行 F —— Board

**端到端路径。** 在 §2–§6 的意义上没有消息也没有传输。Card 是 `~/.pi/xfer/board/` 下的 Markdown 文件（`board.ts:8`）；Entry 是追加的 `### e-XXXX · type · author · timestamp` 小节（`board.ts:86-89`）。写入是两阶段且由人指挥：`/xfer board write <id> <intent>` 记录 `pending` 并注入 prompt（`commands.ts:558-570`），随后 `agent_end` 钩子从 assistant 回复中解析 fenced `board-entry` 块，创建 Card 或追加 Entry（`board.ts:248-276`、`board.ts:257-262`）。`read` 逐字注入 Card（`commands.ts:536-543`）。

**确认语义。** 唯一的"ack"是对人的通知：`🆕 <id> — <title> (e-0001 appended)` 或 `📥 <e-id> · <type> appended to <card>`（`board.ts:267-272`），或中止警告 `⚠️ board write aborted — no reply from the agent` / `— reply had no ```board-entry block; nothing written`（`board.ts:254-262`）。没有其他 agent 参与，所以没有可确认的对象。按设计没有正式确认步骤（CONTEXT.md，Conversation）。

**持久化。** Card 文件即存储。寿命直到人运行 `del` 或 `clean`（`board.ts:202-213`）；`gc.ts` 中没有任何东西碰 board 目录。并发写者无协调：`append` 读 card，然后把整个正文 `writeFileSync` 回去（`board.ts:238-243`）—— 两个会话同时追加可能丢一个 Entry。无锁、无原子改名。

**能力上限。**

- 无推送。agent 只在人注入时得知一张 Card；ADR 0009 禁止为 board 操作 `pi.registerTool`，ADR 0014 让 board 留在机器本地（跨机器共享是文件同步的事，不是代码）。
- 无寻址：Card 的每个 Entry 有 author 但没有收件人。
- 仅机器本地；没有 actor、没有队列、engine 不参与。
- Entry 类型只是元数据，不驱动任何逻辑（`board.ts:82-85` 解析、`board.ts:86-89` 渲染）。

**Busy/idle 可见性。** 无。没有东西观察别的 agent。

**失败模式。** 向不存在的 Card 追加时 `card not found: <id>`（`board.ts:241`）；`/xfer board read|write` 用未知 id 时通知 `❌ Card not found: <id> — see /xfer board list`（`commands.ts:534`、`commands.ts:551`）。对 front matter 缺 `id` 的 Card 做 `read` 静默返回 `null`（`board.ts:148`）。

---

## 8. 横切观察（是事实，不是评判）

1. **状态信号只跨一种传输。** `state.currentStatus` 写进 `<name>.json`（`state.ts:38`），由 `targets.ts:26` 为 picker 读回；`XferInstanceState` 没有 status 字段（`mesh-engine.ts:17-24`），adapterd 硬编码 `"idle"`（`adapterd.src/daemon.ts:91`）。这一不对称已在 `notes-reason-network-wake.md` §9 记录；上面的传输矩阵不是对它的修正 —— 是从发送侧再次到达同一结论。
2. **`status: "sent"` 在两个工具上都是常量**（`index.ts:151`、`index.ts:194`），与实际收到的 ack 无关。行 B 额外在 `details.warning` 里携带 preflight verdict（`index.ts:193`），常量并不反映它。
3. **四种不同的 ack 粒度并存：**

   | 表面 | ack 意味着 | 不覆盖 |
   |---|---|---|
   | A | 已解析并交给 `deliver()` | 被模型读 |
   | B | 被收进目标 actor 的队列（或 `unknown`） | 任何接收侧步骤 |
   | C | 行 A 的 ack 已收到 | 被模型读 |
   | D | 页面运行了 op 并返回 payload | op 在语义上是否成功 |
   | E | 一条 JSONL 行被追加 | `--on-handoff` 退出状态 |
   | F | 人的命令完成了 | 是否有任何别的 agent 会读它 |

4. **临时文档由三个表面写入、无人清理。** 行 A `index.ts:103`、行 B `mesh.ts:308`、行 C `broker-main.ts:363`。`gc.ts` 只管 socket 和元数据（`gc.ts:1-24`）。adapterd Inbox（`adapterd.src/inbox.ts:29-32`）和 `mesh.log`（`mesh-log.ts:98-110`）在树中同样没有回收器。
5. **误路由被浮出，不被纠正。** 行 B 拒绝投递并向*错误的* Node 会话注入一条 `⚠️` 消息（`mesh.ts:334-352`），而发送者已经看到入队成功。行 C 没有对应物：一帧寻址到某目标，其 socket 存在但监听者是另一个进程，会被文件背后的无论谁 ack。
6. **只有行 D 阻塞。** 其余每个表面都在接收者对内容做任何事之前返回。

## 9. 本矩阵未能确立的事

留给人类 Node 的悬而未决问题 —— 刻意不在此解决：

1. `XferInstanceState.status` 是否应当存在（行 B 经 delivery verdict 报告可用性但没有 busy/idle），以及两个本地 idle 信号哪个是权威 —— `state.isRuntimeIdle()`（`state.ts:73-76`）还是事件驱动的 `currentStatus`（`index.ts:206-209`）。两者原则上已经可能不一致（一个工具间隙可被一个读作 `idle`、另一个读作 `tool:X`）。
2. 临时文档泄漏（§8.4）是否要紧，鉴于没有 ADR 提及它。它不在 ADR 0013 或 0015 声明的边界之内。
3. `--on-handoff` 的退出状态是否应当到达发送者。今天 ack 写于派生结果可能存在之前（`adapterd.src/daemon.ts:159-183` 对 `server.ts:36-39`），所以这是协议问题，不是 bug 修复。
4. `latestTabIdByTarget` / `latestHandoffByTarget` 是否需要上限：两者都是只活在内存里的无界 map（`broker-main.ts:530`、`broker-main.ts:543`），不像 `pendingPageRequests` 在 128 处修剪（`broker-main.ts:551-553`）。
5. Board 的丢更新窗口（`board.ts:238-243`）在 ADR 0009 的"人指挥"前提下是否可接受 —— 本矩阵只记录没有锁存在。

## 核对与存疑

- 上文引用的每条 `file.ts:line` 都在本次走查中直接读过；行号是 `main` 上当前工作树的，且本目录中若干既有文档带着过时行号（见 `notes-mesh-peer-identity.md`，"Verification notes"），所以在后续提交之后宁可重读，不要相信这些数字。
- 未验证、因此未断言：(a) 对外来 `xfer-instance` actor 的 `getDescription` 探测是否可与离线目标区分 —— 与 `notes-mesh-peer-identity.md` 已标记的同一缺口；(b) broker 重启后 picker 的 userscript 侧行为（只读了 `docs/dev/web-picker.md:246-262`，未读 `web-picker.src/`，后者按 AGENTS.md 不在范围内）；(c) `latestTabIdByTarget` 是否可被一个为其不拥有的目标提交的 tab 投毒 —— 该 map 以取自帧 `target.name` 的 `targetName` 为键（`broker-main.ts:400-408`），从那里到 `xfer_dir` socket 存在性之间没有任何属主检查。
- 未演练：没有启动 engine、broker、daemon、admin 或 pi 会话；没有跑任何 `NODE_TEST_CONTEXT` 进程；`XFER_ALLOW_REMOTE` 未被设置。§2–§7 的一切都读自源码与 hermetic 测试的 fixtures，不来自观测到的运行。
- 值得注意的张力（只记录，不论证）：ADR 0013 说 mesh 文档是没有 Follow-up channel 的静态快照，但 `handoff-doc.ts:122-135` 只要给了 `brokerCliPath` 就无条件渲染该节。今天的移除靠的是 mesh 调用方不传它 —— 调用方约定，而非渲染器保证。
