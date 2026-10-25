> 中文版 · 英文原文：[VERIFICATION.md](VERIFICATION.md)

# 手工验证这个闭环

**这是本仓库中唯一一处验证会触及真实部署的地方**，它是一个刻意记录在案的例外
（`AGENTS.md` —— "Never test against a live deployment"）。Durable Object 没有本地替代品，
因此这个往返无法由 `npm test` 或脚本证明。它由人证明一次，靠读输出。

在运行任何东西之前先读完整节。**下面没有任何东西会从 CI、从测试、或从本仓库的脚本里运行。**
标 🔴 的步骤会触及真实基础设施。

`npm test` *确实*覆盖的：Durable Object 的应答逻辑（`agent-do.test.ts`）——回显、重投递、
模型兜底——对着内存存储。那正是可能静默地发两条应答或一条都不发的代码。这里其余的一切都是
mesh 路径本身。

> **记录结果（2026-10-18）。** 这个闭环成功闭合过一次，对着 rivetkit `2.3.26`、位于
> Cloudflare Tunnel 之后、镜像为 `rivetdev/engine:2.3.26` 的 engine，Worker 跑在自定义域名
> 上：`mesh.log` 里有 `mesh inbound id=mvprobe03-cfround-echo from=cf-node`，本地 pi 会话
> 渲染出了那条回显。下面的每一处修正都出自那次运行——这里的命令是真正奏效的那些，而不是
> 一开始看起来正确的那些。

---

## 0. 前置条件

| 需要 | 为什么 |
|---|---|
| 一个能通过**公网 HTTPS** 访问的 mesh engine | engine 要回调 Worker；`localhost` 的 engine 做不到 |
| **engine 钉在 `rivetdev/engine:2.3.26`** | `:latest` 与 rivetkit `2.3.26` 在无服务器启动 payload 上不一致（空 body，`payload too short`）；钉住版本后消失。见排错表 |
| engine 的 `topology.public_url` 设为公开主机名 | 在 `/start` 时 engine 会拿它宣称的身份对照自己的 endpoint，否则返回 `endpoint_mismatch`。配置文件见下 |
| 一个**从 engine 侧**可访问的 Worker URL（自定义域名） | 在中国大陆网络的 engine 上 `*.workers.dev` 超时。见 §2 |
| 一个已在线的本地 pi 节点（`/xfer mesh up`） | 它就是那个发送方，你要读它的回信 |
| 一个 Cloudflare 账号 + `wrangler login` | 部署 Worker |
| 第一轮**不要 DeepSeek key** | 在任何凭据存在之前，必须先证明回显路径 |

engine 公开可达，是 ADR 0013 的无服务器例外所接受的部署形态变化。传输安全态势见
`docs/guides/mesh-setup.md`。

**Engine topology。** 当无服务器 runner 启动时，engine 会宣称自己的身份。嵌套的 `topology`
无法通过环境变量设置（engine 作者已确认），所以要挂一个配置文件——对 compose 文件而言，
`-v /etc/rivet/config.json:/etc/rivet/config.json:ro`：

```json
{
  "topology": {
    "datacenter_label": 1,
    "datacenters": [
      {
        "name": "default",
        "datacenter_label": 1,
        "is_leader": true,
        "peer_url": "http://127.0.0.1:6421",
        "public_url": "https://<engine-host>"
      }
    ]
  }
}
```

`public_url` 就是 runner 用来对照 engine 所宣称 endpoint 的那个值——它必须是客户端使用的
主机名，含 scheme，无尾斜杠。不设置它，是第一次发送时 `endpoint_mismatch` 的常见原因。

## 1. 带外注册 pool 🔴

`ensureRunnerPool()` 硬编码 `{ normal: {} }`，因此它**不能**创建无服务器 pool——也不允许把
任何 `pi-xfer` 命令指向这样的 pool。用 engine 自己的 API 注册一次：

