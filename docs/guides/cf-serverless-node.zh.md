> 中文版 · 英文原文：[cf-serverless-node.md](cf-serverless-node.md)

# 一个 serverless Cloudflare 节点 —— 空闲时不花一分钱的 mesh 节点

> **实验性，不是受支持的特性。** 无 SLA、CI 里没有网络测试、不承诺跨 rivetkit 大版本可用。
> 它是一个**示例**（`examples/cf-serverless-node/`），不属于 pi-xfer 扩展——它的 npm 依赖属于那个
> 目录，而不属于一个依赖都不带的扩展。如果它在未来的 rivetkit 上坏掉，pi-xfer 不受影响。

Mesh 一直是一组常开的机器。这是第一种不是这样的：Cloudflare 上的一个 **serverless 节点**，
可以作为普通的 mesh 节点被寻址。有活时它醒来、作答，其余时间它并不存在——因此维持它的
成本为零。

Worker 和它的 `xfer-instance` actor 是这个节点加入 mesh 的方式。它们是传输手段，不是重点。

在你投入之前有两点值得知道：

- **好的目的地，差的消息源。** serverless 节点没有读侧，睡着时也没有存在感。它是把缓冲的
  工作送过去的好地方；它是期待按需得到回答的坏地方。
- **引擎必须可公开访问**，因为它要回调 Worker。那是部署形态的改变，不是一个开关——见
  [mesh 配置](mesh-setup.zh.md) 与
  [ADR 0013](../adr/0013-xfer-mesh-rivetkit-transport.zh.md) 的 serverless 例外。

## 它是什么

```
laptop (pi, mesh up)                 Cloudflare
      │                                 ┌────────────────────────────────────┐
      │  handoff queue message          │ Worker                             │
      ├────────────────────────────────▶│  registry.handler()   [wasm]        │
      │                                 │   └─ xfer-instance actor           │
      │                                 │        state ── engine-side SQLite │
      │                                 │        queue ── "handoff"          │
      │                                 │        run ── hands off, no await  │
      │                                 │              │                     │
      │                                 │              ▼                     │
      │                                 │        Durable Object              │
      │                                 │          agent memory (DO storage) │
      │                                 │          answerHandoff()           │
      │                                 │              │                     │
      │  handoff queue message          │              ▼  rivetkit client     │
      ◀─────────────────────────────────┤        enqueue into sender's queue │
      │                                 └────────────────────────────────────┘
```

Worker 本身是一个 Hono app（`src/app.ts`），把 wasm registry 挂在 `all("*")` 之后：
它自己拥有三条路由，并交出一个前缀。两个 Cloudflare 入口——Worker 与 Durable Object
类——跑的是同一个 app，这就是为什么作答逻辑只有一份实现。

Mesh 上的一切只看到一个 `xfer-instance` actor，所以 `/xfer mesh list`、
`/xfer mesh <name>`、`desc` 和 Adapter Daemon 都能原样使用它。没有新命令。

从 `examples/cf-serverless-node/README.md` 开始；本页是地图，那个目录是手册。

## agent 是什么（以及不是什么）

Durable Object 只持有一个函数：`answerHandoff()`。没有 `DEEPSEEK_API_KEY` 时它把
handoff 原样回显；有 key 时它做一次模型调用。这就是全部的 agent——没有 Pi Durable
harness、没有会话、没有工具、没有轮次循环。

所以这个示例证明的是**传输**：一个只在有活时才存在的节点，像任何其他节点一样被寻址，
把回答送回发送者的队列。agent 那一半是一个接缝。替换 `src/agent-do.ts` 里的
`answerHandoff()`，或者在 `POST /agent/answer` 后面放一个真正的 agent runtime，
mesh 侧的任何东西——actor、pool、回信路径——都不必动。

## 两层持久化，永不混淆

这是最容易搞错的地方，所以说一次：

