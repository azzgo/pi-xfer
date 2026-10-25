> 中文版 · 英文原文：[phase3-features.md](phase3-features.md)

# Milestone 3 — refine mesh(已批准的特性清单)

> Brainstorm 于 2026-10-17 关闭,用户已批准。范围:mesh 传输,在它从「有文档但从未
> 实战」走到 Cloudflare Tunnel 后面的真实部署之后。下一个节点:design。
>
> 证据链(全部为本轮收集,只读或现场):
> `notes-mesh-transport-encryption.zh.md`(传输安全、加密、隧道成本、实测)、
> `notes-mesh-peer-identity.zh.md`(peer 识别)、`notes-mesh-boundary-extension.zh.md`(CF actor、
> 手机作为输入源)。

## 这个里程碑为什么存在

mesh 是围绕引擎侧发现和持久队列设计的(ADR 0013),而很长一段时间里没有人让它在足够
敌对的现实里跑过。这一轮它被真正部署了 ——
`https://engine.example.com/` 经 Cloudflare Tunnel —— 于是暴露出三件设计此前
从不需要回答的事:

1. **一个什么都收不到的节点,看起来和一个能收的节点一模一样。** 列出了四个 actor,
   全部报告 `Sleeping`,其中只有两个挂了 runner。差别存在于引擎的
   actor 记录(`error: no_envoys`)和 `/envoys` 里,而两者都没有暴露给用户。
   于是第一次发送花掉 30 秒超时和一个错误的假设。
2. **peer 身份就是 actor 类型名,别无其他**(`xfer-instance` + 一个 key)。没有
   握手,没有凭证。同 namespace 的 actor 可以被列出,并能以明文接收 handoff。
3. **这条路径上没有任何东西由我们加密,也不是 Rivet 加密的。** TLS 纯粹是
   `endpoint` scheme 的函数,control plane 默认说纯 HTTP,admin token 是根
   凭证。部署指南现在写明了这一点;代码对「传输不可信」仍然没有答案。

第 1–3 项是本里程碑的核心,P0-D 记录了它们所蕴含的姿态。第 3 项通过
**拒绝**应用层加密于 2026-10-17 得到解决(见下方 P1-C)—— 传输
安全仍然是部署关注点,而 P0-D 的 ADR 就是记录该决定的地方。P1-E(把
Cloudflare actor 作为普通 mesh 节点)是用户在初稿之后加入的实验性交付物:闭环、文档、
以及一个提交的示例。桌上其余一切都在下方被有意记为 out of scope,
以免下一轮重新争论。

## 有序清单

### P0-A — Mesh 节点状态:「这个节点能收到 handoff 吗?」

**问题。** `/xfer mesh list` 只打印名字(`commands.ts:384` 映射 `n.name`),而 `peers`
把每个 actor 都报为 `Sleeping`,即使其中两个没有 runner、无法被唤醒。用于区分的
事实已经被取到又被丢弃:actor 记录里的 `MeshNodeInfo.status`,加上 `/envoys`
(逐 pool 的活跃 runner、`last_ping_ts`、`last_rtt`)。用户今天唯一的信号是按下
发送后的 30 秒超时。

**方向(已定)。** `mesh list` 变成四态表 —— `●` running/可投递、`◐`
sleeping/可投递、`○` 其 pool 内无 runner、`⚠` pool 有 runner 但 actor 记录
不一致 —— 并新增一个仅针对自身的 `mesh status`,回答「*我*是什么状态」,在
**有或没有 `up`** 时都可用(与 `list` 一样)。曾设计过一个 `✕ destroyed` 状态随后被砍:两条列表
路径都过滤 `destroy_ts`,所以它永远渲染不出来。数据来自 `/actors` + `/envoys`
并行,各 6 秒。

**验收。** 停掉某个 pool 的 runner 后,该界面把那个节点的判定标为 *no runner*
并指名 pool —— 而绝不指名节点 —— 作为原因;活跃节点绝不会被标成与
无 runner 节点相同的状态。`/envoys` 失败时,每一行渲染为 `?`,绝不显示 "offline",也绝不
显示 "no nodes"。密封测试覆盖从原始字段(`connectable_ts`、`sleep_ts`、
`error`、`runner_name_selector`)结合伪造的 `/envoys` 推导四态。

**发现的约束。** `deriveActorStatus` 把**任何**非空 `error` 映射为 `"Crashed"`
(`mesh-engine.ts:79`)—— 对 `no_envoys` 来说是错的,那里 actor 处于 `sleep_ts` 休眠状态,
失败的是调度。该界面必须从原始字段推导,而不是用那个辅助函数。`listMeshNodes`
(`mesh-engine.ts:328`)还**丢掉了 `pool`**,即与 `/envoys` 的连接键;必须补上它,
t011 的 observer 路径也需要同一个字段。`slots` 是剩余容量,不是存活状态 —— 绝不暴露。

