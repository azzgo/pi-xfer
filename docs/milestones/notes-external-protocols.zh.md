> 中文版 · 英文原文：[notes-external-protocols.md](notes-external-protocols.md)

# 外部 agent↔agent 协议版图 — 研究输入(调研 + ADR 兼容性)

出处:pi session 在 `ison-arch` 上、项目 `pi-xfer`、分支 `main` 的只读调研,2026-10-18。
未改动任何代码;唯一写出的文件是这篇笔记。未联系任何线上部署,`XFER_ALLOW_REMOTE` 从未
设置。外部论断附 URL;仓内论断附 `file:line`。对 `a2a-protocol.org`、
`modelcontextprotocol.io`、`c2c.im` 和 `reasonmachines.com` 的直接 HTTP 抓取被本地 SSRF
guard 拦截(它们解析进 `198.18.0.0/15`),所以那些来源改由搜索服务商提取的页面内容读取
—— 下面的 URL 是这些内容所来自的页面,不是本 session 自己加载的页面。见 §10。

任务是一张地图,不是一份推荐。**这里不推荐、不排名、不偏好任何项目。** §9 把文档化的事实
与我的推断分开;§10 列出无法核查的内容。

---

## 0. 版图如何切分

出现了六个家族。它们沿一条比其他任何轴都重要的轴区分:**谁被允许作为消息的地址。**
一个服务、一个 session、一个 task,还是一台机器。

| 家族 | 代表 | 寻址单位 | 实际解决什么 |
|---|---|---|---|
| **Task 委派标准** | A2A | URL 上的一个*远程 agent 服务* | 跨厂商、带生命周期的 task 委派 |
| **工具调用协议** | MCP | 一个 server 上的*工具* | agent→能力,不是 agent→agent |
| **上述协议之下的传输层** | AGNTCY SLIM | 一个*具名端点*(DID) | pub/sub + RPC + 群组加密作为基底 |
| **本地 coding-agent mesh** | Reason Network、c2c.im、agents-mesh | 一个*活着的 session* | "跟另一个窗口里的那个 agent 说" |
| **宿主原生 session 消息** | Claude Code cross-session socket、Codex app-server | 本机上的一个*session* | 厂商内部的 session↔session 投递 |
| **Agent 网关 / mesh** | agentgateway、Agent Mesh | 一个*发布的服务名* | 治理、身份、策略、可观测性 |

pi-xfer 自己的形态 —— 把一份文档交给一个具名 peer,点对点,没有生命周期 —— 最接近第四行,
不像第一行或第三行。这是关于地图的事实,不是关于哪一行更好的判断。

---

## 1. A2A(Agent2Agent)

**它解决的问题:** 让一个建立在某框架/厂商上的 agent 把*任务*委派给建立在另一个上的 agent,
跨越组织边界,不共享内存。
(<https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/>)

