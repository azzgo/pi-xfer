> 中文版 · 英文原文：[README.md](README.md)

# 一个无服务器 Cloudflare 节点，接入 mesh

> **实验性，不是受支持的特性。** 无 SLA，CI 里没有网络测试，不承诺跨 rivetkit 大版本。
> 这个 `package.json` 及其 `node_modules/` 属于示例——**pi-xfer 扩展本身不附带任何运行时
> 依赖**，这里没有任何东西为添加依赖开了先例。如果该示例在未来的 rivetkit 上坏掉，扩展不受
> 影响。

一个**无服务器 mesh 节点**：它跑在 Cloudflare 上，可以作为一个普通的 mesh 节点被访问，
有活时它应答，空闲时它不花钱。Worker 及其 `xfer-instance` actor 是它接入 mesh 的方式——
是传输，不是重点。

**它背后的 agent 是一个桩。** 在 Durable Object 内部，`answerHandoff()` 把 handoff 原样回
显——或者，如果设置了 `DEEPSEEK_API_KEY`，就做一次模型调用。这里不跑任何 agent 框架：这个
示例证明的是*传输*（一个只存在于有活期间的节点），agent 那一半是你在自己仓库里替换的接缝。

读这个文件来运行它。在把它指向真实 engine 之前，先读 `VERIFICATION.md`。

## 从这里开始：真正要紧的四个文件

```
src/worker.ts          the two Cloudflare entry points — the Worker and the Durable Object class
src/app.ts             every route, in Hono; this is the whole HTTP surface
src/agent-do.ts        the agent: answerHandoff(), and the memory that makes redelivery idempotent
src/mesh-registry.ts   the mesh engine (wasm registry) behind `app.all("*")`
```

其余都是这四个文件依赖的细节：

| 文件 | 作用 |
|---|---|
| `src/mesh-actor.ts` | `xfer-instance` actor —— 与扩展运行的是同一套 state、队列和 action |
| `src/node-config.ts` | 这个节点被配置成什么：每个环境变量名，以及 base path |
| `src/pool-config.ts` | pool 记录：以秒计的时序、唯一一处拼写，以及 bootstrap curl 用的 engine body |
| `src/reply-client.ts` | 回信入队的位置：发送方自己的队列，在 engine 上 |
| `app.test.ts` | 每条路由，用 Hono 自己的 `app.fetch` 驱动——无 workerd、无 engine |
| `agent-do.test.ts` | 应答：回显、模型兜底、重投递 |
| `node-config.test.ts` | 配置默认值，以及两个写入方共同拼出的 pool 记录 |

## 形状

```
laptop (pi, mesh up)          Cloudflare
      │                          ┌───────────────────────────────────────┐
      │  handoff queue msg       │ Worker        src/worker.ts            │
      ├─────────────────────────▶│  Hono app     src/app.ts               │
      │                          │    GET  /            what is this node │
      │                          │    GET  /health                        │
      │                          │    POST /agent/answer                  │
      │                          │    ALL  * ──▶ mesh registry [wasm]     │
      │                          │                  └─ xfer-instance     │
      │                          │                       state  ── engine SQLite
      │                          │                       queue  ── "handoff"
      │                          │                       run    ── hands off
      │                          │                              │         │
      │                          │                              ▼         │
      │                          │                    Durable Object      │
      │                          │                      agent memory ── DO storage
      │                          │                      answerHandoff()   │
      │                          │                              │         │
      │  handoff queue msg       │                              ▼  engine │
      ◀─────────────────────────┤                enqueue into sender's queue
      │                          └───────────────────────────────────────┘
```

一个应用，两个入口。Worker 把请求经 Hono 路由；Durable Object 做同样的事，只是把它自己的
storage 合并进 env。这就是为什么应答逻辑、回显和回信路径都只有一份实现：`POST /agent/answer` 在两处是同一段代码。

**Hono 不是装饰。** mesh registry 就是一个 `handler(request)`——一个 wasm 对象，它只拥有
一个路径前缀，别的什么都不管。Hono 让"registry 拥有 `/api/rivet/*`，我在它旁边拥有三条
路由"成为两行声明，而不是手写 URL 匹配。任何接受 `fetch` handler 的无服务器平台都是这个
套路；这个示例是它的最小版本。

## 这里值得学的四件事

1. **收到即回信。** actor 的 run 循环把消息交给 Durable Object 然后继续；它从不等待 agent。
   一个无服务器 actor 可能在 run 循环让出控制权的瞬间被拆掉，因此任何必须存活的东西都要
   经过 DO，而不是待在某个函数的栈上。
2. **两层持久化，从不混淆。** rivetkit 的 actor state 活在 engine 里，持有节点 `description`
   和已投递 id 窗口。Durable Object storage 活在 Cloudflare 里，持有*agent*需要的东西——
   它收到过哪些 handoff、它回答了什么。mesh 上没有任何东西读 DO storage，actor state 也
   从不代替它。
3. **Ack 意味着已接受，不是已回答。** 队列消息一被记录就 ack。如果 DO 随后死掉，mesh 不会
   重投——这就是为什么 `VERIFICATION.md` 把"已接受但从未回答"当作一种独立的失败模式。
