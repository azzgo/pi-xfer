> 中文版 · 英文原文：[phase4-design-p2-p5.md](phase4-design-p2-p5.md)

# Milestone 4 design — 条目 2–5(范围决定)

> Design 节点,2026-10-19。条目 0+1 在 `phase4-design-p0-p1.md`(ADR-0020)。本文件
> 记录对其余四个条目的 go/no-go 裁定。四个全部关闭。条目 2 的
> 实现计划是 `phase4-design-p2.md`,它修正了下面那一节里的成本估算。

## 条目 2 —— MCP 作为出站面:**做,仅本地 stdio gateway**

特性清单把它界定为「只能运行 MCP 客户端的宿主」。一经检视这个框定就是错的:MCP 是
宿主拥有的一个*接口*,不是一类宿主,而每个会说 MCP 的编码 agent 也能跑 shell ——
所以 `xfer-adapterd send` 已经能到达它们全部,而且它根本不需要 daemon
(`skills/xfer-agent/SKILL.md`:"send needs no daemon, so a send-only host may skip the
background process")。

质询真正找到的是清单从未考虑的第二种框定,而它才是值得做的:
**一个本地 gateway 进程,许多本地 agent。** 今天 N 个 agent 意味着 N 个 skill
文件和 N 个 daemon。一个 stdio MCP server,其工具 shell out 到既有的
`xfer-adapterd send` / `mesh send`,把两者都去掉 —— 没有 skill 文件、没有启动命令,模型
拿到的是一个带类型的工具,而不是三句 shell 咒语。

诚实定级:这是一个**便利性特性,不是能力缺口。** 它不应与条目 0+1
(那些是「我们声称是谎言的东西」)共享一个里程碑。

**已知成本 —— 以及一处修正。** 本节的初版说一个 gateway 背后的每个 agent
共享一个 Node 名字、`/xfer list` 塌缩成一行、接收方看到的是 gateway 而不是 agent。
对 stdio 来说这是错的:宿主 spawn 该 server 并拥有其 stdin/stdout,所以是
*每个宿主 session* 一个 gateway 进程,各自带自己的名字。`/xfer list` 不会塌缩 ——
只发送的 gateway 不 bind 任何东西,所以它根本不会被列出。剩下的是两个 gateway
配了同一个名字,那是配置错误。仍然成立的成本是真实的,但不同:**只发送的宿主在
`/xfer list` 中不可见**,因为没有东西为它 bind socket。

所以下面的缓解措施变成共享名字场景的 escape hatch,而不是该特性的必需部分。
保留它,是因为它要防止的失败是不可见的。

**按决定 out of scope:公网中继。** 面向云或手机 agent 的中继在 mesh 上是客户端角色
(`sendMeshHandoff` —— 不加入、无 actor,本就为只发送宿主而建),但它必须能从
互联网到达,而一个未认证、能往别人 mesh 里 enqueue 的端点,与 ADR-0019 所论证的 unix
socket 是不同的暴露面。认证是维护者要承担的事。推迟到它自己的里程碑。

## 条目 3 —— 入站 hold / refuse:**永不**

2026-10-19 决定。记录在 ADR-0020,因为 Reason 的词汇是
`stored | delivered | held | refused`,未来的读者会问为什么少了一个值。

两个独立的理由,任一个都足够:

1. **mesh 在结构上做不到。** actor 的 `run` 调用 `onHandoff`
   (同步,返回 `void`),然后在下一行无条件写 `recordMeshDelivery`。消息已经离开
   持久队列,而且没有 nack 通道,所以一条被 hold 的消息会被记录为已投递,
   任何重投递都会被 `isDuplicateMeshHandoff` 当作重复丢弃,而接收方重启会丢掉它。
   要让它工作,就得改变 ADR-0013 定义的持久队列契约。
2. **仅本地的变体被考虑过,并判定不值它的状态成本。** 它需要先有一个 tmpdir 清理器
   (现在没有 —— 四个写入点,一个在失败路径上的 `unlink`)、一个存储、
   一个 `/xfer held` 命令来列出和释放、以及一个设置。就它为今天多买到的那一件事
   —— 保持可达但不注入 —— 关闭 session 已经是一个关断开关,而且不需要新状态。

全盘接受或停止监听是永久的形态。

## 条目 5 —— 逐主机投递 profile:**不建内核**

该条目捆绑了两件成本差异极大的事:

| | 它是什么 | 新能力 |
|---|---|---|
| 投递内核(Reason 的 `hook <agent>`) | 把 handoff 送进 agent context 的逐主机逻辑 | **2 个宿主**(Claude Code、Codex) |
| 逐主机配置放置 | `hosts/<name>.md`、`.xfer-agent.json`、`install --host` —— 已存在,只变化安装位置和启动命令 | 无 |

内核被拒绝:它随别人的发布漂移(Reason 自己的文档记录 Cursor、Copilot 和 Devin
都在读 Claude Code 的 `~/.claude/settings.json` hooks,所以 hook 进程必须探测
实际调用它的是哪个 agent),它落在 AGENTS.md 要求的密封测试面之外,而且它最坏的失败
模式不会崩溃 —— 它会静默地寻址到错误的 context。

放置那一半几乎免费,保留。这**不是**条目 5 被完成了:收益表的第二行
(Cursor、Gemini CLI、Copilot CLI)仍然从宿主 hooks 获得轮次级可靠性,而不是 push。
把漂移风险挡在外面的那条线写进了 `skills/xfer-agent/install.md`:**预设只携带安装
位置和启动命令,绝不携带投递逻辑。**

不建它不等于关门 —— `generic.md` 已经覆盖任何有 shell 的东西。需要更多的主机
可以 fork 或提 PR,而这条路线现在有文档,而不是口头传说。

## 条目 4 —— 循环守卫:**不建**

2026-10-19 决定。两个理由,第二个在有人拿着 Reason 的连续消息上限到来时
仍然成立。

**1. 概率很低,因为每次发送背后通常有人。** 工具描述和 skill 都在压制那些会自行
产生流量的形状 —— 「never send a handoff that only acknowledges or confirms」—— 而 agent
通常是有人要求才发送。一个要诚实记录的注意点:本意是在无 peer 时隐藏 `xfer_to`
的 prompt 侧门禁**并未实现**(`index.ts:66` 算出 `hasPeers`,把 `getActiveTools()`
读进一个变量,然后什么也没做),所以该工具永远在 prompt 里。描述的内容仍然劝阻
确认形状的发送;未被强制执行的是那个缺失。

**2. 没有因果关系的守卫只能猜,而猜错会破坏真实的东西。**
守卫要抓的循环,与一个人故意搭出来的循环无法区分。能拦住前者的启发式
也会拦住后者。

人类在环防御唯一覆盖不到的情况值得记录,因为协议是故意产生它的:
ADR-0018 指示处于*阻塞*状态的接收方把它的反向 Handoff 声明为 `task`,于是两个互相阻塞的
agent 可以在无人值守时来回打乒乓。那是一个人类一眼就能解决的退化情况 ——
而为它付费意味着先重开 `phase4-features.md` 关于因果字段的 out-of-scope,
再接受一个也会抓住有意中继的启发式。

守卫需要什么,以及它为何不便宜:

```
guard against agents working each other in a circle
└─ needs: an answer to "was this task ever concluded?"
   └─ needs: correlating a reverse Handoff with the Task that asked for it
      └─ needs: a causation field on the Handoff
           └─ msgId() is neither monotonic nor sortable, and no slot is reserved
              → phase4-features.md puts thread/reply/causal fields OUT OF SCOPE
```

传输时刻的 `outcome` 不能替代,这是决定:outcome 对回复沉默
(ADR-0020)。而账本今天没有归宿 —— tmpdir 里的 handoff 文档只带一个 `kind`
戳和一个 cwd 戳,没有清理器;Board 的 `pending`(`board.ts:112`)是
`/xfer board` 的组装槽,一个内存中的 `PendingWrite`,尽管同名却无关;而
`XferInstanceState` 在结构上可以持有一个出站账本,但没有因果字段就没用。

一个更粗的守卫 —— 「N 条连续的 agent↔agent 消息且无人类输入」,即
Reason 所设上限、Claude Code 所限流的东西 —— 也被考虑并拒绝。它是启发式,
不是那个守卫,发布它会让条目 4 看起来已解决,却只抓住最笨拙的循环。

## 设计中发现、未修复

本轮浮出四个不属于任何条目的缺陷。它们记录在这里,
因为这是唯一在范围内的文件;它们需要一个 tracker,而不是里程碑文档,所以谁
捡起一个就应该把它移出去。

**`syncXferToolAvailability` 是个空操作**(`index.ts:66`)。它算出 `hasPeers`,把
`getActiveTools()` 读进一个变量,却从不写回,所以承诺的门禁 —— 无 peer 时隐藏
`xfer_to` —— 什么也没做,该工具永远在 prompt 里。hook 点和谓词都已存在;
只缺那次写入。之所以未被发现,是因为仓库没有 `tsconfig.json`,而 `npm test`
走的是 resolve hook,所以那两个未使用的局部变量从未被检查。

**`os.tmpdir()` 里的 handoff 文档从不被清理。** 四个写入点(`index.ts:107`、
`mesh.ts:308`、`broker-main.ts:363`、`adapterd.src/main.ts:215`)和一个 `unlink`,在
`index.ts:126`,在失败路径上。成功时没有任何东西删除该文件 —— `deliverInbound`
只点名路径,而 `gc.ts` 只清理 `.sock` 和 `.json`。每一份成功的 handoff
都会在系统临时目录里留下一个文件,直到机器生命结束。

**`handoff-kind.ts` 重复了一段话** 在其头部注释里:关于工具写入 `kind:` 行的
两句话连续出现了两次。

**`msgId()` 既不单调也不可排序**(`utils.ts`)。它内嵌一个 base-36 时间戳,
但在其后追加随机性,所以字符串顺序与时间顺序不一致。修起来便宜,
但只有在 handoff 携带因果关系之后才承重 —— 与条目 4 同一个阻塞点。