| 层 | 位于 | 持有 | 存活于 |
|---|---|---|---|
| **rivetkit actor state** | 引擎中，远程 SQLite（在 `runtime: "wasm"` 下强制如此） | 节点 `description`、已投递 id 的去重窗口 | 节点重启、重连、actor 休眠 |
| **Durable Object storage** | Cloudflare | *agent* 需要的东西——它收到了哪些 handoff、它回答了什么 | 请求边界、冷启动 |

mesh 上没有任何东西读 DO storage，actor state 也永远不能代替它。actor 属于传输；
DO 属于 agent。

## serverless actor 必须遵守的纪律

1. **收到即回信。** run 循环把消息交给 DO 就继续往下走；它从不 await agent。serverless
   actor 可能在 run 循环让出的那一刻被拆掉，所以任何必须存活的东西都要经过 DO，而不是
   某个函数的栈。
2. **调用之间无状态。** 没有长驻进程来保存一个变量。之后需要的东西要在获知时写入 DO
   storage，而不是之后再重建。
3. **Ack 意味着已接受，不是已回答。** 队列消息一旦被记录就被 ack。如果 DO 随后死掉，
   mesh **不会**重投——这就是为什么“已接受但从未回答”在 `VERIFICATION.md` 第 5 步里是
   一种独立的失败模式。如果真的来了一次重投，它会从 DO 自己的记录作答，用第一次产生的
   那个 id，并且不会第二次回信。

## 寻址与 pool

一个节点是 `actor type + key`：`xfer-instance` 加上节点名（`NODE_NAME`，默认 `cf-node`）。
没有别的。pool 决定 actor 被放置在*哪里*。

- 示例默认加入 pool **`cloudflare`**——`wrangler.toml` 里的 `POOL_NAME`，通过
  `nodeConfig()` 读取。可以随意改名，但引擎侧的 runner-config 必须携带相同的名字：
  这是两侧必须一致的那一个字符串。
- **任何 pi-xfer 命令都不得指向 serverless pool。** `ensureRunnerPool()` 硬编码了
  `{ normal: {} }`，无法表达这种 pool，所以 `/xfer mesh setup`（以及它写出的无 runner
  pool）在这里不适用：注册是带外进行的，即流程的第 1 步。
- 与 per-host pool（[mesh 配置](mesh-setup.zh.md)）不同，这个 pool 自身不持有 runner：
  引擎按需启动 Worker。

## 部署它

完整流程见
[`examples/cf-serverless-node/VERIFICATION.zh.md`](../../examples/cf-serverless-node/VERIFICATION.zh.md)——七个
步骤，也是本仓库中唯一一处验证会接触真实部署的地方（Durable Object 没有本地替身）。**每次都是人的
决定；其中没有任何东西会从 CI、测试或这里的脚本运行。**

前置条件，精简版——每一条出错时都会表现为看似无关的问题：

| 需要 | 否则会怎样咬你 |
|---|---|
| 引擎固定为 **`rivetdev/engine:2.3.26`** | `:latest` 与 rivetkit `2.3.26` 在 serverless 启动载荷上不一致（空 body，`payload too short`） |
| 引擎的 `topology.datacenters[].public_url` = 它的公开主机名 | 在 `/start` 时引擎会拿它对外宣称的地址与自己的 endpoint 对照；未设置意味着 `endpoint_mismatch`。嵌套的 `topology` 无法来自环境变量——挂载一个配置文件 |
| 一个**引擎能访问到的** Worker URL（自定义域名） | `*.workers.dev` 从中国大陆网络的引擎上超时，而调用 Worker 的是引擎 |
| 带 **`request_lifespan`** 的 runner-config | 没有它引擎会应用自己的默认值，较短的生命周期会被拒绝 |
| **`drain_grace_period` 显式且严格更小** | 引擎默认宽限期是 1800 秒；省略它，较低的 lifespan 会被当作*非法配置*拒绝 |
| 第一轮不要配置 DeepSeek key | 必须在任何凭据存在之前先证明回显路径 |

