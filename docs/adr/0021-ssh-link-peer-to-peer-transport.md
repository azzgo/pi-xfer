# SSH Link: 点对点 ssh 转发作为 mesh 之外的跨机传输

Status: accepted

## Context

Mesh（ADR 0013）为跨机 handoff 提供了注册/发现/路由/离线缓冲，但它需要一台常驻引擎。点对点场景——两台互信机器、临时连通、用完即拆——不应该要求起引擎。ssh 本身就是互信通道：它自带认证、加密和 unix socket 转发（`-L`/`-R`），而本地发现（`listPeers`）只扫描 `XFER_DIR` 顶层的 `.sock` 文件——ssh 创建的转发落点天然落入该扫描，零注册代码。

## Decision

**Link 是 Mesh 的补充，不是替代。** Mesh 是跨机的主打路径：注册、发现、路由、durable queue 是它的职责，代价是一台常驻引擎。Link 只覆盖"两台已经互信、临时连通、用完即拆"的点对点场景——不建引擎、不注册、不缓冲、不发现（发现就是对端目录快照）。需要离线投递、需要目标休眠时也能排队、需要多机发现，这些都只有 Mesh 能给。

命令面（`<host>` 是任何 ssh 目标：`~/.ssh/config` 的别名、主机名，或 `user@host`）：

```
/xfer ssh in <host> <name...>   -L：把远端已有的 socket 引进来（必须点名——远端有什么只有它知道）
/xfer ssh out <host> [name]     -R：把本机 pi 的 socket 推出去（不用点名——对象就是自己）
/xfer ssh list <host>           只读探测：远端 xfer 目录与可 in 的 socket
/xfer ssh status                本进程维护的 forward + 存活状态（外来的那些另列）
/xfer ssh down [host]           只拆本进程建的
```

- **in 必须点名，out 不必**：这不是对称性缺失，而是两个方向的目标来源不同。`out` 的对象是本机 pi 自己的监听 socket，永远存在、不用问；`in` 的对象是远端的某个 socket，只有探测才知道它叫什么，所以必须显式给出，错了就报"没有这个，可用的是 …"。`list <host>` 就是为拿这份名单而存在的。

- **方向必须显式指定，没有 `both`**：方向不是能取中间值的参数，而是"哪一边的监听对象已经存在"这个事实。两个半边的**前提不同源**（本机 socket 永远在；远端 socket 要先探测），一条命令同时断言两边，只是把两个不保证成立的假设叠起来——所以 `both` 不是权衡，是范畴错误。
- **无 TTY，因此必须免密**：spawn 的 ssh 带 `BatchMode=yes`，交互式密码提示不可能被回答（pi 的 stdin 归 TUI）。支持密钥与 ssh-agent；认证失败时把 ssh 的 stderr 翻成可执行的建议（放公钥 / ssh-add），而不是一个裸退出码。
- **生命周期 = pi 进程**：由该 pi 显式拆除（见上条），这仍是 ADR 0013 "上线单元 = 连接单元 = pi 实例" 的同一哲学——不出现"隧道活着但 pi 死了"的判死歧义。`ExitOnForwardFailure=yes` 写死；`StreamLocalBindUnlink=yes` 是**绑定时的**清理（下次建链不被远端残留 sock 阻塞），不是退出时的——死掉的 ssh 会在远端留下 `-R` 落点，由**对端的 gc** 按 orphan-sock 规则（ECONNREFUSED）收走，这是设计的清理路径而非失败。远端落点的出现也是异步的（sshd 建它晚于 ssh 就绪），建链会显式等待它落地后才报成功，否则对端发现会闪断。
- **名字冲突拒绝**：`-L` 的本地落点撞上已有本地 sock（且不是本 Link 的旧账本），或远端已有与本机真名同名的节点，命令直接拒绝。同 ADR 0013 的"先查后占、拒绝而非自动改名"；跨机名字唯一性是用户的账。注意 `-R` 的落点在**远端**，本地那个同名 sock 是转发的**目标**（本机监听器），必须存在，不参与碰撞判定。
- **`list` 与 `status` 是两件事**：`list <host>` 回答"那台机器有什么可 in"（只读探测，不建隧道）；`status` 回答"我这条 pi 现在维持着哪些 forward、它们还活着吗"。混成一条命令会让"我要连什么"和"我连了什么"共用输出，两个问题都答不好。
- **所有权写进账本**：每条 Link 的 `.json` 记 `owner`（创建它的 pi 进程 pid）。`down` 与 `session_shutdown` 只拆 `owner === 自己` 的；别人的 Link 由别人的 pi 负责，它死了以后由 gc 按 dead-link 收尾。
- **退出必须显式拆**：ssh 子进程 `unref` 后**不会**随父进程死（会被 init 收养），所以"autodispose"靠 `session_shutdown` 里显式 `sshDown`，不是靠进程树。
- **Link 是一等词汇，不是 Peer**：`<name>.json` 写 `{ via: "ssh", host, pid }`——json 即账本，不另建注册表；`/xfer list` 显示瘦条目（`· via ssh host`，无 cwd/model）。探测远端用 `ssh host 'echo ${XFER_DIR:-$HOME/.pi/xfer}'`，一次往返拿目录+快照。
- **gc 管文件，in/out/down 管进程**：gc 的 Link 分支只判 pid（不做 listener 探测——ssh 本地端永远 accept，探测无意义）；死 → 删 sock+json 并提示 `/xfer ssh in|out` 重建。gc 不 kill 进程。