**注意。** 这是 TUI 里用户可见的输出 → 适用 `verify` skill。

### P0-B — 对端真实性与发送前的快速检查

**问题。** 同一个缺口的三张面孔。

- 发现机制信任一个 actor 类型名,所以同 namespace 里伪造的 `xfer-instance`
  与真实节点无法区分(`notes-mesh-peer-identity.zh.md`)。**已接受,未修复** —— 见
  P1-C 的拒绝;它只在部署层面得到缓解。
- 向一个不是 pi-xfer 节点的目标发送,与向一个仅仅在休眠的节点发送,失败方式
  相同:30 秒,然后 "target may be offline or stuck"(`mesh-engine.ts:237,279`)。
- **而且这个失败是含糊的,不是否定性的。** 2026-10-17 现场证实:发往 `phone` 的 handoff
  `mvbsq4ja-5dnpgd` 被报告为 30 秒 enqueue 失败,而当那个 pool 里出现一个 runner
  之后它还是被投递了 —— `phone` 回显了 nonce 并指名了那个确切的
  id。`mesh.log` 里有错误行,没有成功行。所以今天发送方被告知「失败」的消息
  实际到达了,而用户最自然的反应(重试)会产生第二次、真正重复的投递,
  带着新的 id。

**方向(已定)。** 硬性发送前检查,而不是探针:并行 `/actors` + `/envoys`,
**各 6 秒**,当目标 pool 无 runner 时阻塞发送 —— **没有 override 路径**。这
花费约 1 秒且不唤醒任何东西。不构建协议探针:actor 类型名已经对
peer 做了分类,而 `/actors` 不暴露状态(`include_state` → 400),所以读一个标记每个节点
要花 4.4 秒的 actor 唤醒。一个自声明的 `protocol` 字段仍然会写入以备将来使用和诊断,
但**没有任何逻辑读它**,治理它的规则是:**字段缺失意味着未知,绝不意味着
不支持。**

**一个重新框定该机制的发现:** 网关自己的 actor-ready 等待约 30 秒 —— 与
`QUEUE_SEND_TIMEOUT_MS` 相同 —— 并返回 `503 guard.actor_ready_timeout`。所以耗时
无法区分「客户端超时」与「引擎说这个 pool 没有 runner」;只有错误**码**能。
`queueSend` 目前把它丢弃,把每个失败都字符串化为 "target may be offline or stuck"。

**验收。** 向无 runner 的 pool 发送在约 1 秒内返回并指名该 pool,而不是 "stuck"。发送
被接受、随后以 `guard.actor_ready_timeout` 应答的是**未投递**(引擎说它
从未进入队列)。发送被接受但客户端等待过期的属于**unknown**,必须
如此呈现 —— 绝不 "not delivered",绝不 "retry"。重试仅由用户发起,复用
**原始 handoff id**,并被标记为恢复探针,而不是修复。

**接收侧。** 按 handoff id 去重:actor state 中一个 **3 条滑动窗口**(若真实日志
不符则改回 10),在 deliver **之后**记录,这样崩溃只会重做工作,而不会丢掉
handoff。命中时丢弃,并记一行 `mesh duplicate` 日志,检查发生在写 `/tmp` 文档之前。
窗口边缘的重投递按决定接受。

### P1-C — 已拒绝:不做应用层加密(2026-10-17 决定)

**状态:按 ROI 拒绝,不是推迟,也不是在压力下削减。** 请把本节读作
决定记录;没有新证据不要重新开启它。

**提议的是什么。** 每个节点一对 X25519 密钥发布在 actor state 中,每份 handoff 一个
临时发送方密钥,ECDH → HKDF-SHA256 → ChaCha20-Poly1305,以及带外信任
`/xfer mesh trust <name> <fingerprint>`,首次接触用 TOFU。

**为什么被拒绝。** 这个比较在错误的方向上是不对称的:

| 方案 | 保护什么 | 成本 |
|---|---|---|
| E2EE 信封 | 仅 handoff 负载 | 密钥对生命周期、一个构造上就可被利用的 TOFU 窗口、需永远维护版本的信封格式、重放处理、一份新 ADR、持续维护 |
| Tailscale / EasyTier | **整条链路** —— 负载、admin token、control plane、RPC 元数据 | 装一次,零代码 |
| TLS 终结边缘(Cloudflare Tunnel) | 线上流量 | 零代码,但边缘运营方可以读到一切 |

最便宜的方案保护得最多。信封还会带来一个永久的安全面
—— 静态密钥材料、首次接触信任窗口、一个带版本的格式 —— 而部署对象只是
一个运营者自己的机器,不是共享的多租户 control plane。

