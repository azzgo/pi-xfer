> 中文版 · 英文原文：[phase4-features.md](phase4-features.md)

# Milestone 4 — 通讯面：让投递可被看见（approved feature list）

> Brainstorm 于 2026-10-18 关闭,用户已批准。下一个节点:**design**。
>
> **条目 0 + 1 已设计。** `phase4-design-p0-p1.md`(ADR-0020)把条目 0 合并为
> 条目 1 的两个前置条件;下面注 1 所假设的排序是推导出来的,不是给定的。
> 条目 2–5 仍未设计。
>
> **本文件是什么。** 一份带证据的缺口清单。**本文件不是什么。** 一份解决方案清单。
> 下面每个条目只说明缺什么、以及关于成本已知什么;没有一个说明怎么建。
> 用户明确要求这里不预设任何特性偏好,因为设计讨论尚未发生。用户已经做出的决定
> 按决定记录。
>
> 证据链(全部本轮收集,只读,未改代码):
> `notes-reason-network-wake.zh.md`(投递 tier + 对 Reason 自身设计的外部调研)、
> `notes-transport-matrix.zh.md`(六个传输面,端到端)、
> `notes-pi-runtime-primitives.zh.md`(pi runtime 实际暴露什么)、
> `notes-external-protocols.zh.md`(A2A / MCP / Reason / c2c.im 图景与 ADR 兼容性)、
> `notes-coordination-semantics.zh.md`(threading、id、去重、并发)、
> `notes-identity-and-addressing.zh.md`(命名、可达性、凭证)。
> 对早先唤醒笔记的三处事实更正记录在它自己的 §8、§10、§11、§12 ——
> 读下面的缺口表之前先读那些。

## 这个里程碑为什么存在

跨 context 的 handoff 今天能用。它做不到的是告诉任何一方实际发生了什么。
五条独立的研究线,从五个不同的起点出发,汇聚到了同一句话上,而没有一条是在找它:

> 不要因为发送成功就假设对端读了你的消息。

c2c.im 是这么说的。Reason 的 DESIGN.md 说 MCP notifications 不是一条投递路径。
agents-mesh 用自己的话描述了同一个陷阱。在 pi-xfer 里,`xfer_to` 把
`status: "sent"` 作为**常量**返回(`index.ts:149`、`index.ts:194`)—— 一个无论目标是醒着、
睡着还是消失都完全相同的值。四种可用的确认粒度都止步于「它是否被看见」之前:

| 面 | 它的 ack 实际意味着什么 |
|---|---|
| 本地 socket | 已交给 `deliver()`(`server.ts:36-39`) |
| Mesh | 队列已接受,或 `unknown` —— 三种状态(`mesh-engine.ts:341-360`) |
| Broker(转发) | 复述本地 socket 的 ack |
| Adapter daemon | JSONL 追加成功;`--on-handoff` 命令的退出码从不回到发送方(`adapterd.src/daemon.ts:159-183`) |

这就是本里程碑关注的缺口。清单上其余一切要么是诚实回答它的前置条件,
要么是路上发现的另一个洞。

本里程碑的两个性质,都是有意为之:

- **它基本是增量的、本地的。** 没有新组件、没有 server、没有注册表、没有持久化。
  清单上没有任何东西触碰 ADR-0013(进程内、无独立 daemon、发现 = `listActors`)、
  ADR-0014(Board 保持机器本地)或 ADR-0015(Inbox 按构造即有损)—— 除了条目 3,
  它被明确停在 design 节点。
- **条目 1 的证据比条目 3–4 强得多。** 四个独立项目汇聚到同一句话,与「其中两个
  有这个特性」是不同种类的证据。下面的清单记录这一差别,而不是抹平它。

## 有序清单

下面的排序是工作顺序,不是已定的优先级。条目 0 存在,是因为条目 1 的判定
取决于条目 0 修复的那个信号;条目 3 和 4 与它无关,可以重排。

### 0 —— 存在感信号报告的东西并不为真