## 单向隧道对 handoff 的两条硬约束

Link 的 socket 是本地的，但 socket 后面的人不在本机。ADR 0013 早已为 mesh 解决过同一个矛盾（跨机 `/tmp` 路径失效 → 文档内联进队列消息），Link 沿用同一结论，只是触发条件是"目标是 Link"而不是"传输是 mesh"：

- **文档必须内联，不能只给路径**。发送侧先照旧写本地 tmp（本地观察、日志、返回值的 `Doc:` 都是它），但检测到目标是 Link（同一个 `readPeerMetadata` 判活里能读到 `via: "ssh"`）时，把正文拼进消息帧，收端写入**自己**的 tmp 再走既有 inbound 管线。收端因此永远拿到一个本机可读的路径，下游毫不知情。
- **不假设反向通道**。`in` 与 `out` 各开半边，没有对侧配合就不存在回路。发送侧检测到目标是 Link 且 `kind: "task"` 时，在结果里明确警告"对方可能答不回来"；收端看到 `· ssh` 标记时也会被告知"回复失败是隧道的形状，不是对方消失"。产品层面**不禁止** `task`——禁止会是撒谎（有人确实两边都开了），但沉默地让 task 掉进虚空更糟。

**明确不做**：路由、离线缓冲、自动发现（发现 = 对端目录快照）、adapterd 支持（pi 扩展专属）。

## Considered

- 子目录物理隔离（`XFER_DIR/links/`）——否决：远端 `-R` 落点无论如何以 Peer 姿态出现在对端顶层（对端的 listPeers 我们控制不了），隔离只买到半个纯粹性，却要改两处代码。
- 自动改名落盘（落点改名成别的名字）——否决：落盘名与真名分裂，回信循环静默错投。
- 纯手动 ssh 命令——否决：与"离开 pi 进程 autodispose"矛盾。
- mesh 本身——不替代：Link 无引擎、无常驻组件，覆盖一次性点对点场景；两者并存，命令面显式区分（`/xfer <name>` 本地、`/xfer ssh` 隧道、`/xfer mesh <name>` 引擎）。

投递语义零改动：半死隧道上 ack 超时 → `unknown`，正是 `xfer_to` 为此准备的既有结论（"do not resend"）。

`out` 单向的后果要说清：远端节点收到 handoff 后回不了信——它们的回发目标是本机真名，而 `-L` 只让流量从本地发起。要回信，得在对端跑 `/xfer ssh in <本机>`，或本地同时开 `in`。这是显式方向的代价，也是它的意义。