**被接受而非修复的后果。** 活跃 pool 里的外来 `xfer-instance` actor 仍然
与真实节点无法区分(P0-B 的冒充那一半)。信封本来是能
堵住它的东西。这现在是一个**文档化的已接受风险**,只在部署层面得到缓解
(把引擎置于不可信网络之外)。不要把它当作 bug 提报。

**被移到别处的东西。**
- **接收侧去重保留下来**,作为 P0-B 下的独立条目。它从来不是加密关注点:
  P0-B 的重试复用原始 handoff id 以便追溯,而持久队列可能重投递一条
  runner 在 ack 前就死掉的消息 —— 所以同一份 handoff 可能被应用两次。
- **P0-D 的 ADR 现在承载该决定**,包括部署形态排序和已接受的
  冒充风险。没有后继文档可指。

**这不会重新开启什么。** ADR 0013 的传输选择不变;负担只是转移到
部署上,这正是 P0-D 的 ADR 必须明确说明可接受形态的原因。

### P0-D — 记录传输安全姿态(仅文档)

**问题。** 「传输安全是运营者的职责;pi-xfer 不发布任何加密;一个 TLS 终结
边缘能读到你的流量」现在写在 `docs/guides/mesh-setup.md` 里,但不是作为一项决定。下一个
人会重新推导它,或者因为 mesh 搬到 HTTPS 了就默默假设它是安全的。

**方向。** 一份简短的 ADR(或在 mesh-transport ADR 中一个明确的已接受风险小节)
写明:不发布应用层加密;TLS 是 endpoint scheme 的函数;control plane
说纯 HTTP;admin token 是根凭证;运营者拥有传输。包含可接受的部署
形态,以及此处测到的两条隧道事实(每次 RPC 成本约 1 秒;native runner 持续
ping,所以边缘空闲超时到不了它)。

这份 ADR 现在是加密姿态的**唯一**所在(P1-C 已被拒绝),所以它必须
把边界写为已定,并承载部署形态排序:协议级隧道
(Tailscale/EasyTier)优先于 TLS 终结边缘,因为边缘运营方位于信任
模型内部。它还必须记录已接受的开放风险:外来的 `xfer-instance` actor
与真实节点无法区分。

### P1-E — Cloudflare actor 作为 mesh 节点(闭环、文档、示例)

**机会。** 第一个维持在线零成本的 mesh 节点:一个 serverless pool 承载一个
`xfer-instance` 实现,桥接到 Durable Object 内的 Pi Durable harness,于是该
节点在有活时醒来,否则不存在。预期用途是用户自己的:按计划唤醒、采集并总结,
并在值得告诉某人时 —— 通过 mesh 向一个常驻 agent 发送 handoff。寻址仍然是
`actor type + key`;省略 `poolName` 的发送方可以跨 pool 到达它。背景与可行性论证见
`notes-mesh-boundary-extension.zh.md`。

**可行性:已确认(2026-10-17)。** rivetkit 2.3.26 提供一等 serverless 路径:
`registry.handler(request)` 和 `registry.serve()` 是公开的,边缘宿主自动选择 wasm
runtime(`src/registry/native.ts:229`)而不触碰 native addon。三处 wasm 拒绝
(`startAndWait` → "do not host an envoy";`listen()`;本地 SQLite)的作用域是 envoy 和
listener,所以 ADR 0013 的禁令到不了 serverless registry。Queue、state 和 action
面都有 wasm 对等能力 —— 一个 `xfer-instance` actor 无需改变形状即可移植。

**交付物 —— 三件,不多于此。**

1. **一个已验证的闭环。** 把 `xfer-instance` actor 部署到 Cloudflare Workers,注册一个
   指向它的 `serverless` runner-config,从本地节点 `mesh send` 进去,再把 handoff
   收回来。
2. **文档。** Pool kind 与寻址;serverless actor 必须遵循的纪律(收到即回
   —— 不阻塞 run loop 地入队;跨调用无内存态,所以以后需要的东西都要
   走 DO 自己的持久化);为什么这样的节点是缓冲工作的好*目的地*、
   却是差的*来源*(无读侧,一旦睡下就无存在感);运维前提与
   记录在案的边界。它不得模糊两层持久化:rivetkit 的
   actor state 位于引擎侧的远程 SQLite(在 wasm 下被迫如此),而 agent 自己的状态
   位于 Durable Object。
3. **一个提交在 `examples/` 下的示例** —— 一个 Quick Start:一个运行 **DeepSeek
   agent loop** 的 Durable Object,接收 handoff 并回信给发送方。先做到无需 API key 即可运行(一个
   固定 echo),这样在任何凭证配置之前就能证明 mesh 路径。

