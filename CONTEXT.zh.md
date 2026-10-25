> 中文版 · 英文原文：[CONTEXT.md](CONTEXT.md)

# Xfer — 语言

## Mesh（可选的跨机传输）

**Mesh**：
可选的跨机传输：agent 实例加入一个共享 actor 网络，以发现并给远端 peer 发消息。加入是按实例、手动进行的；本地 Unix socket 投递不受影响，仍是默认路径。
_Avoid_：network、cluster、swarm、overlay

**Node**：
Mesh 引擎上的一个 actor——一个名字、一条出站引擎连接、一个独立的参与者。加入、寻址与存活性的单位；与宿主无关（一个 pi 实例和一个 Adapter Daemon 以同样的方式加入）。
_Avoid_：peer（留给本地 socket 发现）、bridge、worker、session

**Runner / pool**：
机器上一个能承载 Node actor 的活进程，以及引擎上它们的命名分组（`runner_name_selector`；名字缺失即引擎的 `default` 池）。Node 的 actor 只会在自己那个池里的 runner 中运行——池里没有 runner 的 Node 在引擎上，但收不到任何东西。
_Avoid_：worker、envoy（引擎自己的说法——只保留在面向引擎的代码里）、host

**Delivery verdict（投递判定）**：
列表对某一个 Node 能否接收 Handoff 给出的说法，由 actor 记录与其池中 runner 联结推导而来。永远关于一个 Node，永不关于某一份 Handoff——那是另一条轴，叫 **Handoff outcome**。也区别于 **actor status**（`Running` / `Sleeping` / `Idle` / `Crashed` / `Pending`），后者是引擎单就 actor 给出的说法：记录可以读作 `no_envoys`，而它的池里却有活的 runner，所以判定永远不是状态。
_Avoid_：health、presence（presence 属于本地 peer）、online/offline、outcome


## SSH Link（点对点跨机传输）

**Link**：
一个经 ssh 转发的远端 Node 在本地的那一端——顶层 xfer 目录里的一个 `.sock`，外加一个标着 `via: "ssh"` 的 `.json`。它不是 Peer：它借用本地发现扫描，但生命周期归 `up`/`down` 和启动它的 pi 进程。以精简条目的形式出现（无 cwd/model——远端元数据读不到）。
_Avoid_：tunnel（ssh 进程是隧道，Link 是它的端点）、forwarded peer、remote peer

## Adapter Daemon（非 pi 的 Agent Host）

**Agent Host**：
agent 所运行的那类宿主软件（pi / Cursor / grok bot / ……）。它决定安装产物与 handoff 的投递方式，不决定 agent 的在线身份。
_Avoid_：client、IDE、runtime、harness（太宽泛）

**Adapter Daemon**：
把非 pi 的 Agent Host 适配到 xfer 网络的那个 bundle 进程——它持有一个 Node 的本地 socket 与 Inbox，并说与扩展相同的线协议，因此各种宿主是地位平等的 peer。
_Avoid_：bridge、proxy、gateway、connector

**Inbox**：
一个 Node 的 JSONL 接收文件，语义是 take-to-read：`inbox take` 原子地读取并删除已被消费的记录。它背后没有持久存储。
_Avoid_：mailbox、queue（暗示持久化与派发）、log

**Install**：
把 skill 固定到某个 Agent Host 的目标目录，生成宿主配置与推荐的启动命令，使宿主永远不必自己拼 adapter 参数。
_Avoid_：deploy、setup、onboarding
xfer 扩展的词汇表。实现细节在 `docs/`；本文件只固定术语。

## Example（可复制的脚手架）

**Scaffold**：
`examples/` 下一个供复制改写的目录，永远不被依赖：它不从扩展本身导入任何东西，也从不发布到 npm。它的契约是"按说明改掉指名的地方后，就能原样跑起来"，所以每个文件只声明一件事，而复制者必须修改的事实就在承载它的那一处被点名。只存在于本仓库内部的保证——比如针对扩展的一致性测试——放在 Scaffold 之外，绝不进入随包发布的文件。
_Avoid_：template、starter、sample、demo、reference implementation、example（太松散——example 泛指任何示例；Scaffold 是要被拿走的）

## Board（跨 agent 异步协作）

**Board**：
跨项目、机器本地的协作空间（`~/.pi/xfer/board/`）。它承载 Card；agent 自由加入与离开——由人来编排谁读谁写，因此没有 agent 需要一直在线。
_Avoid_：task queue、message bus、ticket system（Board 用于讨论与分析，不是派发）

**Card**：
一个异步协作话题。一个 Markdown 文件，头部带 id/title/created_by，正文是 Conversation。设计上无状态——它是一份共享文档，不是工单：没有生命周期状态，只有人显式执行 del / clean 时才会清理。
_Avoid_：topic、ticket、issue、workflow state

