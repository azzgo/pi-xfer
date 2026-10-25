> 中文版 · 英文原文：[phase4-summary.md](phase4-summary.md)

# Milestone 4 总结 — Release Note 素材

> Milestone:阶段4 —— 让投递可被看见。
> 状态:完成。条目 0+1 作为一次改动交付,条目 2 交付,条目 3、4 以及
> 条目 5 的投递内核被决定不做,并记录了理由。
> 特性清单:`docs/milestones/phase4-features.zh.md`。决定记录:
> `docs/adr/0020-delivery-visibility-two-axes.zh.md`。设计计划:
> `phase4-design-p0-p1.zh.md`、`phase4-design-p2.zh.md`、`phase4-design-p2-p5.zh.md`。

驱动本里程碑的论点,以及值得留在 release notes 里的那一句话:

> 不要因为发送成功就假设对端读了你的消息。

在本里程碑之前,`xfer_to` 和 `xfer_mesh_to` 都返回常量
`status: "sent"` —— 无论目标是醒着、睡着、排队中还是已经消失,都是同一个值。

## 已交付

### Handoff outcome(条目 0 + 1,`8a334be`)

两个工具现在报告 **handoff 落在了哪里**,而不是一个常量。共有四个取值,
两条传输共享,而每条传输只到达它能诚实支持的子集:

| Outcome | 含义 | Local | Mesh |
|---|---|---|---|
| `queued` | 已接受,稍后会被取走 | ——(这条传输没有队列) | ✓ |
| `delivered` | 现在就交给了目标的 runtime | ✓ | ——(发送方无法得知) |
| `unknown` | 答复含糊 —— 它可能已经到达 | ✓ ack 之前连接断了 | ✓ enqueue 答复含糊 |
| `not-delivered` | 确定没有落地 | ✓ 无此端点 | ✓ 引擎拒绝 |

`unknown` 是一个真实的答案。它绝不会被呈现为重发的理由,工具文本明确这么说:
第二次发送正是把含糊变成真实重复的那件事。

**上限,直说。** `pi.sendMessage` 返回 `void`,而 ADR-0015 有意选择了有损的
拿走即读 Inbox,持久归档已被拒绝。所以「它是否被读过」是**不可达的,而不只是未建**。
承诺是「你会知道它落在哪里」,绝不是「你会知道它被读过」。线路上
的变化是既有 ack frame 上一个增量字段 —— 没有新 frame 类型、没有新端点、没有协议版本。
不带 outcome 字段的接收方会得到 `unknown`,所以较旧的接收方倾向于诚实,
而不是倾向于假阳性。

**随它一起交付的两个前置条件**,否则 `delivered` 就是假的:

- `isRuntimeIdle()` 现在也会问 `hasPendingMessages()`。一个已排队但未开始的
  轮次过去读作空闲,所以排在它后面的 handoff 被报告为
  `delivered`,而它其实只是排在其他工作后面。
- bind 时的 unlink-before-bind 被 `claimEndpoint()`
  (`endpoint-claim.ts`)取代,它清除崩溃残留并拒绝活跃 peer。
  以前两个同名 session 都能成功「bind」:第一个被困在没人能再连接到的
  已 unlink inode 上,两者写同一个 `<name>.json`,而请求那个名字的发送方
  会到达最后 bind 的那个。这是 local 本来退化的 Node 轴上唯一的洞 —— 连接
  成功,`delivered` 回 true,但那是另一个并非被指名者的进程。
  - **用户可见的行为变化:** 启动第二个同名 session,或对活跃的 `foo`
    运行 `/xfer name foo`,现在会以一条点名活跃 peer 的消息失败,
    而不是静默接管。这是有意为之的修复,也是用户唯一会碰到的回归。
  - `rename` 现在先占用新名字再释放旧名字,所以失败的
    rename 会让 session 完好无损。

### MCP gateway(条目 2,`5687695` + `e406d4a`)

`mcp-gateway.mjs` —— 一个 stdio MCP server,暴露 `xfer_send`、`xfer_mesh_send`
和 `xfer_list`。它不 bind socket、不保留 inbox、不加入 mesh、不运行 agent
loop:每个工具拼一个 argv 并 fork 既有的 `xfer-adapterd` CLI。