**范围线。** 本仓库保证的是**一个能加入 xfer mesh 并干活的 agent**。那个 agent
实际做什么 —— 定时唤醒、采集、总结 —— 是平台相关的,属于读者自己的 agent
仓库,所以示例止步于 round trip。

**明确为实验性,不是受支持的特性。** 无 SLA、CI 中无网络测试、跨 rivetkit 大版本
无承诺。**横幅放哪:** 文档页和代码注释,但**不放** README —— 会变动的是
rivetkit 的 serverless 接口,而能力本身是稳定的,所以 README 平铺直叙地声明支持。
示例可以带自己的 npm 依赖(它不是扩展);要明确说明,以免它被当作先例。

**设计中发现的开放项 / 约束。**

- **打包是未测试的风险。** npm 只发布 `--target web` 的 wasm binding;Cloudflare 的
  `pkg-cloudflare` target 是构建脚本,不是产物,而 `@rivetkit/cloudflare-workers` 不是
  2.3.26 的依赖 —— 所以要走的是裸 `runtime: "wasm"` + `registry.handler()` 这条路径。
- **`ensureRunnerPool()` 硬编码 `{ normal: {} }`**(`mesh-engine.ts:311-325`),无法创建
  serverless pool。CF pool 在带外注册;任何命令都不应指向它。
- **跨 pool 发送不需要 escape hatch** —— 现场验证:`get` 按 key 寻址 actor,
  与它属于哪个 pool 无关(从一个 pool 向另一个 pool 中的节点发出的请求返回 200)。上面的顾虑
  撤回。
- **验证是唯一的真实部署例外**(记录在 `AGENTS.md`):Durable Object
  没有本地替代品,所以闭环通过一份人工、书面的流程来证明,该流程留在
  `npm test` 之外,也留在每个脚本之外。

**已交付(2026-10-18)。** `examples/cf-serverless-node/` —— 一个 Worker,在 rivetkit 的 wasm
runtime 里托管 `xfer-instance` actor,桥接到一个运行存根 agent 的 Durable Object
(`answerHandoff()`:固定 echo,或设置 key 时一次 DeepSeek 调用)。闭环在真实部署上
人工验证,流程在 `VERIFICATION.md`。

**没有**交付的是上面 Opportunity 里的 Pi Durable 那一半:Durable Object 内不运行任何
Pi Durable harness,也没有任何东西依赖它。示例是传输;`POST /agent/answer`
背后的 agent 是留给读者填的接缝。该目录于 2026-10-22 从
`examples/pi-durable-cf/` 改名为 `examples/cf-serverless-node/`,以免名字
承诺示例并不包含的 agent 框架 —— 指南也随之移到
`docs/guides/cf-serverless-node.md`。

## 本里程碑的 out of scope

| 条目 | 为何不是现在 |
|---|---|
| **手机作为仅推送的输入源** | 仅为思想实验。原生 iOS 无法承载 runner(无 native addon),Android/Termux 被用户排除,所以剩下的唯一角色是无读侧的传感器输入。不是本里程碑。 |
| **移动端的 native runner** | 技术上被排除:rivetkit 的 envoy 需要 native addon;wasm 不是选项。 |
| **引擎侧常驻 runner** | 被 ADR 0013 否决;不重新开启。 |
| **复用 paseo-relay 的传输** | 它的 session 模型是仅在线、随机 hex ID —— 无持久队列、无可发现的名字,所以它会恰好删掉 ADR 0013 提供的东西。它的 E2EE 信封是唯一被借用的想法,随后也按 ROI 被拒绝(P1-C)。 |
| **密钥轮换、多设备、群组 handoff** | 无意义:应用层加密被拒绝(P1-C)后没有密钥材料可轮换或共享。只有加密被重新考虑时才重访。 |
| **通过隧道暴露 `/ui`** | 运营者动作(在 Cloudflare Access 上做门禁),不是代码改动。记录在配置指南里。 |

## 验证职责

- 按 AGENTS.md,`npm test` 全绿、密封 —— mesh 测试不得触碰开发者真实的
  `~/.pi/xfer` 状态或在线引擎。
- P0-A 是可见的 TUI 输出:运行 `verify` skill。
- 接收侧去重(P0-B)需要密封测试:同一 handoff id 投递两次,
  断言只应用一次 —— 无网络,不用真实 `~/.pi/xfer`。
- 真实部署可用于端到端检查,但绝不能成为测试依赖,也
  绝不接入脚本或子代理的默认指令(见 `AGENTS.md`)。唯一的例外
  是 P1-E 的示例,它没有其他方式可以验证。
- P1-E 通过书面流程验证,而不是 CI:闭环需要公网引擎、
  一个已部署的 Worker 和隧道。把它排除在 `npm test` 之外是有意的 —— 全绿的测试套件
  不得依赖其中任何一项。