**消息模型。** 明确不是单向。客户端发送 `Message`(role + `Parts`),远程 agent 以无状态的
`Message` 或有状态的 `Task` 响应。`Task` 携带 `id`、可选 `contextId`、`status`、`artifacts`、
`history`,并沿 `submitted → working → (input-required | auth-required) → completed | failed |
canceled | rejected` 推进,且**终态不可变** —— 精化会在同一 `contextId` 里开一个新 `Task`。
(<https://a2a-protocol.org/latest/topics/life-of-a-task/>、
<https://a2a-protocol.org/latest/specification/>)

存在三种更新投递机制:**轮询** `GetTask`、经 `SendStreamingMessage` / `SubscribeToTask` 的
**SSE 流**、以及**推送通知** —— 长任务或断连场景下,server 发起的 HTTP POST 打到客户端提供
的 webhook。(<https://a2a-protocol.org/latest/topics/streaming-and-async/>、
<https://a2a-protocol.org/latest/specification/>)

**有没有显式的 delivered/seen 区分?** 没有消息回执意义上的。协议建模的是*进度*,不是*注意*:
`submitted` 表示 server 已确认,`working` 表示正在处理。没有"agent 读过了"状态,因为在 A2A
里 server *就是* agent —— 一个应答中的 server 按构造已经把工作交给了一个进程。这是文档化的;
我对其缺席原因的解读是推断(§9)。

**身份与发现。** **Agent Card**:一份 JSON 文档,含 `name`、`description`、必填的
`supportedInterfaces`(有序,首选第一个)、`version`、`capabilities`、`securitySchemes`、
`defaultInputModes`/`defaultOutputModes`、`skills`,以及可选 `signatures`(对卡片的 JSON Web
Signatures)。(<https://a2a-protocol.org/latest/specification/>) v1.0 增加了 **Signed Agent
Cards** 用于密码学身份验证。
(<https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>)
发现是 web 形态的:必须先知道 agent 的 URL 才能取到卡。注册表在路线图上,不在规范里 ——
第三方评论把"无注册表"列为长期缺口
(<https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>)。

**在 pi-xfer 采纳的成本。** A2A *server* 是带 SSE 和/或 webhook 回调的 HTTP 端点;A2A
*client* 经 HTTPS 取卡并 POST JSON-RPC。两者都不是 local-socket 形态。pi session 无法在
URL 上寻址,也没有 `Task` 生命周期。让 pi-xfer 说 A2A 意味着加入站入 HTTP 监听和 task
store —— 三样 ADR 0013 明确拒绝的东西
(`docs/adr/0013-xfer-mesh-rivetkit-transport.md`:进程内,无独立 daemon;"上线单元 = 连接单元")。

**成熟度。** 2025-06-23 起由 Linux Foundation 托管
(<https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents>),
v1.0 稳定,声称 150+ 组织,Azure AI Foundry、Copilot Studio 与 Bedrock AgentCore Runtime
原生支持,五种生产 SDK 语言
(<https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>),
并与 MCP 一起移入 Agentic AI Foundation
(<https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/>)。
注意伙伴页面上的厂商支持数字是**项目自己的声称**,而一个第三方追踪器给它打分更低(265 家
厂商中 51 家有自有文档证据,<https://standards.fru.dev/standards/a2a>)—— 两者的差距本身就是
数据。

---

## 2. MCP,从通信方向看

**它解决的问题:** 把 agent(host/client)连接到 *server* 暴露的*能力* —— 工具、资源、
prompt。(<https://modelcontextprotocol.io/specification/2025-06-18>)

**server→client 方向。** 存在三个 client 特性,没有一个叫"给这个 agent 发消息":

- **Sampling** —— server 请 client 运行一次 LLM 补全。**自协议版本 `2026-07-28` 起弃用,
  计划移除**;新实现被指引直接调用 provider API。
  (<https://modelcontextprotocol.io/docs/draft/learn/client-concepts>)
- **Elicitation** —— server 向*用户*要输入,form 模式或 URL 模式;client 必须声明
  `elicitation` 能力。
  (<https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>)
- **Roots** —— 同样在 `2026-07-28` 弃用。
  (<https://modelcontextprotocol.io/docs/draft/learn/client-concepts>)

关键在于,**server 发起的请求不再独立存在**。SEP-2260(status Final)要求
`roots/list`、`sampling/createMessage` 和 `elicitation/create` *与一个发起方 client→server
请求关联*;旧的 server 发起模式"is no longer supported. This is a breaking change",由
Multi Round-Trip Requests 取代
(<https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests>、
<https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr>)。

**为什么通常被读作 agent→tool,而不是 agent→agent。** 两个文档化的原因,一个结构性的原因:

1. MRTR 把 server→client 变成*client 自己请求内部的插曲步骤*,不是主动推送。agent 只有在
   已经在调用那个 server 时才能被触达。
2. 规范自身的 `NOTIFICATIONS` 是单向的,接收方 MUST NOT 响应;它们不是会话。
   (<https://modelcontextprotocol.io/specification/2026-07-28/basic>)
3. Reason Network 从经验上断言:"**MCP notifications are not a delivery path: no client
   passes them to the model (checked Oct 2026)**" —— 这是厂商的声称,不是规范的(引文见下
   §3,出自 DESIGN.md 文本)。

第三方以规范性口吻说同样的话:Akka 的指引把 `Agent → MCP Server → Agent` 标为 ⚠️ Avoid,
理由是 MCP 工具调用"no automatic failover or retry or timeout system"
(<https://doc.akka.io/concepts/inter-agent-comms.html>);另一篇文章论证 MCP "gives you" 生命周期、
发现、异步流或任务中途暂停中的任何一个
(<https://nickperkins.au/article/agent-communication-protocol/>)。一项学术比较发现 MCP *可以*
在受限系统中支撑协调,即可能,但不是被设计的形态
(<https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>)。

**身份与发现。** 只有能力协商(`initialize` 握手,client/server capabilities)。没有 peer
身份,没有 agent 目录。

**采纳成本。** 单方向上实际为零,而这就是陷阱:pi-xfer *已经*把 `xfer_to` 作为工具提供
(pi 里的 MCP 形态,`index.ts:73-95`),所以包一层 MCP server 看起来是免费的。但*入站*的
一半 —— 从外部触达一个 pi session —— 按上述没有 MCP 路径。

**与 pi-xfer 自身历史的关联:** Reason Network 提供 `reason-network mcp` 作为 stdio MCP
server,它是本地 daemon 的*薄客户端*,即把 MCP 用作一个存在于别处的传输的工具面(见 §3)。
c2c.im 用 `c2c-mcp-server` 做同样的事,显式 opt-in(`--with-mcp`)且永远不是有保证的唤醒
路径(<https://c2c.im/architecture/>)。两者都把 MCP 当作*前门*,从不当作线上协议。

---

## 3. Reason Network —— 以及对早前笔记的一次核对

来源:`reason-machines/reason-network` 的 `DESIGN.md`
(<https://raw.githubusercontent.com/reason-machines/reason-network/main/DESIGN.md>),本
session 全文读过;加上 `docs/milestones/notes-reason-network-wake.md` 作为被核对转录的出处。

**它解决的问题:** "a team directory of live sessions with context (person, machine, agent,
repo, branch, busy/idle, what it is doing), so an agent can pick the right recipient instead of
broadcasting and hoping. That is the core of this project; **messaging is the easy part**."
(DESIGN.md,同一 URL)

**消息模型。** `Envelope{id: ulid, from, to, reply_to, thread, body, sent_at}`,直接发送到
每台目标机器,走 iroh QUIC、ALPN `tincan/1`、长度前缀 JSON。接收方持久化后应答
`stored | delivered | held | refused`;之后 `delivered` / `read` 回执回流;发送方保留 outbox
并重试。地址是按 session 的(`alice/api-cursor`),带按机器的限定符(`@xps`);群组地址
(`alice/*`、`repo:acme/api`、`*`)存在但对 **agent 发送方被拒** —— 只有 `<person>/terminal`
发送方可以使用,"so it picks one session."

**Delivered vs seen —— 有,且显式。** 这是调研中唯一一个把回执词汇与投递持久性分开的设计,
外加*按 session 广告的投递层级*(`push` / `turn` / `pull`),发送方由此得知消息*何时*会被
看到。`send` 返回每个接收方的状态与层级,例如 "queued: alice/web-cursor is idle and
turn-only, it sees this when alice next prompts it."

**身份与发现。** 机器身份 = iroh `EndpointId`(ed25519),密钥在
`~/.reason/network/machine.key`。成员资格 = 一份复制的、签名的 **roster**(`admissions`、
`members`、`invites`、`meta`);机器无法自荐;"gate" 丢弃非成员。Presence 是 daemon 的全网状
推送,变化时发 `Presence{machine, seq, sessions[], human_status}`。被动发现:它读
`~/.claude/sessions/<pid>.json`,所以 Claude session 即使不加载它的 MCP server 也会出现
(带 busy/idle)。`doing` 是*推断*的,从不是自我报告(`doing.rs`,来自 transcript 和宿主
todo 文件)。

**采纳成本。** 一个静态 Rust 单文件,运行按机器的 daemon(launchd/systemd 用户服务),外加
它*写进宿主自己配置*的按宿主集成文件(Claude Code 插件或 MCP+hooks、
`~/.codex/config.toml`、`~/.cursor/mcp.json`、`~/.gemini/settings.json`、opencode 插件、
Copilot `mcp-config.json`)。传输是 iroh 1.3 —— 按公钥拨号的 QUIC、hole punching、LAN 上的
mDNS、HTTPS relay 兜底,默认走 **n0 的公共 relay**。

**里程碑状态。** "M0 to M3 are built and tested on macOS (two machines over iroh; real Claude
Code and Codex sessions). **M4 is not started.**" DESIGN.md 默认值一节中的许可证是
`MIT OR Apache-2.0`(关于早前笔记里 Apache-2.0-only 归属的问题见 §10)。

### 3.1 对早前笔记的转录核对

早前笔记的 §2 在所有承重机制上都是准确的:Envelope 字段、`tincan/1`、persist-then-ack 与
`stored|delivered|held|refused`、outbox 重试、mailbox-under-session-name、
`accept|hold|refuse` 入站策略、peer-framing 规则、带同样按 client 机制的三层表,以及
`serve` 描述里的按发送方线程与 warm resume。六处偏差,全部是夸大或遗漏,而非事实错误:

1. **许可证。** 笔记说 "Apache 2.0"(§ 标题与 §6)。DESIGN.md 归属为 `MIT OR Apache-2.0`。
   对潜在复用者而言这个法律差异是真实的。
2. **"`reason network serve claude|codex|grok`"**(§2.3)。DESIGN.md 没有 `serve` 子命令。
   daemon 子命令是 `daemon`、`mcp`、`hook <agent>`,以及
   `who|send|listen|status|init|invite|join|setup|doctor`。笔记里 `serve` 描述的东西
   —— 长驻无头 agent、按发送方线程、warm continuity —— 在 DESIGN.md 里完全不存在。要么
   它存在于笔记另外引用的文档里(`docs.reasonmachines.com/docs/network`),要么笔记把它与
   `listen`/`wait` 混淆了。**这是笔记里最大的一个其引用的一手设计文档不支持的说法。**
3. **"`codex queue --thread`"**(§2.2)。DESIGN.md 写的是 `` `codex queue --thread <id>` /
   app-server `turn/start` `` —— 同一件事,但笔记把它呈现为主机制,而 DESIGN.md 把它列在
   Codex *push*(与 hooks 并列)的第一位。没有矛盾,只是压缩。
4. **pty 注入路径的范围**(§2.4.3)。笔记把它写成 Reason 的"激进的补充路径",带 tmux/herdr
   检测。DESIGN.md 自己的表把 idle 兜底列为*后台 `reason-network wait`*(Cursor)、
   *experimental background-shell inject*(Gemini)和 *`asyncRewake` hook*(Claude)—— 它
   没有描述 tmux-pane nudge。这个概念可能存在于 Reason 更广的 CLI 里;DESIGN.md 不携带它,
   而笔记的"Reason 自己主推 `serve`"框架继承了 §8-2 的问题。
5. **群组寻址**(§2.1;§2.4 未提)。笔记从未提到群组发送(`*`、`person/*`、`repo:`)对
   **agent 发送方被拒**,也没提循环防护(按发送方限速 + 对连续 agent↔agent 消息且无人类
   输入的封顶)。两者都是该文档里与 pi-xfer 最直接相关的安全设计,它们在笔记里的缺席是最
   值得比较部分的遗漏。
6. **成熟度。** 笔记没有记录 M4 未开始,也没记录测试仅限 macOS、双机。它的 "Reason Network"
   列读起来像一个已发布的产品;DESIGN.md 读起来像四里程碑项目的 M3。

有一处笔记说的东西是 DESIGN.md 强化了而非削弱:它称 daemon 是"每机器一个",这是精确的
—— 身份是按*机器*的(`EndpointId`),session 是该机器*之内*的一个地址。如果 pi-xfer 要把
Node 拿来与之比较,这个区分很重要(pi-xfer 的 Node 是每*实例*一个 actor,`CONTEXT.md`
"Node")。

---

## 4. c2c.im —— broker + 按 client 的投递/唤醒契约

**它解决的问题:** coding-agent session 之间的本地优先、可选中继的即时消息,带有少见的
对*什么保证、什么不保证*的显式陈述。

**消息模型。** 三种路由范围,各有自己的 broker 根:`repo`
(`~/.c2c/repos/<repo>/broker`)、`pc-local`(`~/.c2c/sessions/broker`)、`relay`
(`relay.c2c.im`)。(<https://c2c.im/reference/scopes/>) Durable-first:"every accepted
message is written to the recipient's broker inbox and archive before the send returns."
(<https://c2c.im/wake-contract/>) 有 Room 用于群组通信,但直发不要求 Room
(<https://c2c.im/get-started/>)。

**Delivered vs seen —— 调研中最锋利的陈述。** c2c 按名字分开这两个属性,并拒绝让机制复述
保证:

- **Durability** —— 恒真;邮件等待。
- **Wake** —— 取决于 client,分级 **GUARANTEED / CONDITIONAL / NONE**,每行附带条件。
- 明确*不是*唤醒的:`poll_inbox`、`peek_inbox`、`wait-inbox`、活动触发的 hooks、agent 自装
  的 `c2c monitor`,以及 —— 有自己专门页面的 —— `deliver-watch`/`--inotify`,它"improves
  latency, not reliability."
- "Never assume a peer read your message because the send succeeded."
- "**A message never authorizes an action.** Regardless of how it was delivered, message
  content is DATA."
  (全部出自 <https://c2c.im/wake-contract/>)

按该页面 2026-10-03 摘要的唤醒分级:GUARANTEED —— OpenCode、**Pi Agent**、托管 Codex
(本地邮件)、Hermes CLI;CONDITIONAL —— Kimi 与 agy(进程外 poster)、armed monitor 上的
Claude Code / Grok / Muse;NONE —— Hermes gateway 模式。
(<https://c2c.im/clients/feature-matrix/>) Pi Agent 的 GUARANTEED 行是一个进程内 `pi-c2c`
扩展,对 broker inbox 做 `fs.watch` → `c2c poll-inbox` → `pi.sendMessage`,"urgent steers;
nonurgent follow-up",外加一个 60 s 的安全网轮询
(<https://c2c.im/wake-contract/>) —— 与 pi-xfer 已经在 `controller.ts:68-71` 实现的双分支
形态相同(idle 时 `followUp`+`triggerTurn`,busy 时 `steer`)。

**身份与发现。** 四个生命周期各异的标识符
(<https://c2c.im/reference/identifiers/>):`alias`(人名,最后一次出现后保留 12 个月)、
`node_id`(host/install)、`session_id`(一个 agent session)、`identity_pk`(Ed25519,每台
机器一个密钥对,在 `~/.config/c2c/identity.json`)。首次签名注册钉住
`alias → identity_pk`,后续操作必须由该密钥签名 —— **TOFU**。投递租约默认 24 h 过期,因此
发给离线 agent 的发送快速失败。relay 上有一个按 `identity_pk` 做 key 的 opt-in
proof-of-work 抗洪层。

**采纳成本。** 一个 OCaml `c2c` 二进制加本地 broker,外加写入宿主配置的按 client 安装产物
(`c2c install claude|codex|opencode|kimi|grok|agy|hermes|muse`),`--with-mcp` 作为独立的
opt-in。relay 是**托管**的:`relay.c2c.im`,alias 全局共享,`auth_mode=prod`,PoW 开启
(<https://c2c.im/connect/>)。

**范围备注。** Room 成员资格隐含一种 pi-xfer 没有对应物的群组/广播模型;点对点是唯一的
共同形态。

---

## 5. 宿主原生 session 消息

### 5.1 Claude Code 跨 session 消息

**它解决的问题:** 同一台机器上一个 Claude Code session 向另一个 session 警告或回答。

文档化机制(<https://code.claude.com/docs/en/cross-session-messaging>):每个 session 绑定一个
**inbox socket** —— macOS/Linux 上的 Unix domain socket(Windows 上是 named pipe)—— 路径
导出为 `CLAUDE_CODE_MESSAGING_SOCKET`,外加按 session 的 `CLAUDE_CODE_MESSAGING_TOKEN`。
Socket 位于 `$XDG_RUNTIME_DIR/cc-socks/` 之下,目录 0700,socket 0600;路径会超过 103 字节
socket 上限时退回 `/tmp`;非本地路径直接拒绝,活 socket 永不被劫持
(<https://changelogs.core-directive.com/v/2.1.224/e/local-messaging-socket-where-it-lives-who-can-read-it-and-re>)。
按行分隔的 JSON,超过 1 MiB 的行被丢弃。

**身份/发现。** OS 用户范围(socket 限制在你的用户;Windows 改用 token)。不是目录 ——
你必须已经知道或被告知路径。同机消息"never through Anthropic servers";跨机器与云 session
**确实**经 Anthropic 服务器路由。

**Delivered vs seen。** 没有回执。有的是**入站控制**:`crossSessionInbound` =
`accept` | `hold` | `refuse`,外加 `dialogExpiry` 控制被 hold 的消息保留多久。有防循环
防护 —— 按发送方限额、相同重复抑制、至多 50 条排队消息。

**采纳成本。** 低且同时是对抗性的:向一个已知 socket 路径写一行 JSON 很平凡,但这是一个
*未对第三方文档化*的表面,没有能力清单,且受版本门控(按 provider 分别为
v2.1.224+/v2.1.248+)。如果 pi-xfer 学到了路径,它可以这样*寻址*一个 Claude session;
但它无法这样被*发现*。

### 5.2 Codex app-server

**它解决的问题:** 一个 JSON-RPC 控制面,让外部程序驱动一个 Codex agent。

出自 Codex 源码类型
(<https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v1.rs>,
由搜索服务商返回):`InitializeParams{client_info}`、`NewConversationParams{model, cwd,
approval_policy, sandbox, config, base_instructions, …}` → `NewConversationResponse{
conversation_id, model, rollout_path}`,外加 `ResumeConversationParams`、
`ListConversationsParams`、`AddConversationSubscriptionResponse{subscription_id}`、
`ArchiveConversationParams`,以及人工审批往返(`ApplyPatchApprovalParams/Response`、
`ExecCommandApprovalParams/Response`)。也就是说:会话**由一个外部监督者创建并驱动**,审批
是一等公民的 request/response。

**消息模型。** Request/response 加 subscription,不是 peer 消息。没有 "peer" 概念 ——
client 是*控制器*,不是同事。

**身份与发现。** `conversation_id`;client 经 `client_info` 自我标识。

**采纳成本。** app-server 传输之上的一个 JSON-RPC client。c2c.im 报告其 Codex GUARANTEED
路径是到达时 `thread/inject_items` 加"一次被门控的 auto-turn(thread idle、DND off)",
对远程发送方退化为仅 inject
(<https://c2c.im/wake-contract/>) —— 即*门控是 c2c 的*,不是 Codex 的。

---

## 6. 社区 mesh 与网关

### 6.1 agents-mesh(localhost broker)

`localhost:7899` 上的本地 HTTP broker;每个 agent 以 `peer_ac7e701d` 这类 id 自动注册,发送
心跳,然后使用自然语言 MCP 工具:`peers_list`、`peers_ask`(broker 持有消息直到 peer 调
`peers_check`)、`peers_reply`、`peers_notify`(广播)。"All on localhost, no cloud, no
accounts."(<https://github.com/agents-mesh/agents-mesh>,内容经搜索返回的项目自有站点)

**Delivered vs seen。** 隐式的:消息被*持有*到 peer 轮询。那是没有回执词汇的
`queued`/`pull` 模型。发现只看活性(心跳);"what they are working on" 是自我报告。

### 6.2 agentgateway / Agent Mesh

**agentgateway** 是一个开源代理,覆盖 agent-to-LLM、agent-to-tool 和 **agent-to-agent**
(A2A)流量,带 JWT/API-key/OAuth 认证、经 CEL 策略引擎的 RBAC、限流、TLS、OpenTelemetry,
以及 A2A 的 "capability discovery, modality negotiation, task collaboration"
(<https://github.com/agentgateway/agentgateway>、<https://agentgateway.dev/>)。

**Google Agent Mesh** 是一张零信任覆盖网:控制面验证 OIDC/bootstrap token 并签发短寿命
Biscuit 凭据,一个路由器运行 Kademlia DHT 并在不看见明文的情况下中继加密流,一个本地
`agentmesh-node` 发布/调用 `mcp://`、`a2a://`、`inference://`、`egress://` 服务名。
"Nothing is reachable by default";peer 调用的是*已发布的服务名*,不是开放端口
(<https://google.github.io/agentmesh/>)。

两者都是控制面产品。它们的地址单位是服务,它们的价值是策略,而且都预设了一个想要策略的
运维 —— 与"我笔记本上的两个 agent"是不同的问题。

### 6.3 AGNTCY SLIM(传输基底)

一份 IETF Internet-Draft(`draft-mpsb-agntcy-slim-02`,2026-07-07,Informational,无 RFC
stream):gRPC-over-HTTP/2 与 /3 细腰、内容层的 MLS 端到端加密、分层的基于 DID 的名字
(`organization/namespace/service/instance`)、pub/sub + 群组 session + SRPC streaming RPC,
分为 data/session/control 三个平面
(<https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/>、<https://github.com/agntcy/slim>)。
其声明的目的是*充当 A2A 与 MCP 之下的传输*,不是面向 agent 的协议。成熟度:individual
draft,2027-01-08 过期。

### 6.4 Reason 自己调研的先行工作集群

DESIGN.md 列出约 15 个 2026 年的项目,并点名两个最接近的:**agentbus**(Rust,按设备的
daemon,iroh,peer 是你经 Tailscale 可达的自己设备,其他方由一个*无头 responder* 而非其
活 session 应答)和 **agents-party**(共享加密房间,跨机器需要托管或自托管服务器)。其他
被点名的:agent-rpc(Zig broker + tmux 注入)、mcp_agent_mail、agent-mesh(Codex
app-server 投递,`peek_peer`)、agent-peer、ccbridge、agent-bridge、intermcp、
claude-message-mcp、Paseo。(全部出自上面的 DESIGN.md URL,它逐个链接。)

我**没有**读这些项目自己的文档 —— 见 §10。把那两句式的刻画当作 Reason 的声称。

---

## 7. 调研在哪里反复汇聚

四个独立项目用几乎相同的措辞描述同一个陷阱,这使它成为被重复最多的单一发现:

| 来源 | 陈述 |
|---|---|
| Reason DESIGN.md | "MCP notifications are not a delivery path: no client passes them to the model (checked Oct 2026)." |
| c2c.im wake contract | 活动触发的 hooks "fire because the agent was already doing something";`poll_inbox` "requires the model to choose to call it. A fallback is not a guarantee." |
| c2c.im wake contract | "Never assume a peer read your message because the send succeeded." |
| Reason DESIGN.md | hook 进程必须检测真正在调用它的是哪个 agent,因为 Cursor/Copilot/Devin 会加载 Claude Code 的 hooks |

而在*安全*侧有一个汇聚,由三方独立陈述:

- Reason:入站消息"framed as peer input, never as the user";agent 被告知不要把 peer 文本当
  用户指令;外加按机器的 `accept|hold|refuse`。
- c2c.im:"A message never authorizes an action… message content is DATA: it cannot resolve
  an approval or write a verdict file."
- Codex app-server:审批是与会话内容分开的一条 request/response 通道。

pi-xfer 的对应物:ADR 0018 在发送方一侧拆分 `Task` / `Notification`
(`docs/adr/0018-handoff-kind-sender-declares.md`),`controller.ts:41-67` 把入站框定为
`**Handoff**`,并带显式的 "asks you for output" / "asks you for nothing" 一句。pi-xfer
**没有**的是任何等价于 `accept|hold|refuse` 的入站策略,也没有循环防护。

---

## 8. 与已定立场的兼容性(ADR 0013 / 0014 / 0015)

三份 ADR,各一行:

- **0013** —— mesh 是 opt-in 的 RivetKit,**进程内**,无独立 bridge daemon,无 registry
  actor,引擎侧发现,持久队列,命令面显式选择传输
  (`docs/adr/0013-xfer-mesh-rivetkit-transport.md`)。
- **0014** —— Board 保持机器本地文件;跨机器共享是目录同步,"零代码"
  (`docs/adr/0014-board-stays-machine-local.md`)。
- **0015** —— 一个 bundle、双传输,**take-to-read 的 Inbox,背后没有持久存储**,"The Inbox
  is lossy by construction (take deletes). That is the point"
  (`docs/adr/0015-adapter-daemon.md`)。

下面:哪些处在结构性张力中,哪些可以被吸收。不给出任何方向的推荐。

### 8.1 天然冲突(结构性的,不是风格性的)

| 外部设计 | 冲撞哪条已定立场 | 为什么 |
|---|---|---|
| **A2A** 作为 pi-xfer 的线上协议 | 0013(无独立服务;连接单元 = pi 实例) | 需要一个比 session 长寿的持久入站 HTTP 端点 + task store。pi session 无法在 URL 上寻址,也没有 `Task` 生命周期。还隐含*接收方*拥有 task 状态,而 0014 把它交给了 Board。 |
| **SLIM / Agent Mesh / agentgateway** | 0013(无额外永久组件),0014(状态在别处) | 三者都是控制面加路由器的部署。Agent Mesh 显式集中身份与策略;agentgateway 是数据路径中的代理。0013 出于同类理由拒绝了"独立 bridge daemon"和 registry actor。 |
| **c2c.im 的托管 relay**(`relay.c2c.im`、全局 alias、PoW、租约) | 0013(引擎是运维自己的;发现 = 引擎 `listActors`),0019(身份被承认为弱) | 第三方 relay 是*第二个*发现权威和一个共享的全局命名空间。0019 已记录 peer 身份是"actor type name plus a key. No handshake, no credential",并把冒名称为可接受 —— 加一个全局 alias 注册表不修复它,只是搬家。 |
| **Reason Network 的签名 roster** | 0013 的发现决策;0014 的"无生命周期" | 成员资格是复制的、签名的,带 admissions/invites/removal 和一个收敛故事。那是关于"谁存在"的第二事实源,与"引擎调度状态即注册表"竞争。还隐含带生命周期和清理故事的状态,而 Board 刻意拒绝这一点(`CONTEXT.md` "Card":"no lifecycle statuses")。 |
| **持久 mailbox / archive**(c2c archive、Reason 的 mailbox + outbox、A2A `Task.history`) | 0015(Inbox 刻意有损,take-to-read,无持久存储) | 0015 选择了"投递进 session,而非持久 mailbox",并把持久 mailbox 记录为*考虑过且被拒绝*。任何带 `delivered`/`read` 回执流的东西都隐含一个比读取更长命的存储。 |
| **服务端唤醒保证**(c2c 的 GUARANTEED 层级作为 broker 承诺发布) | 0013(崩溃策略是 sleep ⇒ 离线是常态) | 由中心一方对另一方进程做出的保证,正是 0013 通过让连接单元 = pi 实例而避开的"daemon 活着但 pi 死了"歧义。 |
| **Agent Card 作为发现** | 0013(发现是 `listActors`) | 能力声明已经由 actor 上 Node 的自声明 description 携带(`mesh-engine.ts:19-20`),README 称之为 "Unverified self-declaration — routing stays with the consumer"。Agent Card 是同一主张的更重、签名版本。 |

### 8.2 不触碰 ADR 即可吸收的内容

这些是*关于兼容性的事实*;它们不是提案。

1. **按接收方的 delivery verdict 词汇。** Reason 的 `stored|delivered|held|refused` 与 c2c
   的 durability-vs-wake 拆分都完全活在*发送方*的返回值里。pi-xfer 的 `xfer_to` /
   `xfer_mesh_to` 输出 schema(`index.ts:90-95`、`index.ts:171-175`)与常量
   `status: "sent"`(`index.ts:149`、`index.ts:194`)正是接缝,而提供取值的 idle/busy 分支
   已存在于 `controller.ts:68-71`。verdict 不需要 server、注册表或持久化 —— 早前笔记在
   §9.2 与 §8.3 得出同一结论。
2. **Peer-input 框定。** 已实现(`controller.ts:44-67`);Reason 与 c2c.im 的陈述是独立佐证,
   说明这条框定规则是承重的,不是装饰。
3. **Local socket + `--on-handoff` 事件投递。** 这正是 pi-xfer 对 Reason 用层级解决、c2c
   用按 client 集成解决的那个问题的既有答案(`adapterd.src/daemon.ts:110-121` 的 spawn)。
   两个外部项目都确认:进程内或事件触发的投递是唯一不需要模型决定就成立的路径 ——
   c2c.im 的 Pi 行字面上就是一个做着 `controller.ts` 所做之事的进程内扩展。
4. **`hold`/`refuse` 入站策略。** pi-xfer *没有*。Reason 按机器有它,Claude Code 按 session
   有它(`crossSessionInbound`)。它是一个本地文件或设置,因此不与 0013/0014 冲突 —— 但
   它是新表面,而 0018 的"发送方声明,接收方不评判"说的是 *kind*,不是*接受*,所以两者
   不相撞。pi-xfer 想不想要它是产品问题,不是兼容性问题。
5. **循环防护。** *没有*。Reason 的"对连续 agent↔agent 消息且无人类输入的封顶"与 Claude
   Code 的按发送方限额 + 50 条队列,都是本地的、近似无状态的计数器。没有 ADR 挡路;今天
   也不存在任何一个。

---

## 9. 文档化的 vs 推断的

**文档化(上方 URL 或 `file:line`)。** §1–§7 的全部机制;§8.1 的全部 ADR 立场;§8.2 第
1–3 条引用的仓内状态。

**推断 —— 我的,不是那些项目的话:**

- A2A 缺"seen"状态*是因为* server 就是 agent(§1)。规范记录了该状态的缺席,也记录了
  `TaskState`;它没有解释缺席的原因。
- 把 §8.1 的"天然冲突"一列读作*结构性的*。没有任何外部项目说它与 pi-xfer 冲突;到
  0013/0014/0015 的映射是我的。
- 把 `hold`/`refuse` 策略与循环防护的缺席排为最值得比较的两个缺席(§8.2 第 4–5 条)。两个
  外部项目都认为它们必要;pi-xfer 尚未记录立场。
- "`controller.ts:68-71` 的分支恰好提供了层级 verdict 所需之物"这一声称。那是代码阅读
  判断,而且早前笔记已标记两个忙/闲信号(`state.isRuntimeIdle()` vs
  `state.currentStatus`)之间存在未解决的内部冲突,在任何 verdict 被发布为契约之前必须先
  解决它。

---

## 10. 我无法核查的内容

记录在此,以免下一位读者高估这篇笔记。

1. **直接加载页面被拦截**:`a2a-protocol.org`、`modelcontextprotocol.io`、`c2c.im` 与
   `reasonmachines.com`(每一个都解析到 `198.18.13.x`,在 SSRF guard 的 TUN / fake-IP 段内)。
   内容来自搜索服务商对这些页面的提取。URL 是被提取的页面;它们不是本 session 抓取的。
2. **Reason Network 的 `serve` 子命令未经验证。** DESIGN.md 不含它(§3.1 第 2 条)。我没有
   读 `docs.reasonmachines.com/docs/network`、仓库代码或其 release。因此早前笔记的 §2.3
   保持为*可能正确但不被其引用的一手来源支持*。
3. **Reason Network 的许可证**以 DESIGN.md 默认值一节为准(`MIT OR Apache-2.0`)。我没有读
   `LICENSE` 文件或仓库元数据,所以我不能说早前笔记的 "Apache 2.0" 是错的 —— 只能说设计
   文档不是那样说的。
4. **§6.4 的约 15 个先行项目没有被读。** 这里只有 Reason 的两句式刻画。`agentbus` 被描述为
   "no license",这一点我也没有验证。
5. **A2A 的当前 schema** 读自 `/latest/specification` 与 `/latest/topics/*`;`TaskState`
   列表也以 v0.2.5 枚举出现过。我没有 diff v0.2.5 与 v1.0,所以这里关于 A2A 的任何声称都
   应读作"截至 2026-10-18 的 `latest` 页面"。
6. **MCP 版本是有意混用的,值得标记:**`2025-06-18`(features 列表)、`2026-07-28`
   (elicitation、base protocol)、`draft`(MRTR)。Sampling 与 roots 按 draft
   client-concepts 页面在 `2026-07-28` 弃用;我没有读 `2026-07-28` 的 changelog 本身来确认
   弃用日期的确切措辞。
7. **Codex app-server** 读自搜索返回的单个 `protocol/v1.rs`,文件被截断。c2c.im 与 Reason
   都引用的更新的 `thread/start` / `turn/start` 方法**没有**在源码中见到 —— 只有名字,
   经那两个项目转述。
8. **Claude Code 的 socket** 由 Anthropic 针对*它自己的 session* 文档化;我没有找到支持第
   三方进程的陈述,也没有 Reason 说它写入的 `{"type":"user",…}` 帧的 schema 文档。1 MiB
   行上限与 0600/0700 权限来自第三方 release-notes 镜像
   (`changelogs.core-directive.com`),不是 Anthropic 的页面。
9. **没有联系任何部署**,没有运行任何测试。这里没有任何东西是对任何线上系统的测量;
   ADR 0019 自己的测量仍是仓内唯一被测量的数字。

---

## 11. 开放问题

不是决定 —— 是地图提出并留下的问题。

1. **"谁被允许作为地址"是一个决定还是偶然?** pi-xfer 寻址一个具名 Node(`CONTEXT.md`
   "Node");Reason 寻址一个 session;A2A 寻址一个 URL。ADR 0013 为 mesh 选择了其一。
   没有东西记录*session 级*寻址为何未被采纳,而"另一个 agent"说出口时人指的恰恰是 session。
2. **`delivered`/`read` 词汇在哪里不再只是发送方的事?** 两个外部设计都把它留在返回值里。
   如果某个回执必须*比发送更长命*,0015 的 take-to-read Inbox 与 0014 的"状态属于 Board"
   都关系到它住在哪里。
3. **`hold`/`refuse` 是入站策略问题还是 Kind 问题?** 0018 说*发送方*声明 Kind,接收方从不
   评判自己的输出。接收方拒绝接受是另一种评判 —— 关于*接纳*而非*输出*。没有 ADR 谈接纳。
4. **循环防护属于传输还是 agent?** Reason 放在 daemon;Claude Code 放在 session 的入站
   控制。pi-xfer 两者皆无,也没有记录立场。
5. **当第二方写入 Board 时,0014 的"人清理 Board"变成什么?** Reason 的 roster、c2c 的
   broker、A2A 的 task store 都隐含 Board 刻意不具备的清理故事。
6. **MCP 对 sampling 与 roots 的弃用会改变 agent→agent 的故事吗?** server 曾有的触达
   *client 侧*模型的最后几个规范级钩子正在被移除,替换为"直接集成 LLM provider API"。如果
   落地,MCP 变得更纯粹是 agent→tool,而任何未来的桥接原则上也无法再经由它。

---

## 12. 来源索引

Coding-agent mesh 与目录
- <https://raw.githubusercontent.com/reason-machines/reason-network/main/DESIGN.md>
- <https://c2c.im/> · <https://c2c.im/wake-contract/> · <https://c2c.im/client-delivery/> ·
  <https://c2c.im/clients/feature-matrix/> · <https://c2c.im/architecture/> ·
  <https://c2c.im/communication-tiers/> · <https://c2c.im/reference/identifiers/> ·
  <https://c2c.im/reference/scopes/> · <https://c2c.im/get-started/> · <https://c2c.im/connect/> ·
  <https://c2c.im/commands/>
- <https://github.com/agents-mesh/agents-mesh>

标准
- <https://a2a-protocol.org/latest/specification/> · <https://a2a-protocol.org/latest/topics/life-of-a-task/> ·
  <https://a2a-protocol.org/latest/topics/streaming-and-async/> ·
  <https://a2a-protocol.org/latest/topics/key-concepts/> ·
  <https://a2a-protocol.org/latest/partners/> ·
  <https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/>
- <https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/>
- <https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents>
- <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
- <https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html>
- <https://standards.fru.dev/standards/a2a>
- <https://modelcontextprotocol.io/specification/2025-06-18> ·
  <https://modelcontextprotocol.io/specification/2026-07-28/basic> ·
  <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation> ·
  <https://modelcontextprotocol.io/docs/draft/learn/client-concepts> ·
  <https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr> ·
  <https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests>
- <https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/> · <https://github.com/agntcy/slim> ·
  <https://docs.agntcy.org/>

宿主原生
- <https://code.claude.com/docs/en/cross-session-messaging>
- <https://changelogs.core-directive.com/reference/env/claude-code-messaging-socket> ·
  <https://changelogs.core-directive.com/v/2.1.224/e/local-messaging-socket-where-it-lives-who-can-read-it-and-re> ·
  <https://www.turboai.dev/blog/claude-code-env-vars-v2-1-224>
- <https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v1.rs>

网关、基底、评论
- <https://github.com/agentgateway/agentgateway> · <https://agentgateway.dev/>
- <https://google.github.io/agentmesh/>
- <https://doc.akka.io/concepts/inter-agent-comms.html>
- <https://nickperkins.au/article/agent-communication-protocol/>
- <https://the-ai-alliance.github.io/enterprise-MCP/getting-to-know-mcp/mcp-and-everyone-else/>

仓内
- `docs/adr/0013-xfer-mesh-rivetkit-transport.md`、`0014-board-stays-machine-local.md`、
  `0015-adapter-daemon.md`、`0018-handoff-kind-sender-declares.md`、
  `0019-mesh-transport-security.md`
- `CONTEXT.md`(Node / Inbox / Handoff / Board / Card / Delivery verdict)、`README.md:38`
- `controller.ts:32,41-67,68-71`、`state.ts:73-76`、`targets.ts:8,18`、
  `mesh-engine.ts:18-23`、`adapterd.src/daemon.ts:36-41,110-121`、`constants.ts:16`、
  `index.ts:73-95,149,171-175,194`
- `docs/milestones/notes-reason-network-wake.md`(被转录核对的笔记)