- `--name` 必需,且绝不推导。只发送的 gateway 不 bind 任何东西,所以
  名字冲突无法被 `claimEndpoint` 抓住;它必须在启动时被拒绝。
- `--no-preflight` 有意**不**作为工具参数暴露:它是给引擎调试用的人工
  escape hatch,不是模型该去够的东西。
- 它**没有新增构建产物**。它不从本仓库 import 任何东西,所以它是一个
  提交的单文件,没有打包步骤;`AGENTS.md` 的构建产物清单不因它改变。
- 它需要一个新子命令 `xfer-adapterd list [--dir D] [--json]`。此前**从 CLI
  无法列出 peer** —— `/xfer list` 是 pi 的命令 —— 所以没有它,gateway 能发
  但找不到目标,那是问题的一半。skill 也已更新为指向它。
- `xfer-adapterd send` 也接受 `-` 表示文档,所以在内存中组装 handoff 的调用方
  在 CLI 侧不需要临时文件。

诚实定级:这是一个**便利性特性,不是能力缺口**。它买到的是一个带类型的工具,
而不是三句 shell 咒语;以及每个宿主 session 一个 gateway,而不是每个 agent 一个
skill 文件。两项成本记录在 `docs/guides/mcp-gateway.md`:只发送的宿主
在 `/xfer list` 中**不可见**(没有东西为它 bind socket),而且它**无法接收**。

## 决定不做,附理由

记录这些是本里程碑的一部分:每一个都是经过考虑的「不」,不是待办项。

- **条目 3,入站 `held` / `refuse` —— 永不。** mesh 无法表达它。actor 的
  `run` 调用 `onHandoff`(同步,返回 `void`),然后在下一行无条件写
  `recordMeshDelivery`,所以被 hold 的消息被记录为已投递,重投递被当作重复丢弃,
  而接收方重启会丢掉它。支持它就要改变 ADR-0013 定义的持久队列
  契约。仅本地变体被考虑过,并判定不值它引入的状态 —— 就它为
  今天多买到的那一件事,关闭 session 已经是关断开关。全盘接受或停止监听是永久的
  形态。记录在 ADR-0020,因为 Reason 的词汇是
  `stored | delivered | held | refused`,未来的读者会问为什么这里少了一个
  值。
- **条目 4,循环守卫 —— 不建。** 每次发送背后通常有人,而
  没有因果关系的守卫只能猜:它无法区分意外循环与
  有人故意搭的中继,所以它会破坏后者。它还被一个因果字段挡住,而
  `phase4-features.md` 已把它置于 out of scope。记录了一个诚实的注意点:
  ADR-0018 告诉*被阻塞*的接收方把它的反向 handoff 声明为 `task`,所以两个互相阻塞的
  agent 可以在无人值守时来回打乒乓。那是退化情形,人类可解。改为采用的更便宜的
  杠杆:两个工具描述现在都写明**何时允许发送**,而不只是发送包含什么。
- **条目 5,逐主机投递 profile —— 不做投递内核。** 内核(把 handoff 送进 agent context
  的逐主机逻辑)随其他项目的发布漂移 —— Cursor、Copilot 和 Devin 都在读 Claude Code 的
  `settings.json` hooks,所以 hook 进程必须探测是哪个 agent 在调用它 —— 落在密封测试面
  之外,而且它最坏的失败模式不会崩溃:它会静默寻址到错误的 context。它只在两个宿主上
  买到新能力。预设保留,只携带配置,绝不携带投递逻辑;`CONTRIBUTING.md`
  现在记录了原本属于口头传说的 fork-or-PR 路线。
- **公网 MCP 中继推迟** —— 它在 mesh 上是客户端角色(已建好)但需要认证,
  而一个未认证、能往别人 mesh 里 enqueue 的端点,与 ADR-0019 所论证的 unix socket
  是不同的暴露面。认证是要有人维护的东西;它不属于一个便利性特性。

## 结果被证明是错的前提

这是本里程碑中发现代价最大的部分,所以记录下来而不是悄悄更正:

- 特性清单断言条目 0 无条件门控条目 1。并非如此。
  条目 0 的四个缺陷中有三个落在 Node 轴上,而该轴在 local 上是退化的;
  只有 `hasPendingMessages()` 是承重的。条目 0 塌缩为条目 1 的两个
  前置条件,并作为一次改动一起交付。
