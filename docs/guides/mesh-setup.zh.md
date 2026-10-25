> 中文版 · 英文原文：[mesh-setup.md](mesh-setup.md)

# Mesh 配置 —— 跨机 handoff

Mesh 是 pi-xfer 用于在机器之间投递 handoff 的可选传输：每个加入的 pi 会话都成为一个 **Node**——[RivetKit](https://rivet.dev) actor 网络中的一个 actor，具备引擎侧发现和持久队列，因此即使目标 Node 在发送时离线，handoff 也能送达另一台机器上的它。本地 Unix socket 投递不受影响，仍是默认路径。为何这样构建：[`docs/adr/0013`](../adr/0013-xfer-mesh-rivetkit-transport.zh.md)。

> **部署之前：** pi-xfer 不加密 handoff 载荷，而 Rivet 的引擎说的是明文
> HTTP，除非你在它前面放 TLS。先读
> 传输安全是你的责任。

![Mesh 架构](assets/mesh-architecture.svg)

上面这张静态图是完整交互式图的导出——**[打开交互式图](assets/mesh-architecture.html)** 可平移缩放、查看逐节点源码引用，以及深色主题。

## 开始之前你需要什么

Mesh 需要一个每台机器都能访问的 **Rivet 控制平面**（引擎）。pi-xfer 不自带；你可以用 Rivet 的托管云，也可以自己跑一个。有了它之后，所有配置都在一个文件里完成：`~/.pi/xfer/mesh.config.json`。

> **并非每个节点都是常开的机器。** 一个 Cloudflare Worker 可以承载一个只在有活时才存在的
> 节点——见 [Serverless Cloudflare 节点](cf-serverless-node.zh.md)。它用同一个引擎和
> 同一批命令，但它的 pool 以不同方式注册（带外进行），所以在把 `mesh setup` 指向它之前
> 先读那一页。

## 第 1 步 —— 搞到一个控制平面

两条路线。选一条。

### 路线 A：Rivet Cloud（托管）

1. 在 [dashboard.rivet.dev](https://dashboard.rivet.dev) 创建一个项目。
2. 打开 **Connect**，复制后端地址和凭据。控制台给你的是一个形如 `https://my-namespace:sk_xxxxx@api.rivet.dev` 的字符串；**把它拆开**——pi-xfer 不再接受 endpoint URL 里内嵌的凭据。
3. 把各部分放进各自的字段：`endpoint` 变成 `https://api.rivet.dev`，`namespace` 变成 `my-namespace`，token 变成 `token`（或者更好，用 `"token": "$RIVET_ADMIN_TOKEN"`，这样它根本不在文件里）。见不是字面量的值。

参考：[Rivet Cloud 文档](https://rivet.dev/docs/deploy/cloud/)。

### 路线 B：自托管控制平面（VPS / 单节点）

遵循 Rivet 的指南：[部署自托管控制平面](https://rivet.dev/docs/deploy/self-host/control-plane/)。快路径是单个 Docker 容器；要持久化就在一个节点上选文件系统（RocksDB）后端——这正是 pi-xfer 的 mesh 所假设的配置（见 ADR 0013）。

引擎起来后，你需要从部署里拿到三样东西：

| 你需要 | 它从哪来 | 填进哪 |
|---|---|---|
| 从每个要加入的机器都能访问的**引擎 URL**（例如 `https://engine.example.com`；`http://` 只在私有网络上可接受——见传输安全） | 你的反向代理 / 防火墙配置；控制台位于 `<engine-url>/ui` | `endpoint` |
| **Namespace**（例如 `default`） | 你引擎的 namespace 配置 | `namespace` |
| **Token**（你配置的 admin token） | 引擎配置——见[配置文档](https://rivet.dev/docs/deploy/self-host/control-plane/configuration/) | `token`（当前引擎要求必填——自 2026-09-29 起认证默认开启；只有设为 `auth.insecure_allow_unauthenticated: true` 的引擎才接受匿名流量） |

注意：自托管引擎还可能要求每个 namespace 先做一次性的 **runner config** 配置，之后才接受 runner（见 [Workers → 自托管](https://rivet.dev/actors/self-host/workers/)）：

```bash
curl -X PUT "http://<engine-host>:6420/runner-configs/default?namespace=default" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"normal":{}}}}'
```

如果 `mesh up` 连上了、但节点随后启动失败，这通常就是嫌疑犯。

## 传输安全是你的责任

**pi-xfer 不加密任何东西，Rivet 也不替它加密任何东西。** 这是一个已定的决定，不是一个
未完成的事项——应用层加密被考虑过并被否决，因为协议层隧道以严格更少的工作保护了严格更多的
东西（[ADR 0019](../adr/0019-mesh-transport-security.zh.md)）。Handoff 文档
以明文传输，引擎 admin token 以普通的 `Authorization: Bearer …` 头（以及
WebSocket 子协议）传输，你为离线节点获得的持久化就是躺在引擎数据库里的明文。TLS 完全由你的
`endpoint` scheme 决定：`https://` 给你 `wss://`，`http://` 给你一个未加密的 socket。

这就把传输变成了一项你自己拥有的部署决定。由此有两个后果：

1. **绝不要把引擎端口（`6420`）直接暴露到互联网。** Rivet 自己的文档说控制平面
   “说的是明文 HTTP”，并期望一个反向代理或负载均衡器在它前面终结 TLS，而且端口 `6420`
   要么“在 TLS 之后”暴露，要么根本不暴露。
2. **那条路径上的中间人得到的不止你的 handoff。** 任何能读线的人都能读到 admin token——
   那是引擎的根凭据：每个 namespace、每个 actor，不可限定范围，不重启引擎就无法吊销。他们
   还能读到每一份 handoff 文档、在传输途中改写它（没有完整性校验），或者注册一个同名的
   `xfer-instance` actor 来拦截发给你的流量。

可接受的形态，从最便宜的开始：

| 形态 | 给你什么 | 代价是什么 |
|---|---|---|
| **私有网络**（WireGuard / Tailscale） | 引擎完全不在公网上；不需要 DNS 或证书 | 每台机器都必须加入 VPN |
| **在 `6420` 前面做 TLS**（Caddy / nginx + 真证书） | 从每个节点到你的代理端到端 `https://`/`wss://` | 一个主机名、一张证书、一个能容忍长连接 WebSocket 的代理 |
| **一个终结 TLS 的隧道**（例如 Cloudflare Tunnel） | 无公开入站端口，边缘提供 HTTPS/WSS 且无需处理证书 | 隧道提供商终结 TLS，因此它能读到你的流量；见下 |

无论你选哪个，**这是你的责任，不是 pi-xfer 的**——扩展无法检测缺失的 TLS 层，会欣然在明文
HTTP 上运行。如果你是唯一的操作者，你可以认定在可信网络上风险可接受；其他任何读到这里的人
都应当假定它不可接受。

按它们实际保护的东西排序，**协议层隧道（Tailscale / EasyTier / WireGuard）胜过一个终结
TLS 的边缘**：边缘位于你的信任模型内部，会读取它转发的一切，而点对点隧道端到端地保护载荷、
admin token 和控制平面。还有一点值得知道：同名的 `xfer-instance` actor 无法与真实节点区分，
在这些形态中的任何一个上都依然如此——这是一个被接受的限制，不是配置问题。完整推理与被接受的
风险：[ADR 0019](../adr/0019-mesh-transport-security.zh.md)。

### 如果你在边缘终结 TLS（Cloudflare Tunnel 之类）

隧道隐藏了引擎端口并提供了 HTTPS，但边缘现在成了你威胁模型的一部分：它会解密连接以便转发，
所以它像中间人一样能看到明文 handoff 和 admin token。这不是隧道的 bug——这就是“TLS 在此终结”
的含义。如果这不可接受，就在应用层加密（pi-xfer 尚未这样做——E2EE 是一个开放的候选事项，不是
已发布的特性），或者把引擎放到私有网络上。

在你承诺使用隧道之前，有两条运维上的注意事项值得知道：

- **长连接 WebSocket 会被切断。** Cloudflare 文档里说明了被代理 WebSocket 的空闲超时，非
  Enterprise 计划无法提高它（普遍观察到约 100 秒静默），而且它会在部署时重启边缘服务器，断开
  连接。**你不需要在 pi-xfer 侧添加心跳**：原生 runner 自己会持续 ping 引擎（`last_ping_ts`
  保持 1–3 秒新鲜），所以边缘的空闲超时不会触及 runner 注册。被切断的 gateway socket 只是
  重连；你会注意到的是延迟，而不是心跳缺失。
- **控制台也一并暴露。** 引擎在 `<endpoint>/ui` 提供它的管理 UI。指向引擎的公开隧道也会暴露
  它；把该主机名挡在提供商的访问控制之后，或者根本不公开它。

## 第 2 步 —— 配置 `~/.pi/xfer/mesh.config.json`

每台加入 mesh 的机器都在自己的 home 目录里写这个文件。

| 字段 | 必填 | 它是什么 |
|---|---|---|
| `endpoint` | 是 | 控制平面 URL，永远是普通字面量。**URL 里的凭据（`https://ns:token@host`）会被拒绝**——见迁移说明。 |
| `namespace` | 否 | 你的节点所在的隔离环境。引擎侧默认 `default`。字面量或 `$ENV_VAR`。 |
| `token` | 否 | 引擎的认证 token（Rivet Cloud 的 `sk_…`；自托管上的 admin token）。以 `Authorization: Bearer …` 发送。字面量、`$ENV_VAR` 或 `!command`——见下文。 |
| `pool` | 否 | 本宿主 runner 加入的 Envoy/runner pool。在混合舰队上把它设成机器/主机名，好让引擎只能把这个 Node 的 actor 调度到这台机器上。不设 = 引擎范围的 `default` pool，引擎可能把 actor 放到任意宿主上（见 per-host pools）。 |

最小示例：

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "your-admin-token"
}
```

### 编辑器补全：把 `$schema` 指向仓库里的 schema

这个文件的形状被发布为一份 JSON Schema，所以你可以在输入时获得键补全和校验。在顶部加一行：

```json
{
  "$schema": "https://raw.githubusercontent.com/azzgo/pi-xfer/main/src/mesh/mesh.config.schema.json",
  "endpoint": "http://engine.example.com:6420/",
  "namespace": "default",
  "token": "!pass show mesh-token",
  "pool": "laptop"
}
```

支持 JSON Schema 的编辑器（VS Code、JetBrains、Neovim + `jsonls`）随后就会
补全 `endpoint`/`namespace`/`token`/`pool`、标出诸如 `tokn` 的拼写错误，并
显示描述——包括下面三种 token 形式。pi-xfer 本身**忽略** `$schema`；它是编辑器提示，永远不会
成为配置的一部分。

这个 raw URL 跟随 `main`，所以它提供的总是最后推送的内容——schema 改动一旦落到分支上就生效。
要固定版本，把 `main` 换成某个 tag 或 commit。

### 不是字面量的值

`token`（以及 `namespace`）接受与 pi 自己 `models.json` 中 `apiKey` 相同的三种形式——见 [pi 的 models 文档](https://github.com/earendil-works/pi/blob/main/docs/models.md)。这些语义是 pi 的，刻意如此：你写的每个配置文件都只用一种方言。

| 写成 | 含义 |
|---|---|
| `"your-admin-token"` | 字面值 |
| `"$MESH_TOKEN"` / `"${MESH_TOKEN}"` | 插值一个环境变量；字面量可以围绕它（`"sk_${PART_A}${PART_B}"`） |
| `"!pass show mesh-token"` | 把其余部分**作为 shell 命令**执行，并使用其去除首尾空白后的 stdout |

两个细节值得知道，都继承自 pi：

- `$$` 产生一个字面 `$`，`$!` 产生一个字面 `!`，因此一个值本身可以以美元符号开头而不会被
  读作引用。
- 一个未设置的 `$NAME` 是**错误**，不是空字符串。发给引擎的空 token 会以令人困惑的 401
  失败；把变量名说出来才是诚实的答案。

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "!secret-tool lookup service rivet-engine"
}
```

```json
{
  "endpoint": "https://engine.example.com",
  "namespace": "default",
  "token": "$RIVET_ADMIN_TOKEN"
}
```

**它何时运行，以及这要花什么代价。** 每次 mesh 真正与引擎通信时都会求值一次 `!command`——
在 `/xfer mesh up` 时，以及在任何需要该凭据的发送、列出或检查时。不做缓存，与 pi 一致
（“命令在请求时运行，不缓存”），所以一个被轮换或会过期的 secret 会在下一次操作时被取到，
而不是被冻结整个会话。读配置*不是*这样一个时刻：解析只记录写的是哪种形式，所以像
`/xfer mesh status` 这样的纯展示界面从不启动任何东西。

失败、以非零退出、或什么都不打印的命令会按名字被报告
（`mesh config "token": mesh token command "!…" …`），绝不会被悄悄变成空 token——包括
它写出的唯一东西去了 stderr 的情况。整条命令有 10 秒，之后被杀死。

**它在哪里运行：在发起者的 cwd 里。** 一个 `!command` 继承触发它的 pi 会话、守护进程或
CLI 的工作目录——与你在那个 shell 里敲的一行相同。所以**其中的相对路径是不稳定的**：
`"!./get-token.sh"` 会相对于你碰巧打开的那个仓库解析，而那通常*不是*存放
`mesh.config.json` 的目录。同一份配置于是从一个项目里能用、从另一个项目里失败，而且
（在这被按名字报告之前）失败会表现为“token 无效”而不是“那个文件不在这里”。

**用绝对路径、`$HOME`，或 `PATH` 上的命令**——`"!$HOME/bin/mesh-token"`
或 `"!pass show mesh-token"`。相对路径不会被做成能用：没有任何目录可以安全地作为解析基准
（配置文件是数据，不是代码，pi 运行 `models.json` 命令时也用进程的 cwd）。每次失败都会
说出 cwd 和它用的 shell，所以原因在错误里可见：

```
mesh config "token": mesh token command "!./get-token.sh" produced no token
(exit code 127; cwd "/home/me/other-project", shell /bin/zsh) — no such file or directory
— a relative path inside the command resolves against the cwd above; use an absolute path or $HOME
```

> **安全边界。** 一个 `!command` 以你自己的权限运行，所以**对 `mesh.config.json` 的写权限
> 等同于以你的身份执行代码的权限。** 这实实在在地改变了这个文件的本质：它以前是惰性数据。
> 保持它 `0600`，让它远离任何仓库，如果你只是不想把 secret 存到磁盘上，优先用 `$ENV_VAR`。

### endpoint URL 里的凭据不再能用

旧的 `https://my-namespace:sk_xxx@api.rivet.dev` 形式会被**拒绝**并给出
迁移提示：一个 URL 同时携带 endpoint、namespace 和 token 太容易出错，而现在 token 可以是
一条命令或一次环境变量查找，把它内嵌进 URL 就是同一件事的第二种、更弱的拼法。

给定：

```json
{
  "endpoint": "http://default:sk_xxx@engine.example.com:6420/",
  "pool": "laptop"
}
```

写成：

```json
{
  "endpoint": "http://engine.example.com:6420/",
  "namespace": "default",
  "token": "sk_xxx",
  "pool": "laptop"
}
```

token 也可以完全离开文件——`"token": "$RIVET_ADMIN_TOKEN"` 或
`"token": "!secret-tool lookup service rivet-engine"`。确切的目标形状会打印在错误里，
所以从消息里复制粘贴就够了。

### Per-host runner pool（混合舰队）

默认情况下每台机器的 runner 都加入引擎范围的 `default` pool，于是引擎可能把*你的* Node 的
actor 调度到*另一台*机器的 runner 上——handoff 随后就投递到了错误的主机上。在混合舰队上
（一个 grok bot、一台工单机、几台开发 Mac），给每台机器自己的 pool：

1. **选一个 pool 名**——用机器/主机名（`workstation`、`dev-mac`）。
   mesh 名称仍然是 xfer 节点名；pool 只决定 runner 住在*哪里*。
2. **把 `pool` 加到那台机器的配置里**：

   ```json
   {
     "endpoint": "https://engine.example.com",
     "namespace": "default",
     "token": "your-admin-token",
     "pool": "workstation"
   }
   ```

3. **一次性创建它的 runner-config**——在那台机器上运行 `/xfer mesh setup`。
   它会解析配置、在引擎上按需创建该 pool 的 runner-config（与第 1 步里 `default`
   pool 得到的是同一个 PUT），并确认引擎可达。幂等——随时可以安全重跑。手工等价操作
   也仍然可行：
   `curl -X PUT "http://<engine>:6420/runner-configs/<pool>?namespace=<ns>" -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"datacenters":{"default":{"normal":{}}}}'`

设了 `pool` 之后，本宿主的 runner 加入那个 pool，本 Node 的 actor 以
`runner_name_selector=<pool>` 创建，所以只有这台机器能接收它。

> **迁移一个已存在的节点**：加 `pool` **不会**移动一个已经存在的 actor——`getOrCreate`
> 保留原始放置，所以一次普通的 `down → up` 看起来可能成功，而 actor 仍然活在旧 pool 里。
> `up` 现在会检测到这一点并拒绝。要迁移：重启 pi 进程（早于 pool 支持的扩展构建无法执行
> 迁移），然后用新配置运行 `/xfer mesh down`，随后 `/xfer mesh up`。
发现、`desc` 和跨 pool 的 `mesh send` 保持不受 pool 限制：另一个 pool 里的 Node 仍然会被
列出并且可寻址——只有你自己 actor 的放置被钉住。在每台机器上重复，每台用自己的 pool。
Adapter Daemon 接受相同的值作为 `--pool`（与 `--engine` 一起）。理由与 RivetKit API 证据：
[ADR 0017](../adr/0017-mesh-runner-pools.zh.md)。

随时用 `/xfer doctor` 检查这个文件——**Mesh** 那一行会读取配置并查询引擎。

有一种 pool 类型**不是**这一步创建的：**serverless** pool（一个 Cloudflare Worker，没有
常驻 runner）。`ensureRunnerPool()` 写的是 `{ normal: {} }`，无法表达这种 pool，所以
`mesh setup` 的 pool 步骤不会创建它，任何 pi-xfer 命令都不得指向它——带外注册见
[Serverless Cloudflare 节点](cf-serverless-node.zh.md)。

## 第 3 步 —— 端到端验证

在每台机器上，于一个 pi 会话中：

1. `/xfer mesh up` —— 把这个实例以它的 xfer 名称作为 Node 加入。如果这个名字在引擎上已被占用，加入会被拒绝（用 `/xfer name` 换一个）。
2. `/xfer mesh status` —— 本宿主对“有任何东西能到我吗？”的自己的回答：在线与否、它所属的 pool、该 pool 里是否有活着的 runner，以及引擎是否应答。无论有没有 `up` 都能用。
3. `/xfer mesh list` —— 实时引擎查询，每个节点一行，带投递判定。那些字形就是全部重点：

   | | 含义 |
   |---|---|
   | `●` running | actor 在它的 pool 里可连接 |
   | `◐` sleeping | actor 在一个有 runner 的 pool 里睡着——投递时它会醒来 |
   | `○` no runner | **该 pool 没有 runner，所以这个节点什么都收不到**。这一行点名的是 pool，不是节点：任何被放在那里的 actor 同样搁浅 |
   | `⚠` mismatch | actor 记录仍读作 idle，而它的 pool 确实有 runner——引擎会在下一次发送时放置它 |
   | `·` pending / `✗` crashed | 等待分配 / 真实的引擎错误 |
   | `?` unknown | 引擎没有回答 `/envoys`，所以 runner 侧未知。永不渲染为“离线”，也永不渲染为“没有节点” |

4. 发一份跨机 handoff：`/xfer mesh <other-node-name> <request>`。文档以 inline 方式通过引擎的持久队列传输。如果目标节点在线，它立刻到达；如果它在**曾经在线之后**离线了，它会被缓冲并在它重新加入时投递。一个*从未*在线过的目标不会被缓冲——发送会在约 30 秒后报错。

   每次发送都先跑一次 **pre-send 检查**（一次引擎往返：`/actors` + `/envoys`，6 秒）：pool 里没有 runner 的目标会在约一秒内被拒绝并点名该 pool，而不是付出 30 秒超时的代价。这个检查是**fail-closed** 的——如果引擎在 6 秒内无法应答，就什么都不发，因为一次未经核实的发送可能给你最坏的结果（对一条仍会到达的消息报告失败）。`⚠` mismatch 是警告，不是拒绝，发送照常进行。`xfer-adapterd mesh send --no-preflight` 为需要通过不可达控制平面发送的宿主跳过这个检查。

本地侧步骤（`mesh.config.json` 解析、`mesh up` 在名字冲突时的拒绝、doctor 的 Mesh 行）是针对本仓库的代码验证的；完整的双机投递回路在撰写本指南时没有重跑，取决于你的控制平面部署。

## 第 4 步 —— 描述一个节点处理什么

`/xfer desc <text>` 为**这个**节点写一条简短的、自我声明的能力说明——那种你希望被发过来的请求（“处理 Postgres 迁移评审”、“支付服务的 on-call”）。不带参数的 `/xfer desc` 会清除它。

这条说明活在引擎上该节点自己的 actor state 里，所以它能在 `mesh down` / `mesh up` 之后存活，并在该节点离线时仍可读。它是未经核实的自我声明：一个声明，不是一份契约。pi-xfer 里没有任何东西据此路由或调度——列表仍然只有名字，想要能力图的消费方自己循环调用逐节点的 describe RPC 并缓存结果。唯一的便利是 web picker 的 `targets` 查询，它把每个目标的描述附在它的条目上（当那个节点的 actor 不可达时省略）。

## 本地开发 vs 生产

两条不能模糊的界线。同一批命令同时服务两者，所以区别完全在于**它们读哪份配置**——那个文件就是开关。

| | 本地开发 / 验证 | 生产 |
|---|---|---|
| **配置** | 一个指向 loopback 引擎（`http://127.0.0.1:6420`）或 stub 的一次性文件 | `~/.pi/xfer/mesh.config.json` 指向你的真实引擎 |
| **谁能到达网络** | 没有人——仅 loopback | 你的机器，刻意的 |
| **如何强制** | `mesh-guard.ts` 在测试运行中拒绝任何非 loopback 的 endpoint | 无守护：真实进程与配置所说的一切通信 |

### 守护（guard）

`mesh-guard.ts` 的存在，是为了让“测试永不接触部署”成为代码的一个属性，而不是一条人们要记住的规则。它**在设置了 `NODE_TEST_CONTEXT` 时自行武装**——那正是 `node --test` 放进每个 worker、以及测试启动的任何进程里的东西。没有别的东西会武装它：已安装的扩展、`/xfer mesh up`、admin 守护进程和 Adapter Daemon 都运行在未武装状态，完全看不到任何变化。

武装后，它：

- 从两个出站平面**拒绝每一个非 loopback 的 endpoint**——REST 调用（`engineApi`，走 `fetch`）和 socket 传输（来自 `rivetkit/client` 的 `createClient`，包括 broker 的描述查询）。拒绝发生在请求*之前*，所以没有任何东西离开这台机器。
- **放行 loopback**：`localhost`、`127.0.0.1`、`::1`、`0.0.0.0`、`host.docker.internal`。无法解析的 endpoint 会被拒绝，而不是被猜测。
- **停止继承你的真实配置**：在测试运行中，默认路径不是 `~/.pi/xfer/mesh.config.json`，而是一个不存在的临时路径，所以一个忘记注入任何东西的测试会大声失败，而不是悄悄读取生产。
- **统计它的决定**（`unguarded` / `loopback` / `allowed` / `blocked`），好让一套测试可以断言它授予了零次远程放行。

两个环境变量就是全部接口：

| 变量 | 效果 |
|---|---|
| `XFER_ALLOW_REMOTE=1` | 武装状态下**唯一**的通过方式。用于那个刻意测试守护的测试；`mesh-guard.test.ts` 在仓库范围内断言没有测试启用它。 |
| `XFER_MESH_CONFIG=/path/to/config.json` | 把一次测试运行指向特定的配置，而不是那个不存在的默认路径。 |

有一种情况守护**不**覆盖，这是刻意的：交互式会话（一个 tmux pane、你自己的 pi）是普通进程，所以那里的 `/xfer mesh list` 真的会与你配置所说的任何东西通信。把它当作生产访问：**包括只读**。见 `verify` skill 的*永不针对真实部署验证*一节。

### 搭起一个 loopback 引擎

为了自己验证 mesh 界面——`/xfer mesh list`、`/xfer mesh status`、admin 的 mesh 面板——在本地跑控制平面，而不是借用一个部署。采用[部署自托管控制平面](https://rivet.dev/docs/deploy/self-host/control-plane/)里的单容器路径——与上面*路线 B* 相同的形态，跑在 `127.0.0.1` 而不是 VPS 上，把它默认端口暴露在这台机器上。

本指南不固定镜像名或参数：它们属于那一页，在这里抄一份只会腐烂。pi-xfer 需要的只是一个可达的 endpoint。

然后是一份一次性配置——绝不是你的真实配置：

```json
{ "endpoint": "http://127.0.0.1:6420", "namespace": "default" }
```

用 `XFER_MESH_CONFIG=/tmp/mesh.local.json npm test` 使用它，或者在备份 `~/.pi/xfer/mesh.config.json` 之后把一个工作区会话指向它（`pi -ne -e ./`）——之后把它放回去。当前引擎默认开启认证，所以把你启动容器时用的 admin token 放进 `token`。无论哪种方式，你在 loopback 上做的任何事都到不了别人那里。

如果连这都超出了你在检查的东西，就不要运行那条命令：判定推导逻辑由 `npm test` 在隔离环境下覆盖，而那才是对代码重要的覆盖。

## 疑难排查

先运行 `/xfer doctor`——它的 **Mesh** 行能区分配置问题和引擎问题：

| 症状 | 可能原因 | 该怎么办 |
|---|---|---|
| Doctor：`not configured (opt-in) — create ~/.pi/xfer/mesh.config.json` | 还没有配置文件 | 创建它（第 2 步）。这是正常状态——mesh 是可选的。 |
| Doctor：`config unusable` | JSON 非法，或 `endpoint` 缺失/为空 | 修好文件；错误消息会点名那个字段。 |
| Doctor：`config unusable: mesh config "token": mesh token command "!…" produced no token` | `!command` 失败了——非零退出，或 stdout 上什么都没有。消息携带它运行时的 cwd 和 shell；如果它提到找不到文件，命令用的是**相对**路径 | 用绝对路径或 `$HOME`（不是字面量的值），然后在同一个 cwd 里手工运行那条命令看它打印什么 |
| Doctor：`engine unreachable at <endpoint>` | 引擎挂了、URL 错了，或防火墙 | 从同一台机器 `curl <endpoint>/ui`；检查引擎容器和任何反向代理（它必须容忍长连接 WebSocket）。 |
| `mesh up` 因认证错误失败 | `token`/`namespace` 错误或缺失 | 重新复制那些值——在路线 A 上，控制台的那一个字符串必须拆成 `endpoint`、`namespace` 和 `token`，因为 URL 里的凭据会被拒绝。如果 `token` 是 `$VAR`，检查它在启动 pi 的环境里已导出。 |
| `mesh up`：节点名在引擎上已存在 | 一个用这个 xfer 名称的节点之前加入过（可能来自另一台机器） | `/xfer name <other>` 后重试，或者从引擎控制台（`<endpoint>/ui`）销毁那个陈旧的 actor。 |
| 节点已 up，但 peer 在 `mesh list` 里看不到它 | 两台机器指向不同的引擎或 namespace | 比较两台机器配置里的 `endpoint` 和 `namespace`——发现是引擎侧的，所以两者必须解析到同一个引擎 + namespace。 |
| handoff 到了错误的机器 | 每个宿主共享 `default` pool，所以引擎把你 Node 的 actor 调度到了另一台机器的 runner 上 | 给每台机器自己的 `pool` 并创建该 pool 的 runner-config——per-host pools、[ADR 0017](../adr/0017-mesh-runner-pools.zh.md)。 |
| 发给离线节点的发送在约 30 秒后报错 | 目标从未上线过 | 持久队列缓冲只在目标 actor 被创建之后才开始（即它至少加入过一次）。先把目标上线。 |
| `mesh up` 首次运行时下载文件 | 预期行为 | 原生 runtime 在首次 `mesh up` 时从 npm 取回并缓存在本地（见 ADR 0013）。需要网络访问。 |
| 想事后看 mesh 做了什么 | mesh 安静运行，所以 pi 屏幕什么都不显示——但也没有任何东西被丢弃 | 读 `<xfer-dir>/mesh.log`（`tail -n 50 ~/.pi/xfer/mesh.log`）：每次 `mesh up/down/send`、拒绝、失败、入站 handoff 和 rivetkit JS 日志行，只追加。[docs/dev/mesh-log.zh.md](../dev/mesh-log.zh.md) 解释它持有什么、以及它不能做什么。 |
| 经由隧道/边缘代理的连接每约 100 秒断开（或在 Cloudflare 部署时） | 边缘切断了空闲的 gateway WebSocket。runner 注册不受影响——它会持续 ping。 | 预期会重连和更高延迟；pi-xfer 侧无需配置。如果这种翻动造成困扰，用私有网络 / 你自己的 TLS 代理——传输安全 |
| `mesh list` 对某个节点显示 `○ no runner`，发给它的发送立刻被拒绝 | 引擎在那个节点的 pool 里没有活着的 runner，所以那里没有任何东西能接起 actor | 在那台机器上为该 pool 启动一个 runner——在那里开一个 pi 会话（它的 runtime 加入其 `mesh.config.json` 里指定的 pool）——然后重试。`/xfer mesh status` 对本宿主回答同一个问题 |
| 每一行都读作 `?` | 引擎回答了 `/actors` 但没有回答 `/envoys` | 检查 `/xfer mesh setup`；引擎的 runner 侧不可达，尽管 actor 列表不是。此期间发送被拒绝（fail-closed） |
| `mesh up` 能用，但每份 handoff 都能被路径上的某物读到 | 你在 `http://` 上，或者路径里有一个终结 TLS 的边缘 | 自己终结 TLS 或使用私有网络；pi-xfer 没有载荷加密——传输安全 |
| 想要 RivetKit runtime 的**原生**日志（Rust 侧，例如 SQLite 警告） | 它们永远到不了 JS——它们直接写到进程的 stdout，所以无法归档进 `mesh.log` | 用 `RIVET_LOG_LEVEL=warn`（或 `debug`）启动 pi：你自己设的级别会被尊重，欢迎横幅保持关闭。预期这些行会涂抹 pi 屏幕——那噪音正是默认值为 `silent` 的原因。 |