**缺口。** `status` 与忙/闲在 README、broker targets payload 和
元数据文件里被描述为关于 session 的事实。它们不是。四种各自出错的方式,每个面一种:

- **pi,过早 idle。** `index.ts:209` 在 `agent_end` 上置 `idle`。那个事件不是终态:
  runtime 自己关于 `AgentSettledEvent` 的声明说它触发于「after an agent run has fully
  settled and no automatic retry, compaction, or queued continuation will run」
  (`dist/core/extensions/types.d.ts:800-805`),而两者之间还夹着两个事件。session 可能正在恢复
  工作,而我们却宣布它空闲。
- **pi,排队工作不可见。** `state.isRuntimeIdle()`(`state.ts:73-76`)只问 `isIdle()`,
  从不过问 `hasPendingMessages()`,而后者就在同一个接口上(`types.d.ts:244`)。一个已排队
  但未开始的轮次读起来是空闲。
- **Adapter daemon,冻结。** `adapterd.src/daemon.ts:88` 在启动时写一次 `status: "idle"`,
  此后再不更新 —— 包括 `--on-handoff` 正在 spawn 工作的时候。
- **Mesh,缺席。** `XferInstanceState`(`mesh-engine.ts:18-23`)根本没有 `status` 字段。
  本地传输上存在的信号不跨机。

同一家族还有第二个更安静的实例:`local-side name collisions are silently
taken over`。`controller.start` 和 `startAdapterd` 都在 bind 之前 unlink socket 路径
(`controller.ts:98-99`、`adapterd.src/daemon.ts:75-78`)。第二个以同名启动的 pi
session 抢走端点;输家继续在一个已 unlink 的 inode 上监听,什么也收不到,而
`/xfer list` 显示一个健康的条目。Mesh 拒绝重名(`Running`,ADR-0016);本地
传输完全不检查。

**证据。** `notes-pi-runtime-primitives.zh.md`、`notes-transport-matrix.zh.md`、`notes-reason-network-wake.zh.md`
的 §11–§12、`notes-identity-and-addressing.zh.md` 的 §name resolution。

**这没有决定什么。** 哪个信号是权威 —— `runtimeContext.isIdle()` 还是
事件驱动的 `currentStatus` —— **没有**在这里定案,而且两者目前彼此矛盾,
不只是与现实矛盾。还要注意 `doctor.ts:187` 的 `node.status === "Idle"` 指的是 Rivet
的 actor 生命周期状态,是一个恰好共用这个词的不同概念;这个领域的任何工作
都必须处理那个冲突。重名情形是归入本条目还是算独立缺陷,也没有决定。

### 1 —— 发送方无法判断 handoff 是否被看见

**缺口。** 两个工具都返回硬编码的 `status: "sent"`(`index.ts:149`、`index.ts:194`)。
说出真相所需的信息在投递时已经算出并被丢弃:
`controller.ts:69-71` 依据 `isIdle` 分支,选择 `followUp` + `triggerTurn` 或 `steer`。这个
区分正是发送方想要的 —— *它落地了,还是稍后落地,还是根本没有地方落地*。

**证据。** 四个外部项目独立汇聚(见「这个里程碑为什么存在」)。
Reason 的词汇是 `stored | delivered | held | refused`;c2c.im 把持久性与唤醒
分开;两者都完全活在发送方的返回值里。在本仓库内从五个角度得到印证 ——
`notes-transport-matrix.zh.md`(逐面的 ack 粒度)、`notes-coordination-semantics.zh.md`
(`kind: task` 契约背后没有任何机制:没有等回复、没有 pending 记录,而
`doctor.ts` 的五个检查没有一个会看一份从未被回答的 handoff)、`notes-identity-and-addressing.zh.md`
(可达性面报告什么,以及它们不报告什么)。

