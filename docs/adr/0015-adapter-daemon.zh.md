> 中文版 · 英文原文：[0015-adapter-daemon.md](0015-adapter-daemon.md)

# xfer-adapterd：一个 bundle、双传输、take-to-read 的 Inbox

状态：accepted

## 背景

pi 通过扩展接入 xfer 网络。其他每个 agent 宿主（Cursor、grok bot、自建 harness）也可以拥有
一个 xfer socket，但它们没有 pi 运行时来承载扩展，没有 `/xfer` 命令面，也没有办法跑 mesh
actor 循环。定下来的接入机制是一个自包含的 bundle，`xfer-adapterd.cjs`，由宿主作为后台进程
启动（它接入的 mesh 传输由 ADR 0013 确立）。

塑造它的约束是：任何宿主特有的东西都不得泄漏进名字或协议；扩展的本地协议就是线上契约
（`xfer-notify`/ack JSONL，1 MiB 帧上限）；该 daemon 必须能在一个从未跑过 pi 的宿主上使用；
构建复用 mesh runtime 的 native addon 改写，因此不出现任何运行时 npm 依赖。

## 决策

**一个 bundle，双传输。** `xfer-adapterd` 默认提供本地 Unix-socket 传输，并可以用扩展所用的
同一个 `MeshNode` 加入 Mesh。名字保持传输中立；只有 mesh 传输模块提及引擎。被要求时
`up` 加入 mesh（`--mesh`，配置来自 `~/.pi/xfer/mesh.config.json` 或
`--engine/--namespace/--token`）；`mesh send` 在不加入的情况下入队一份一次性 handoff，因此
只发送的宿主既不需要 daemon 也不需要注册。

**Inbox 是 take-to-read。** 入站 handoff 在一切之前先追加进一个 JSONL Inbox
（`<encoded-name>.inbox.jsonl`）；`inbox take` 把文件原子地改名挪走并消费其中的记录，因此
并发的追加会落到一个新文件里并得以存活。`inbox list` 只窥视不消费。Inbox 背后没有持久存储
设计。

**投递策略。** Inbox 永远优先。`--on-handoff <cmd>` 是尽力而为的第二策略：handoff JSON 送到
该命令的 stdin，环境中带 `XFER_HANDOFF_ID` / `XFER_HANDOFF_FROM` / `XFER_HANDOFF_FILE`。
某个策略失败永远不会拖垮进程。`url` 策略（HTTP POST）因待研究而推迟，并且有意不预留成
flag。

**安装产物。** `install --host <cursor|generic> --into <dir>` 把 skill 固定在原位：
`SKILL.md`（通用操作：up / send / inbox take / rename）、用于自安装的 `install.md`、一个
宿主覆盖页，以及 `.xfer-agent.json`——含宿主类型、默认值和安装时生成的推荐启动命令——agent
永远不自己拼 adapter flag。仓库里的 `skills/xfer-agent/` 是模板的真相源；分发靠手工复制。

## 后果

- 非 pi 宿主是一等 Node：它可以是本地目标，也可以是 mesh actor，还能向 pi 和其他 adapter
  宿主发 handoff。
- daemon bundle 内联了 mesh runtime（与 `mesh-runtime.cjs` 相同的 esbuild 配方和 native
  改写）；native addon 仍在首次加入 mesh 时下载到 `~/.pi/xfer/cache`。
- 只发送的宿主可以完全跳过 daemon；只有能接收的宿主才跑后台进程。
- Inbox 在构造上就是有损的（take 即删除）。这正是重点：它对应的是"单向，投递进会话"，而不是
  一个持久邮箱。

## 备选方案

按宿主做集成（Cursor 扩展、MCP server……）——每个宿主都得重新实现同一套 socket 和 mesh
循环。持久邮箱——与单向 handoff 模型矛盾，且需要一套清理方案。每个宿主一套独立传输——破坏
"一个名字、一个参与者"的 Node 契约。