本示例默认加入 pool `cloudflare`——该值位于 `wrangler.toml` 的 `POOL_NAME`，Worker 从那里
读取它（`src/node-config.ts` 中的 `nodeConfig()`）。要用别的名字，就在 `wrangler.toml`
**和**下面两处一起改：这个 runner-config 名字是必须两端匹配的唯一字符串。

```bash
# Replace the engine host/token and the Worker's public URL; <pool> only if you renamed POOL_NAME.
# POOL_NAME defaults to: cloudflare
curl -sS -X PUT "https://<engine-host>/runner-configs/cloudflare?namespace=<ns>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"datacenters":{"default":{"serverless":{
        "url":"https://<worker-domain>/api/rivet",
        "headers":{},
        "request_lifespan":30000,
        "drain_grace_period":600}}}}'
```

关于这个 body 的四件事：

- **`url` 是 Worker 的公开 URL 加上 `/api/rivet`**——engine 向它 POST `/start` 的地址。
  它*不是* engine 的 endpoint。Worker 自己的 `configurePool` 携带同一个值，因此要让两者
  完全一致；一个指向 engine 的 Worker 会让 engine 调用自己，这次尝试会以空的
  `serverless start payload` 失败。
- **两个字段都以秒计**——这是 engine 的单位，也是 RivetKit 在
  `requestLifespan`/`drainGracePeriod` 里的单位。任何地方都没有毫秒：`30000` 意味着
  三万秒。两个数字都在同一处，`src/pool-config.ts` 里的 `SERVERLESS_POOL_TIMING`，Worker
  自己的注册也原样使用它们。
- **`drain_grace_period` 必须存在且严格小于 `request_lifespan`。** 省略时，engine 套用其
  默认值 1800 s，低于它的生命周期会被拒绝，报
  `drain_grace_period must be less than request_lifespan`——这是*非法配置*，不是启动慢。
  `600` 是本示例的取值；任何小于 `30000` 且 ≥ 0 的值都被接受。
- **先注册，再部署。** 带外配置是引导冷 pool 的东西；registry 自己的 `configurePool` upsert
  只在 engine 启动 runner 时才跑，而那需要 runner 已存在。两者写同一条记录，且 Worker 只在
  engine 持有的内容与它将要写的内容不同时才重写——热 pool 上每个 isolate 一次 GET。

然后确认 engine 持有它（这也是对部署的一次读——同样是 🔴）：

```bash
curl -sS "https://<engine-host>/runner-configs/cloudflare?namespace=<ns>" \
  -H "Authorization: Bearer <token>" | jq .
```

`pi-xfer` 本身从不需要知道 pool 名字；当 registry 启动时，actor 会被放进那个 pool。

## 2. 部署 Worker 🔴

部署之前，`npm run check` 先跑类型检查，然后跑 `wrangler deploy --dry-run`：它解析
`wrangler.toml`，解析 Durable Object 绑定和 vars，并在本地构建 bundle——什么都不上传。配置
里的笔误会在那里暴露，而不是在真实部署进行到一半时。

**读它打印出来的绑定。** `wrangler.toml` 是 **TOML**，因此每个顶层键都必须出现在第一个
`[table]` 头之前：写在 `[vars]` 之后的 `routes` 块会变成一个名为 `routes` 的普通变量，而
自定义域名永远不会被创建——完全没有任何警告。

```bash
cd examples/cf-serverless-node
npm install
npm run check                             # local config + build check, no upload
npx wrangler secret put MESH_ENDPOINT     # https://<engine-host>
npx wrangler secret put MESH_NAMESPACE    # if your engine uses one
npx wrangler secret put MESH_TOKEN        # if your engine requires one
npx wrangler deploy
```

`[vars]` 里的 `RIVET_ENDPOINT` / `RIVET_NAMESPACE` 是同一个 engine，发布在 RivetKit 自己的
环境变量通道上——wasm 运行时的某些部分读的是那个而不是配置对象，因此两者必须一致。pool 的
时序刻意**不是** var：它位于 `src/pool-config.ts` 的 `SERVERLESS_POOL_TIMING`，这样
`configurePool` 与这一步的 curl 就不会各走各路。改它时要和步骤 1 一起改——
`runnerConfigBody()` 从同一个常量构建出步骤 1 的确切 JSON。