**这没有决定什么。** 取值集合。`held` 是否出现在第一版还是以后。
判定是在发送时计算还是稍后作为回执到达 —— 两者蕴含不同的存储,而条目 3 会与后者
交互。mesh 侧需要一个新 actor action 和 `XferInstanceState` 的增长;本地侧看起来
根本不需要协议改动,但本地侧的新鲜度是否足够**没有**被确立:`targets.ts` 不含定时器
(`listTargets` 是一次性目录扫描),而 `METADATA_POLL_MS`(`constants.ts:16`,1 秒)属于
*写入方*。所以本地判定会是读取时的快照,而不是订阅。

### 2 —— MCP 作为会说 MCP 的宿主的出站面

**缺口。** Adapter Daemon 是给能运行我们 bundle 的宿主的答案。只能运行
MCP 客户端的宿主没有入口。`reason network mcp` 和 `c2c-mcp-server` 都是这个形状:MCP 作为
通往别处某条传输的薄前门,绝不是线路本身。

**证据。** `notes-external-protocols.zh.md` §2。pi-xfer 已有所需形状 —— `xfer_to` 就是
一个工具(`index.ts:73-95`)。

**这没有决定什么。** 范围、打包或命名。设计时必须写下来的是限制,而不是特性:
**MCP 仅出站。** Reason 的 DESIGN.md 记录了实证发现:MCP notifications 不是一条投递路径,
而规范正在整体移除服务端发起的方向(sampling 已废弃;SEP-2260,状态 Final,去掉独立的
服务端请求)。所以本条目买到的是「任何 MCP 宿主都能发给我们」,关于唤醒或回执
什么也没买到。考虑到 Adapter Daemon 已覆盖大多数宿主,这是否值得做是一个
开放问题,不是已定问题。

### 3 —— 入站策略:接受 / hold / 拒绝 —— **停在 design 节点**

**缺口。** 没有中间档。每一份到达 socket 的 handoff 都被注入
(`controller.ts:64-71`):空闲就开新轮次,忙就 steer 进当前轮次。没有地方
放「已收到,但不是现在」。再加上已定的弱点 —— peer 身份是 actor 类型名加一个 key,
无握手、无凭证(ADR-0019 把冒充记录为已接受风险),且 `/xfer desc` 是
未经核实的自我声明 —— 今天唯一的选择是全盘接受或停止监听。

**用户已经决定了什么。** 这个价值是真实的,而且它不应被折进其他
条目 —— 用户明确把它分开,理由是*它如何*工作是一个
设计问题。**不要把实现假设带进 design 节点。**

**design 节点必须回答什么,这里一个都没答。** 粒度:Reason 按机器设定,
Claude Code 按 session 设定,而本仓库里两种立场都有。手动还是自动:两个外部实现
都是手动门 —— Reason 的 `hold` 等一个人,Claude Code 的 `crossSessionInbound`
是一个开关。自动规则将不得不判断一个身份无法核实的发送方,这与本清单上
其他每个条目的前提都不同。存储:被 hold 的 handoff 是活过该轮次的状态,而本轮
已确立 `os.tmpdir()` 里的 handoff 文档**完全没有清理器**(四个写入点 —— `index.ts:103`、
`mesh.ts:308`、`broker-main.ts:363`、`adapterd.src/main.ts:215`;唯一的 `unlink` 是 `index.ts:126`,
在失败路径上。`gc.ts` 只清理 `.sock` 和 `.json`)。Hold 在一个无界的堆上再加一层,
所以它的生命周期必须在实现之前定下。还有一个约束:ADR-0018 的
「发送方声明,接收方从不评判」治理的是 `kind` —— 消息*是什么* —— 而不治理
是否接受它;两者不冲突。

### 4 —— 没有防止 agent 互相绕圈干活的守卫

**缺口。** 没有任何东西观察 agent 之间的交换循环。`kind: task` 承诺「恰好一条
结论」,但那只是约定 —— 没有等回复、没有未结任务记录,而
`doctor.ts` 的检查没有一个会看一份未回答的 handoff。A→B、B→C、C→A 在任何地方都
不引发任何东西。因为我们的投递会**唤醒 session**(`controller.ts:69-70`),这样的循环不只是
结构性的:它会让 session 持续运转。