- 条目 2 被框定为服务「只能运行 MCP 客户端的宿主」。那个集合
  是空的 —— MCP 是宿主拥有的一个接口,不是一类宿主,而每个会说 MCP 的编码 agent
  也能跑 shell。最终证明值得做的是每个宿主 session 一个本地 gateway。
- 条目 2 计划的早先草稿声称一个共享 gateway 会把 `/xfer list` 塌缩成一行。对 stdio 来说是错的:
  宿主 spawn 该 server 并拥有其 stdin/stdout,所以每个宿主 session 一个进程,
  各自带自己的名字。`/xfer list` 不会塌缩;只发送的 gateway 根本不会被列出。
- `AGENTS.md` 说「四个提交的构建产物」,漏掉了
  `xfer-adapterd.cjs`,而它早已随 `.sha256` 发布,也早已被
  `artifact-freshness.test.ts` 强制执行。本里程碑已更正。
- 发现 `syncXferToolAvailability` 是个空操作 —— 它承诺在无 peer 时隐藏
  `xfer_to`,却什么也不做,未被发现是因为仓库没有 `tsconfig.json`,
  所以未使用的局部变量从未被类型检查。未修复(见后续项)。

## 审查期间发现的修复

两处都是在 gateway 工作之后审查时抓到的,而不是在编写它的时候 ——
这正是值得保留的要点。

- **第五个 outcome 取值。** gateway 的第一版发明了 `not-sent`,并把它
  用在 ack 超时场景上 —— 恰恰是重发会产生真实重复的那个含糊场景。修法是让 CLI 把它的 outcome
  **命名**为失败行的末尾词,并让 gateway 只映射被命名的取值;缺失的名字降级为
  `unknown`。现在有一个全仓测试断言 `not-sent` 不出现在任何地方。
- **一条警告走了失败通道。** `xfer-adapterd mesh send` 不打印 outcome,并把一条预检
  *警告* 走 `fail()`,于是一个 `Mismatch`(意味着**已排队**)以退出码 1 退出。
  信任退出码的 gateway 把一次成功的 enqueue 变成了失败。修法是新增 `warn()`,
  不动退出码,而 `runMeshSend` 现在报告 `queued`。
- **临时 handoff 文档在 `unknown` 时不再被删除。** handoff 可能
  已经到达,而目标的投递消息指向那个路径。只有 `not-delivered` 才删除它。

## 验证

- `npm test`:**567 个测试,566 通过,1 跳过,0 失败。**
- 新增测试覆盖 ack 合并(`client.test.ts`:只有接收方这么说才
  `delivered`,字段缺失或无法识别时为 `unknown`,连接先死时拒绝)、端点占用
  (`endpoint-claim.test.ts`:活跃 peer 被拒绝且其文件存活,崩溃残留被清除)、经由
  `isRuntimeIdle()` 的入站路由、工具描述,以及对 `mcp-gateway.mjs` 的真实 stdio
  JSON-RPC 握手,包括错误路径上的 stdout 纯净性和通过 stub CLI 断言的逐工具确切 argv。
- 对活跃 `xfer-adapterd` 的本地人工冒烟确认:
  - `delivered` 是真的 —— 记录在 daemon 的 `inbox.jsonl` 里,不只是在
    返回值里;
  - 晚 8 秒的 ack 解析为 `unknown` 分支(「不要重发」),不是
    `not-delivered`;
  - 在活跃名字上再起一个 daemon 会被拒绝,且不打扰第一个;
  - 崩溃残留被清除,名字可复用。
- **本里程碑里没有任何东西对着真实部署或引擎测试过。** 没有联系任何
  引擎;真实 `~/.pi/xfer/mesh.config.json` 中点名的部署从未被读或写。

## 新增词汇

`CONTEXT.md` 里两个术语,读者需要两者才能跟得上代码:

- **Delivery verdict** —— 收紧为**以 Node 为范围**:一个*列表*对某一个 Node
  能否接收的断言。它本来就是这个意思,本里程碑修正了措辞,使它无法被读作
  对某一份 handoff 的断言。`mesh-status.ts` 用七个字形实现它。