**要自定义域名，不是 `workers.dev`。** 中国大陆网络上的 engine 无法连接 `*.workers.dev`
（连接超时），而必须抵达这个 Worker 的正是 engine。把 Worker 放到你 Cloudflare 账号里的一个
域名上，并设置：

- `wrangler.toml` 里的 `routes = [{ pattern = "<your-domain>", custom_domain = true }]`
  （取消注释）
- `WORKER_PUBLIC_URL = "https://<your-domain>"`（取消注释；无尾斜杠——不设置时，Worker
  使用请求自身的 origin，冷 engine 无法预测它）
- 步骤 1 的 runner-config `url` —— `https://<your-domain>/api/rivet`

三者是同一个主机。如果部署之后你期待的域名不见了，wrangler 4.0.0 并不总会报告：直接检查
（dashboard → Workers → 你的 Worker → Settings → Domains & Routes，或在 Cloudflare API 上
`PUT /accounts/<id>/workers/domains`），看看上面那个 pattern 是否已存在但*未*启用。

把 `WORKER_PUBLIC_URL` 设为 Wrangler 打印出来的 URL，然后再部署一次，让
`serverless.publicEndpoint` 与现实一致。不一致会表现为 engine 永远到不了节点，看起来和
"节点不存在"一模一样。

健康检查（不涉及 mesh——注意它会打印 `engine`；`GET /` 会说出节点名与 mesh 前缀，是看清一次
部署实际配置了什么的最快方式）：

```bash
curl -sS https://<your-domain>/health
# {"ok":true,"node":"cf-node","engine":true}
```

## 3. 证明节点在 mesh 上 🔴

在 mesh 已启动的本地机器上：

```bash
/xfer mesh list
```

**通过**：出现一行 `cf-node`，且它的状态不是 `○ no runner`——无服务器 pool 持有这个 Worker。

**第一次投递之前没有行是预期结果**：除了投递，没有任何东西创建这个节点的 actor，因此这里
列表为空并不能说明部署的任何事。跑一次步骤 4 的客户端（`getOrCreate` 会作为副作用在 pool
`cloudflare` 里创建 actor），然后再看——出现的那行就是步骤 4 创建的。

**一行 `○ no runner`** 意味着步骤 1 的 pool 没有注册在 actor 被放入的地方——检查两端的 pool
名字。**`wrangler tail` 里全程没有 `/api/rivet` 请求**意味着 engine 从未抵达 Worker：回到 §2
的自定义域名检查。

## 4. 往里面发一份 handoff 🔴

engine 只在有东西可投递时才启动无服务器 runner。**因此在冷 pool 上，第一次发送必须来自一个
裸 rivetkit 客户端**——`xfer-adapterd mesh send` 路径会做一次 fail-closed 预检，拒绝那些
pool 里没有存活 runner 的目标（`○ no runner`，按设计，无覆盖）。下面的客户端会在 actor
不存在时创建它，并入队 handoff；actor 的到来正是让 engine 启动 runner 的东西。

```bash
cd examples/cf-serverless-node      # for rivetkit 2.3.26 on disk
cat > /tmp/cf-probe.md <<'EOF'
# Round-trip probe

Confirm you received this and reply with the handoff id.
EOF

MESH_ENDPOINT=https://<engine-host> MESH_NAMESPACE=<ns> MESH_TOKEN=<token> \
node --input-type=module -e '
const { createClient } = await import("rivetkit/client");
const fs = await import("node:fs");
const id = `probe-${Date.now()}`;
const client = createClient({
  endpoint: process.env.MESH_ENDPOINT,
  ...(process.env.MESH_NAMESPACE ? { namespace: process.env.MESH_NAMESPACE } : {}),
  ...(process.env.MESH_TOKEN ? { token: process.env.MESH_TOKEN } : {}),
});
await client.getOrCreate("xfer-instance", ["cf-node"], { poolName: "cloudflare" }).resolve();
await client.get("xfer-instance", ["cf-node"]).send("handoff", {
  id,
  from: "<your-local-node-name>",
  to: "cf-node",
  summary: "round-trip probe",
  document: fs.readFileSync("/tmp/cf-probe.md", "utf-8"),
});
console.log(id);
'
```

