> 中文版 · 英文原文：[mesh-log.md](mesh-log.md)

# Mesh 日志 — 里面有什么、没有什么、如何维护

mesh 传输**在进程内**跑在 pi 里（ADR 0013），并被钉成静默，因为 RivetKit 记录日志的方式
和独立服务器一样——直接写到进程的 stdout——而这些行每一行都落在 pi 屏幕上而不是一次重绘
（`/xfer mesh up` 曾把欢迎横幅和原生 SQLite 警告糊满 TUI）。静默不能等于丢失，所以凡能捕获
的仍然写下来：

```
~/.pi/xfer/mesh.log      append-only, one logfmt line per record, mode 0600
```

用 `tail -n 50 ~/.pi/xfer/mesh.log`（或 `less +G`）读它。这是给人看的文件，永远不会被喂回
agent 的上下文。

```
2026-10-14T07:09:39.991Z level=info msg="mesh up" node=laptop endpoint=http://engine.example.com:6420 namespace=default pool=laptop nativeLogLevel=silent adopted=Sleeping
2026-10-14T07:12:04.006Z level=info msg="mesh send" from=laptop to=phone id=k3f9 bytes=4821
2026-10-14T07:12:31.880Z level=warn msg="mesh misroute" id=k3f9 from=laptop to=phone reached=laptop
```

## 两个生产者，一条时间线

| 生产者 | 接在哪 | 记录什么 |
|---|---|---|
| RivetKit 自己的 JS logger | `mesh-engine.ts` 中 `ensureNode` 里的 `setup({ logging: { baseLogger: createMeshLogSink() } })` | `starting rivetkit envoy`、api 调用、engine/actor 警告、actor 作用域的行（`child({actorName, actorKey, …})` 的绑定会被合并进来） |
| pi-xfer 自己的 mesh 事件 | `mesh.ts` 里的 `logMeshEvent(...)` 调用（`up` / `down` / `send` / inbound / misroute） | 节点生命周期、拒绝（`mesh up refused — …`、pool 不匹配）、发送/接收的 id 与大小、误路由 |

一切都落到 `mesh-log.ts`：`formatMeshLogLine`（logfmt）、`appendMeshLogLine`（永不抛错——
日志目标坏掉不能把 mesh 拖下去）、`createMeshLogSink`（交给 RivetKit 的 logger）以及
`logMeshEvent`。

Handoff **正文永远不进日志**——只有 id、节点名、字节数和接收侧的 tmp doc 路径。加事件时
请保持这样：日志是长期存在的，对任何拿到该账户的人都可读，文档则不是。

## 里面没有什么，以及为什么

**原生运行时自己的 tracing 输出**——那些 ts=… level=warn
message="SQLite transaction is unnamed…" 行。RivetKit 的原生插件（Rust）在 fd 层直接把
它们写到进程 stdout；它们从不经过 `process.stdout.write`，因此本进程里没有任何 JS 能看见
它们，更别说重定向。在 rivetkit 2.3.26 上打过 `process.stdout.write` 补丁实测：只有 JS
logger 的块会到达，Rust 的行继续直奔终端。也不存在能选文件的 `RIVET_LOG_*` 变量——可用的
旋钮是 `RIVET_LOG_LEVEL`、`RIVET_LOG_TARGET`、`RIVET_LOG_TIMESTAMP`、`RIVET_LOG_MESSAGE`、
`RIVET_LOG_ERROR_STACK`（且 `RUST_LOG` 被忽略）。

它们只在终端上出现，且需要宿主以显式级别启动：

```bash
RIVET_LOG_LEVEL=warn pi     # native warns appear on screen (and will smear it)
```

Rust *panic* 是另一条路径——它们不经过滤直接进 stderr，不受 `RIVET_LOG_LEVEL` 影响。

所以，一个需要原生细节的支持问题，只能靠带着该级别复现来回答，或抓取终端
（tmux capture-pane -pS -3000）——无法事后从 `mesh.log` 里回答。

## 维护它

- **加事件**：在 MeshNode 里调用 logMeshEvent(logPath, level, "mesh <what>", { fields })——this.logPath 已持有目标路径。宁可每个结果（成功/拒绝/失败）
  一条记录，而不是 start/end 成对。
- **文件级别**：`mesh-log.ts` 里的 `MESH_LOG_LEVEL` 是一个**常量**，当前为 `info`，刻意
  不做环境变量旋钮——这个文件的意义就在于：当问题被证明需要细节时，细节已经在那里，而没人
  能事后才把它打开。提高它（例如到 `debug`）是一次源码修改；它会加上 RivetKit 那些啰嗦的
  api 调用行，所以请在分支上做，不要动 main。
- **封闭测试**：永远不要让测试写真实的 `~/.pi/xfer/mesh.log`。
  `MeshNodeOptions.logPath` 和 `RivetEngineOptions.logPath` 是注入缝；
  `mesh.test.ts` 为它构造的每个节点都用 `meshLogPath()`。
- **升级 RivetKit**：`createMeshLogSink` 刻意是鸭子类型的——Pino 只是 rivetkit 的构建期
  传递依赖（ADR 0013 让它不出现在任何依赖列表里），因此 sink 只实现 RivetKit 实际调用的那
  一面。版本升级时，先复核这一面再信任日志：
  `grep -rno "logger[0-9]*()\.[a-zA-Z]*(" node_modules/rivetkit/dist/tsup/*.js | sed 's/.*()\.//' | sort -u`
  应当仍然是 `child`、`debug`、`error`、`info`、`trace`、`warn`。
- **增长**：该文件只追加、不轮转，和 `broker.log`、`admin.log` 一样——由人来清理
  （`rm ~/.pi/xfer/mesh.log` 永远安全）。
- **验证改动**：`npm test` 覆盖 sink 与事件；端到端检查是 `/xfer mesh up` 然后读文件——
  屏幕必须保持干净，同时 `mesh.log` 增加本次会话的记录。