有两个坑值得在这里重复，因为它们耗费了真实的时间：

- **`wrangler.toml` 是 TOML。** 每个顶层键都必须位于第一个 `[table]` 头*之上*——写在
  `[vars]` 之后的 `routes` 块会变成一个名为 `routes` 的普通变量，自定义域名就悄悄永远
  不存在了。`npm run check` 会打印解析后的变量；去读它。
- **pool 的时序是一个常量，单位是秒**（`src/pool-config.ts` 里的
  `SERVERLESS_POOL_TIMING`），由 `configurePool` 与带外 curl 共享——两个写入者，一套
  数字体系，任何地方都没有 `_MS`。`runnerConfigBody()` 用同一个常量打印出 bootstrap JSON。

## 疑难排查

以下是最常见六行，摘自
[完整表格](../../examples/cf-serverless-node/VERIFICATION.zh.md)；每一条都是真实踩过的。

| 现象 | 原因 | 修复 |
|---|---|---|
| 启动 runner 时引擎返回 `endpoint_mismatch` | `topology.public_url` 缺失，或不是客户端使用的主机名 | 挂载前置条件里的配置文件并重启引擎 |
| `serverless start payload too short`（空 body） | pool 的 `url` 指向了**引擎**，于是引擎向自己 POST `/start` | `url` 必须是 `<WORKER_PUBLIC_URL>/api/rivet`——runner-config *和* `configurePool` 里都是 |
| `failed to resolve host`，或引擎根本到不了 Worker | `*.workers.dev`（某些网络不可达），或自定义域名从未创建 | 用自定义域名；在控制台里验证路由，而不是看部署输出 |
| 400 `drain_grace_period must be less than request_lifespan` | pool 的 body 漏了宽限期（引擎默认 1800 秒）或设成了 ≥ lifespan | 在 `SERVERLESS_POOL_TIMING` 里保持 `drainGracePeriod < requestLifespan`，然后重新部署 |
| Actor 卡在一个重启也清不掉的 `error` 上 | actor 记录的 `error` 是粘性的——runner 出现时它不会被清除 | 销毁重建：`DELETE /actors/<id>?namespace=<ns>`，再 `getOrCreate`（第 4 步的 client 会做这件事） |
| Pool 卡死：节点被列出，发送挂起或报 `no runner in pool "cloudflare"` | 引擎对 pool 的视图是陈旧的，或没有 runner | 重新 `PUT` runner-config（第 1 步）以重新注册它，然后从一个裸 client 发送把它唤醒 |

## 边界

- **这里的一切都与你的 agent 行为无关。** 示例用一个固定的回显作答（或者配置了 key 就
  调一次 DeepSeek），好让传输在任何凭据存在之前就能被证明。agent 实际做什么——读仓库、
  更新工单、写摘要——属于你自己的 agent 仓库，由 `answerHandoff()` 驱动；见
  agent 是什么。
- **示例可以带 npm 依赖；扩展不可以。** `examples/cf-serverless-node/` 有自己的
  `package.json` 和 `node_modules`。那里没有任何东西为 pi-xfer 树立先例，rivetkit 仍然
  不在扩展的依赖列表里。
- **文档化的范围止于一次往返：** 发进去、作答、回到发送方，手工验证。Cron 唤醒、批处理、
  跨节点摘要和定时任务都是平台特定的，不在覆盖范围内——serverless actor 按设计就是差的
  消息源。
- **Worker 从不创建自己的 actor。** serverless pool 在有东西入队之前没有 runner 来承载
  一个，所以第一次投递才是让这一行出现的原因。把 `/xfer mesh list` 里的一行当作存在感，
  永远不要当作该节点能接收的证据。

如果这些限制符合你想使用它的方式，流程很短，回报是一个只在有人需要时才存在的节点。