它打印出自己铸出的 handoff id。**记下来**——步骤 5 要确认它。

runner 热起来之后，常规路径就是 `xfer-adapterd mesh send`：

```bash
xfer-adapterd mesh send cf-node /tmp/cf-probe.md "round-trip probe" --kind task
```

它的预检只在 pool 有存活 runner 时才通过，所以这是会话里的*第二次*发送，不是第一次。
`--no-preflight` 跳过检查但跳不过冷 pool 问题：没有 runner 时，入队最多等 30 s 然后报失败，
而这并不能说明它是否会被投递。

## 5. 读回信，并对上 id

两个地方要看，两个都重要：

```bash
# The local mesh log: the inbound line carries the reply's id and the sender.
tail -n 20 ~/.pi/xfer/mesh.log | grep "mesh inbound"
```

**通过——闭环闭合。** 一条 inbound 行，其 `id` 是 `<the id from step 4>-echo`，`from` 是
`cf-node`，`to` 是你的本地节点。在本地 pi 会话里，这份 handoff 以一条携带回显文档的入站
通知出现。

**通过——agent 层，如果你想看。** `wrangler tail` 显示 DO 调用；回显文本包含 `In reply to: handoff <the id from step 4>`。

**失败——已接受但从未回答。** 发送报告成功，`wrangler tail` 里没有 DO 调用。那是
`forwardToAgent`（`src/mesh-registry.ts`）弄丢了 handoff，不是 mesh 的问题：actor 在 DO
记录它之前就 ack 了队列消息。

**失败——回答了两次。** 一次探针出现两条 inbound 行。DO 自己的去重本应让这不可能；看到它
意味着 DO 在服务两个实例（检查 `NODE_NAME` 恒定且 DO migration 是 `new_sqlite_classes`）。

## 6. 可选：模型分支 🔴