- **Handoff outcome** —— 新增,**以 Handoff 为范围**:一份 handoff 最终停在
  哪里,以网络能诚实告知的程度为限。有意避开 `receipt` 和
  `acknowledgement`。

一个轴一个词,正是 ADR-0020 要解决的冲突。

## 文档

- `CONTRIBUTING.md` —— 新增。贡献者需要什么(密封测试、提交的
  构建产物、无运行时依赖)、宿主预设可以包含什么,以及五项已定
  决策不接受补丁,每项指向定案它的 ADR 或决定。
- `docs/guides/mcp-gateway.md` —— 面向 MCP 宿主的安装、flag 表、
  工具到 CLI 的映射、outcome 表,以及两项成本(在 `/xfer list` 中不可见、
  无法接收)。
- `README.md` —— 能力表新增 **Handoff outcome** 和 **MCP gateway**
  两行,并链接 gateway 指南。
- `AGENTS.md` —— 构建产物清单更正为点名 `xfer-adapterd.cjs`,并
  记录 `mcp-gateway.mjs` 有意不属于其中之一。
- `skills/xfer-agent/SKILL.md` —— 指向 `xfer-adapterd list`,并提及
  gateway 作为 CLI 的替代。

## 后续 / 开放

1. **gateway 的 loopback 端到端 mesh 测试已写好但被跳过。** 它通过
   `XFER_ENGINE_BINARY` opt-in。在本机自己的引擎旁边再跑一个引擎最终是可能的 ——
   `guard.port` 是它自己的 key,`XDG_DATA_HOME` 能搬走数据库;配方在 verify skill 里。
   仍然阻塞它的是:引擎 2.3.26 拒绝 `ensureRunnerPool` 的 datacenters payload,报
   `no variant of enum RunnerConfigKind`,所以 loopback 引擎能提供读服务,却
   无法托管一个可供发送*到*的节点。这是相对
   `phase4-design-p2.md` 计划的唯一缺口,后者记录了同样的两段状态。
2. **CLI 的错误文本现在承重了。** gateway 读失败行的末尾词来还原
   outcome。这是有意的,并由测试钉住,但它属于 ADR-0020 的后果,
   以便任何重写 CLI 错误措辞的人知道他们在碰一条线路。现在记录在那里。
3. **设计期间发现并有意未修复的四个缺陷**(`phase4-design-p2-p5.md` 的
   结尾小节):
   - `syncXferToolAvailability` 是个空操作(`index.ts`);
   - `os.tmpdir()` 里的 handoff 文档在成功路径上从不被清理 ——
     每一份成功的 handoff 都泄漏一个文件;
   - `handoff-kind.ts` 在其头部注释里重复了一段话;
   - `msgId()` 既不单调也不可排序 —— 只有在 handoff
     真的携带因果关系时才承重。
   这些需要一个 tracker,而不是里程碑文档。
4. **`broker.test.ts` 有一个既存的偶发失败。** "removes broker.pid and broker.json
   on SIGTERM" 在全套并行负载下失败过一次,而在 3 次隔离运行和 3 次全套重跑中
   都通过,无论在本里程碑改动之前还是之后。不是本工作造成的,但一个能自己变红的测试
   是债。

## 用户会注意到什么

对 release-note 作者来说,五处可见变化,按影响排序:

1. `xfer_to` / `xfer_mesh_to` 返回 `outcome`(`queued | delivered | unknown |
   not-delivered`)而不是 `status: "sent"`。
2. 在活跃名字上的第二个 session —— 带相同 `--name` 的重复 pi,或
   `/xfer name <live>` —— 被拒绝,并给出点名活跃 peer 的消息,而不是
   静默接管端点。
3. `xfer-adapterd list [--dir D] [--json]` —— 从 CLI 做 peer 发现,此前
   完全没有。
4. `mcp-gateway.mjs` —— 面向任何 MCP 宿主的 `xfer_send`、`xfer_mesh_send`、`xfer_list`,
   只发送,且不出现在 `/xfer list` 中。
5. 没有改变的东西:没有入站 `held` 状态、没有循环守卫、没有逐主机投递
   内核、没有公网中继 —— 每一项都是有记录理由的决定,不是遗漏。