**证据。** `notes-coordination-semantics.zh.md`。两个外部项目带守卫:Reason 限制
同一 thread 内无人介入的连续 agent↔agent 消息;Claude Code 有逐发送方限流
和 50 条消息的队列上限。注意这里的证据等级弱于条目 1 —— 两个项目
有某特性,不同于四个项目就某个发现达成一致。

**这没有决定什么。** 计数器的范围(逐 peer、逐 session、逐机器)、它住在哪里,
以及它触发时做什么 —— 警告、停止还是丢弃。design 节点可以合理地得出
这是一个 `/xfer doctor` 检查而不是路径内守卫的结论;那是设计选择,不是
前置条件。


### 5 —— 非 pi 代码 agent 的逐主机投递 profile —— **是否进入实现未定**

**缺口。** 非 pi 代码 agent 今天没有 steer 路径。`skills/xfer-agent/SKILL.md` 让宿主
自己运行 `xfer-adapterd inbox list` / `inbox take`:拿走即读,而且只在 agent 选择时。
`--on-handoff <cmd>` 能推,但它推的是一个**进程** —— 而那个进程仍须通过某种宿主特定
手段到达 agent(写 socket、注入终端 pane、丢一个没人读的文件)。ADR-0015 有意点名这个
接缝并推迟了替代方案:*"`--on-handoff
<cmd>` is a best-effort second strategy… A `url` strategy (HTTP POST) is deferred pending research and
is deliberately not reserved as a flag"*。

逐主机配置位置已经存在且不携带投递语义:
`skills/xfer-agent/hosts/cursor.md` 和 `hosts/generic.md`,加上 `.xfer-agent.json`(宿主类型、
agent 名字、启动命令),只变化**安装位置和启动命令**;`install --host
<cursor|generic>` 同样只固定放置。已发布的产物里没有任何东西说明 handoff 如何到达
agent 的 context。

**为什么是事后加入的。** 本轮较早的结论 —— 「adapterd 够用了」—— 是在仔细
审视这件事之前记录的,而它只在进程边界为止成立。越过那条边界,每个无法被注入的宿主
都得到「agent 必须记得去看」,而这正是两份外部调研都描述为退路而非保证的拉取
tier(c2c.im:*"`poll_inbox` requires the model to choose to call it. A fallback is not a guarantee."*)。

**证据。** `notes-external-protocols.zh.md` §3(Reason 的 `hook <agent>` —— 一个投递内核,
客户端作为参数)与 §5(Claude Code 的 `CLAUDE_CODE_MESSAGING_SOCKET`、Codex app-server);
`notes-transport-matrix.zh.md`(adapterd 的 ack 是「JSONL 追加成功」;被 spawn 命令的退出
码从不回到发送方);`skills/xfer-agent/`;ADR-0015。

**收益并不均匀,而把它说出来正是写下这段的意义:**

| 宿主类别 | profile 实际能到达什么 | 层级 |
|---|---|---|
| Claude Code、Codex | 一个原生注入 API | 真 push |
| Cursor、Gemini CLI、Copilot CLI | 宿主 hooks,在宿主自己的生命周期里、以自己的 context 格式运行 | 可靠的轮次级 —— 好于今天,但不是 push |
| 其他一切 | 无 | pull,不变 |

只有第一行是新能力。第二行把「一个进程被 spawn 了,agent 也许注意到也许没有」
变成「宿主自己在它本来就要处理的那个点上收到了内容」。

**在它成为实现工作之前(而不是在它成为范围之前)必须定价的两项成本。**
第一,这是一个会随别人的发布漂移的外部集成面:Reason 自己的文档记录
Cursor、Copilot 和 Devin 都在读 Claude Code 的 `~/.claude/settings.json` hooks,所以它的
hook 进程必须探测实际调用它的是哪个 agent —— 一种不会崩溃的失败模式,它会静默地
寻址到错误的 context。第二,它没有一样是自动可验证的:这些宿主在测试面之外,与
`web-picker.user.js` 按 AGENTS.md 被排除在 `npm test` 之外是同一理由。一个 profile 层会加一张
必须逐宿主维护的人工验证矩阵。

**这没有决定什么。** 它是否进入实现 —— 用户于 2026-10-18 把它记录为
**仅范围**,在讨论中定案,不得当作已同意的工作。同样未定:哪些宿主、
接缝是一个随包发布的 profile 还是一份文档化配方,以及其中任何部分如何验证。
注意扩展 ADR-0015 的 deliver-strategy 一节将是对已定 ADR 的扩展而不是偏离 ——
那个问题属于 design 节点。

## Out of scope

有意记录,以免下一轮重新争论。

| 条目 | 原因 |
|---|---|
| **A2A** | **用户于 2026-10-18 按架构偏好决定。** pi-xfer 按设计是无状态的;A2A 要求每个节点是一个带任务存储和 `Task` 生命周期的 HTTP 端点(`submitted → working → … → terminal`,终态不可变)。那会颠倒 pi-xfer 有意做出的选择,并重开 ADR-0013/0014。 |
| `serve` 式常驻无头 agent(Reason 的框定;逐发送方 thread、热恢复、重启后恢复) | 一个产品形态问题,不是能力缺口 —— `--on-handoff` 已经能唤醒非 pi 宿主。它引出没人回答过的 ADR 问题(worker 是一个 Node 吗?它的状态住在哪?谁监管它?),并与 ADR-0014 的「活过 session 的状态属于 Board」处于张力之中。 |
| 带存储的持久邮箱 / 读回执 | ADR-0015 有意选择了有损的拿走即读 Inbox;持久归档在那里被考虑过并拒绝。 |
| 服务端唤醒保证 | 与 ADR-0013 有意接受的「daemon 活着但 pi 死了」是含糊的相冲突。 |
| Agent Card 作为发现格式 | 能力声明已作为 Node 自我描述的 `/xfer desc` 存在于 actor 上;Agent Card 是同一个断言的更重的签名形式,而发现是 `listActors`。 |
| `doing` 推断(Reason 从宿主 todo 文件推断它) | 三个面上都缺席,而且 pi 看不到宿主的计划。建议作为自己的里程碑,而不是折进来。 |
| MCP 作为入站唤醒路径 | 由协议关闭,不是由偏好:服务端发起的请求正在被移除(SEP-2260,Final),而 Reason 实测客户端不会把 MCP notifications 传给模型。 |
| handoff 上的 thread / reply / 因果字段 | 已确立为真实缺口(`notes-coordination-semantics.zh.md`:`msgId()` 既不单调也不可排序,而且没有为因果预留槽位)但它是协议形状变化,不是投递可见性变化。有意留给更晚的里程碑。 |

## 给 design 节点的注记

1. **条目 0 门控条目 1。** 一个复述已知会说谎的信号的判定,比没有判定更糟。
   如果 design 节点重排,条目 1 不得在没有说明「当底层忙/闲值本身处于四种错误状态
   之一时它做什么」的情况下上线。
2. **条目 3 和 4 独立于 0–2**,可以任意顺序或单独上线。
3. **条目 0 下记录的重名行为可能是独立缺陷。** 没有请用户裁定;它在
   证据收集期间浮现,是记录,不是断言。
4. **本里程碑里没有任何东西对着真实部署测试过。** 全部是读代码。证据的
   外部那一半依赖文档,而且在若干处依赖搜索抽取而不是直接抓取 —— 来源按笔记
   编入索引,无法直接验证的那些列在每篇笔记的结尾小节。
5. **条目 5 仅范围。** 它在清单上是因为用户指出了它,不是因为已同意。
   它是否成为实现工作是讨论的结果,而条目在定义处就这么写了,以免 design
   节点把它读成已定。