只在步骤 5 通过之后。设置 key 并重复步骤 4（用 `mesh send`——runner 现在是热的）：

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DEEPSEEK_MODEL   # optional, defaults to deepseek-chat
npx wrangler deploy
```

现在回信是模型的答案而不是回显。模型失败仍然会应答——用回显加上一行说明失败原因——因为一份
无人应答的 handoff 在 mesh 上读起来就是丢了。

**这会让每份 handoff 花钱。** 它刻意放在最后一步。

## 7. 记录结果

记下日期、rivetkit 版本、engine 镜像 tag、Worker 的域名形态（自定义域名 vs `workers.dev`），
以及哪些步骤通过了。将来会变动的是 rivetkit 的无服务器接口，因此后来的读者需要确切知道证明
了什么、对着什么证明的。

## 当它不工作的时候

下面每一行都在那次有记录的运行里真实撞到过；信号列是你实际看到的东西，不是你以为会看到的。

| 信号 | 原因 | 该怎么办 |
|---|---|---|
| `wrangler deploy` 成功但自定义域名不存在 | `wrangler.toml` 里 `routes` 写在 `[vars]` 之后——TOML 把它当变量吞了 | 把每个顶层键移到第一个 `[table]` 之前；用 `npm run check` 确认（它会打印 vars） |
| `failed to resolve host` / engine 无法访问 Worker | 中国大陆网络的 engine 访问 `*.workers.dev`，或 wrangler 4.0.0 报告已添加但从未创建的 `custom_domain` 路由 | 用你账号里的自定义域名；在 dashboard 里核对路由，不要信部署输出 |
| Engine 报 `serverless start payload too short`（空 body） | pool 的 `url` 指向了 **engine**，于是 engine 向自己 POST `/start` | `url` 必须是 Worker 的 `<WORKER_PUBLIC_URL>/api/rivet`，在 runner-config 和 `configurePool` 里*都*要如此 |
| Engine 只在 `/start` 上报 payload/协议错误 | engine 镜像 ≠ rivetkit 版本（例如 `engine:latest` 配 rivetkit `2.3.26`） | 把 engine 镜像钉到 `2.3.26`（检查单 §0） |
| 启动 runner 时 engine 返回 `endpoint_mismatch` | 没有 `topology.datacenters[].public_url`（或它不是客户端使用的主机名） | 挂上 §0 的配置文件并重启 engine |
| Worker 返回 500 | mesh registry 内部有配置/协议错误，`app.all("*")` 会把它直通出去 | `curl <WORKER_PUBLIC_URL>/api/rivet/health`（以及 `wrangler tail`）——500 的 body 就是 registry 自己的消息 |
| 部署后第一个请求失败，报 Zod/config 错误 | registry 构建时没有 `endpoint`（既没有 `MESH_ENDPOINT` secret 也没有 `RIVET_ENDPOINT` var） | 设置其中之一；没有它 `configurePool` 无法注册 |
| Engine 返回 400 `drain_grace_period must be less than request_lifespan` | pool body 写入时没有 grace period（engine 默认 1800 s），或有一个 ≥ lifespan 的值。**这是 Worker 自己的注册，不是你的步骤 1 curl**——上面步骤 1 的 body 本来就是合法的 | 时序在 `SERVERLESS_POOL_TIMING`（`src/pool-config.ts`），以秒计；保持 `drainGracePeriod < requestLifespan` 并重新部署。engine 会保留最后一份好配置，因此这不需要 `DELETE` 就能修复 |
| `wrangler tail` 反复显示 `serverless pool configuration attempt failed`，且 Cloudflare 开始返回 `Too many subrequests` | `configurePool` 在重试一个被拒绝的请求，而 400 不是暂时性的 | engine 会保留最后一份好 pool 记录，所以修掉原因（上一行）再重新部署；upsert 由 registry 每个 isolate 尝试一次，不是每个请求一次 |
| `mesh send` 拒绝：`no runner in pool "cloudflare"` | 在冷无服务器 pool 上的正确行为——engine 只为待投递启动 runner | 从裸客户端做第一次发送（§4），或等一会再重试 |
| Actor 卡住：`/actors` 显示一个重启也清不掉的 `error` | actor 记录的 `error` 是粘性的——runner 出现时不会被清除 | 销毁再重建：`DELETE /actors/<id>?namespace=<ns>`，然后再次 `getOrCreate`（§4 就是这么做的） |
| 列表里显示了节点但 runner 从不启动 | actor 存在，但它所在的 pool 背后没有存活 runner | 从裸客户端发第一份 handoff（§4）——那正是启动 runner 的东西 |
| `wrangler tail` 反复显示 `/api/rivet/start` 返回 503 `Serverless pool is not configured` | registry 里的 `configurePool` 还没写入 pool——它只在 `/start` 时运行，而它需要 `MESH_ENDPOINT`（或 `RIVET_ENDPOINT`）才能写任何地方 | 重跑步骤 1（冷 pool 需要的带外引导），然后检查 Worker 是否真的有 endpoint secret：`curl <worker>/health` 会打印 `engine` |

## 这不能证明什么

- **不能证明这个节点在首次投递之前的任何事。** actor 由 §4 的投递创建，不是由 Worker 创建；
  列表里的一行只证明 actor 存在，从不证明有 runner 能托管它。
- **不能证明规模或负载。** 一次探针，一条回信。
- **不能证明唤醒延迟。** 睡着的无服务器 actor 由 engine 自己的调度唤醒；本示例不测量它。
- **不能证明跨 rivetkit 大版本。** 本示例钉在 `2.3.26`，对它之后不作承诺。
- **不能证明这个节点作为按计划工作的来源。** 按里程碑的范围说明，本示例止步于往返。
