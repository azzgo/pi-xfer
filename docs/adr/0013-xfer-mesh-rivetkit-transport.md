# Xfer mesh 传输层：RivetKit in-process actor，opt-in，与本地 sock 显式并存

跨机互发 handoff 需要注册/发现/路由/离线缓冲，这些在单机 xfer 里是手写的（`.json` 注册表、gc、notify+ack），跨机后复杂度爆炸。选定 RivetKit 作为 mesh 传输层：引擎（单节点 docker，RocksDB file_system 后端，无需 FDB/NATS/ClickHouse）承担注册、存活检测、actor 间路由与 durable queue；xfer 侧只写一个 actor 定义与本地 sock 的桥接。

关键决定：

- **opt-in，默认不上线**：`/xfer mesh up/down` 手动控制，本地 Unix-socket 通道在未上线时完全不受影响（传输并存）。
- **in-process**：RivetKit worker 跑在 pi 扩展进程内，不引入独立 bridge daemon——上线单元 = 连接单元 = pi 实例，避免"daemon 活着但 pi 死了"的判死歧义，也使未来任意设备（如手机）可各自独立入网。
- **单 actor 类型 `xfer-instance`，key = xfer name**；发现直接用引擎 `listActors`，不建 registry actor（引擎调度状态即注册表，避免第二真相源）。crash policy 选 sleep：pi 死 → runner 断 → actor sleep → 不在在线列表，天然复刻 `/xfer gc` 语义。
- **name 冲突先查后占、拒绝而非自动改名**：同 key 会静默路由到先创建者，必须上线前检测。
- **命令面显式选择传输**：`/xfer <name>` 仅本地，`/xfer mesh <name>` 仅 mesh，不做自动 fallback。
- **handoff 文档内联进队列消息**（跨机 `/tmp` 路径失效）；接收端落盘后复用 server.ts 的 inbound deliver 管线，来源标注 `· mesh`。
- **跨机文档为纯静态快照**：Follow-up channel（本机 page-tool CLI）一节对 mesh 投递移除，不提供追问通道——回信循环覆盖不了它（broker 不是 agent；源会话也可能已结束）。
- **web-picker/broker 永不注册为 actor、永不连引擎**：跨机发送借道本机 mesh 实例；清单用读穿查询 + broker 内短 TTL 缓存平滑 UI，无持久缓存（引擎是唯一真相源）。

实施注记（bundle 模式）：rivetkit 的 in-process runner 必须用 native 二进制（wasm 被官方禁止承担 envoy），无法打进 JS bundle。因此 rivetkit 不进任何依赖清单；JS 部分预打包为入库的 bundle（同 web-picker 双轨模式），native .node 由首次 `mesh up` 按锁定版本从 npm 下载到本机缓存（不进 git）。曾评估把 runner 挪到引擎侧 docker——否决，因为引擎侧 runner 会立即消费 queue，pi 不在线时入站消息无人接收，离线缓冲语义被破坏。

E2E 注记：durable queue 的缓冲从目标 actor 创建后才生效——向从未上线过的节点发送会在超时后报错（现实现 30s），而非无限期缓冲；目标节点下线前已入队的消息在节点重新上线后仍可消费。引擎侧 crash_policy 默认即 sleep，符合本 ADR，无需额外配置。

Considered: 纯 Tailscale 自写注册/路由/缓冲（全要手造，durable queue 是大头）；独立 bridge daemon（多一个需 GC 的常驻组件）；registry actor（与引擎判死打架）；自动 fallback 传输选择（歧义逻辑不值 5 个字符）。