4. **按 id 幂等，而非靠运气。** 重投的 handoff 会用第一次产生的那个 id 应答，并且*不会再发
   第二条回信*（`Answer.first`）。那是 `app.ts` 里的一行，而且有测试。

`src/agent-do.ts` 里的 `answerHandoff()` 就是那个要替换的函数。没有 `DEEPSEEK_API_KEY`
时它做回显——在任何凭据存在之前，这条回显就是 mesh 路径被证明的方式。

## 本地运行，无需任何账号

```bash
cd examples/cf-serverless-node
npm install
npm test                     # 18 tests, hermetic: no workerd, no engine, no network
npx wrangler dev             # local workerd
curl localhost:8787/         # {"node":"cf-node","mesh":"/api/rivet","routes":[...]}
curl localhost:8787/health   # {"ok":true,"node":"cf-node","engine":false}
```

`engine: false` 是诚实的：没有设置 `MESH_ENDPOINT`，因此没有任何东西与 engine 通信。在能够
触及 engine 之前，mesh 路径（`/api/rivet/*`）返回 503 `Serverless pool is not configured`
——那是 registry 自己的拒绝，不是这个 Worker 的 bug。

## 在 mesh 上运行它

在真实部署上验证过一次——`VERIFICATION.md` 里有记录下来的结果和由此得出的九处修正。下面的
顺序是能走通的顺序；每个标 🔴 的步骤都会触及真实基础设施，每次都需要人来决定。

1. **钉住 engine。** `rivetdev/engine:2.3.26`，与本示例的 rivetkit 匹配，并把
   `topology.datacenters[].public_url` 设为 engine 的公开主机名（一个配置文件；它不能来自
   环境变量）。不钉版本，无服务器启动 payload 会不一致；不设置，engine 会返回
   `endpoint_mismatch`。
2. 🔴 **在首次部署之前，带外注册 pool。** pool 默认名为 `cloudflare`
   （`POOL_NAME`）；body 指向 **Worker**，绝不是 engine，并以**秒**携带两个时序字段：
   `{"datacenters":{"default":{"serverless":{"url":"https://<worker-domain>/api/rivet","headers":{},"request_lifespan":30000,"drain_grace_period":600}}}}`。
   这些数字在 `SERVERLESS_POOL_TIMING`（`src/pool-config.ts`）里，registry 的
   `configurePool` 写的也是它——`runnerConfigBody()` 给你那份确切的 JSON。
3. **给 Worker 一个 engine 能访问的域名。** 在中国大陆网络的 engine 上，`*.workers.dev`
   不可达，而调用 Worker 的正是 engine。取消 `wrangler.toml` 里 `routes` 的注释——一个
   顶层键，位于 `[vars]` **之上**——并把 `WORKER_PUBLIC_URL` 设为同一个主机。不设置时，
   所有 URL 都是请求自身的 origin，能用，但冷 engine 无法预测。
4. **配置并部署。** `npx wrangler secret put MESH_ENDPOINT`（engine），让 `[vars]` 里的
   `RIVET_ENDPOINT`/`RIVET_NAMESPACE` 与之一致，然后 `npm run check &&
   npx wrangler deploy`，再 `curl https://<worker-domain>/health` →
   `{"ok":true,...,"engine":true}`。
5. 🔴 **从裸 rivetkit 客户端做第一次发送。** engine 只在有东西可投递时才启动无服务器
   runner，因此冷 pool 总是显示 `○ no runner`，而 `mesh send` 的预检恰好会拒绝这种状态。
   `VERIFICATION.md` 第 4 步有那个 `node -e` 脚本；`mesh send` 是热 pool 的路径。

节点的 actor 由第一次投递创建，绝不是由 Worker 自己创建——在有什么东西入队之前，无服务器
pool 没有 runner 来托管它。第 5 步之前 `/xfer mesh list` 为空是预期结果，不是症状。

## 打包，普通 `wrangler deploy` 已经处理好了

那些不那么显然的部分，以防你自己打包：

- **注入 wasm 绑定。** rivetkit 通过一个刻意不透明的 specifier 解析它，好让打包器永远抓不到
  它；`setup({ wasm: { bindings, initInput } })` 显式传入它，而 `initInput`（导入的
  `.wasm`，在 wrangler 下是一个 `WebAssembly.Module`）正是 Worker 需要的东西，用来替代
  默认的 `fetch(new URL(...))`。
- **`compatibility_flags: ["nodejs_compat"]`。** rivetkit 的 logger（pino）即使在 wasm 下
  也在模块作用域导入 Node 内建模块。
- **`async_hooks` 和 `module` 保持 external**，如果你手工打包；wrangler 会替你处理。

## 为什么这东西值得存在

不是因为它可达——可达的东西多得是。而是因为它是第一个不需要为存在付费的 mesh 节点：它在
没有活时缺席，然后出现，然后再缺席。调度以及 agent 实际做什么，属于你自己的 agent 仓库，
这也是这个示例止步于往返的原因。