**Entry**：
Card 上一条只追加的贡献。自由格式的 Markdown 文本，带作者和一个可选的类型标签（note / finding / question / answer）；标签只是元数据，不驱动任何逻辑。
_Avoid_：comment、post、message

**Conversation**：
Card 正文中 Entry 的有序序列。Card 陈述话题，Entry 是讨论；没有正式的确认步骤——人清理掉这张 Card，对话就结束了。
_Avoid_：thread、log

## Web Picker


## Admin（本地 web 控制台）

**Admin**：
本机全局单例的 web 控制台（`/xfer admin`），用于观察并轻量控制本机的 xfer：实时事件流、本地与 mesh 在线情况、board 列表/查看，以及控制按钮（gc、broker 启停）。只绑定 localhost；对 board 内容的写操作委托给系统（打开文件夹 / 用编辑器打开），绝不在页面内处理。区别于 Broker——后者服务 web picker，而不是服务人。
_Avoid_：dashboard（暗示只观察）、panel、UI
## 语言

**Marker**：
picker 交给 agent 的一切东西的共同形态：一个指向页面上某物（元素、动作）的轻量指针，加上人写的或采集来的上下文。agent 是被 marker *拉进来理解*的，不是被倾倒。
_Avoid_：annotation dump、full DOM snapshot、payload

**Pick**：
静态 marker——"看这个元素"。一个被选中的元素，带 selector/tag/text 与可选备注，可选择性地聚合进一个 `group`。
_Avoid_：selection、highlight、annotation（在 handoff 文档旁边太含糊）

**Record**：
时序 marker 序列——"我做了什么、发生了什么"。一个人操作的采集时段（start → stop），包含带时间偏移的有序事件，以及同一窗口上切出的 console/network 场景数据。record 对象本身就是那个序列；它随一次 submit 走，就像 pick 走 submit 一样，是 pick 的 `group` 在时间维度上的类比。
_Avoid_：replay、recording session、log（它是有界、人工策展的采集，不是日志流）

**Scene Data**：
常开的环形缓冲采集（console 条目、网络请求），按 Record 的时间窗口切出并附着其上。不是新的采集——只是对已有采集的一个视图。
_Avoid_：telemetry、logs、tracing output

**Handoff**：
一个节点投递给目标节点的那份文档。它带一个 Kind，而反向消息本身也是 Handoff——绝不是 "reply" 或 "receipt"。在一次 web-picker 提交里，Pick 与 Record 是它的章节；两者是不同轴（空间 vs 时间）上的 marker。Handoff 携带的是消息，不是记忆——必须跨会话存活的状态属于 Board。
_Avoid_：prompt、message、report、reply、receipt、acknowledgement

**Handoff outcome（Handoff 结果）**：
一份 Handoff 最终停在哪里，以网络能诚实给出的程度为限——发送方关于那一次发送的视角。绝不表示是否被读过：抵达某会话的 Handoff 是被交给了一次运行，而不是被消费了。
_Avoid_：receipt、acknowledgement、verdict（那是 Node 那条轴）、status

**Notification**：
一种 Handoff Kind，用来告知而不索取产出。默认沉默：只有当接收方缺少信息，或文档与事实冲突时，才回一份反向 Handoff。
_Avoid_：FYI、broadcast（handoff 是按名字点对点的）

**Task**：
一种 Handoff Kind，用来索取产出。接收方一旦得出结论就总是回一份反向 Handoff——done、blocked 或需要输入。
_Avoid_：request、job、ticket（暗示生命周期）

## Staging Bag（web picker 的跨页暂存）

**Bag**：
broker 持有的会话级暂存区，存放 Staged marker——每个 broker 一个默认 Bag，只在内存中。发送（bag.submit）会消费它：发送即清空，没有保留副本的选项。不跨 broker 重启持久化；丢失的代价很小，因为每条记录都带完整 Provenance。
_Avoid_：staging area、cart、pool、snapshot

**Staged marker**：
经 `annotation.stage` 存进 Bag 的 Marker。永不去重——重复暂存会产生独立条目，由用户手动剪裁。条目 id 由 broker 分配；重连后 picker 通过一次完整的 `bag.list` 重建视图。
_Avoid_：pending pick、staged pick、draft

**Provenance**：
Staged marker 携带的来源事实：tabId + origin + url + title + 采集时间。Bag 的 UI 按页面（url+title）分组；page-tool 按 tabId 路由逐 marker 的追问。tabId 是页面生命周期的（sessionStorage），所以 Provenance 命名的是采集该 marker 的那个标签页，而不是一个活着的会话。
_Avoid_：source info、metadata、context
