# SSH Link: 点对点 ssh 转发作为 mesh 之外的跨机传输

Status: accepted

## Context

Mesh（ADR 0013）为跨机 handoff 提供了注册/发现/路由/离线缓冲，但它需要一台常驻引擎。点对点场景——两台互信机器、临时连通、用完即拆——不应该要求起引擎。ssh 本身就是互信通道：它自带认证、加密和 unix socket 转发（`-L`/`-R`），而本地发现（`listPeers`）只扫描 `XFER_DIR` 顶层的 `.sock` 文件——ssh 创建的转发落点天然落入该扫描，零注册代码。

## Decision

**Link 是 Mesh 的补充，不是替代。** Mesh 是跨机的主打路径：注册、发现、路由、durable queue 是它的职责，代价是一台常驻引擎。Link 只覆盖"两台已经互信、临时连通、用完即拆"的点对点场景——不建引擎、不注册、不缓冲、不发现（发现就是对端目录快照）。需要离线投递、需要目标休眠时也能排队、需要多机发现，这些都只有 Mesh 能给。

新增 `/xfer ssh in|out <host>` / `down <host>`，由 pi 扩展 spawn 一条 `ssh -N` 建立单向 **Link**（`<host>` 是任何 ssh 目标：`~/.ssh/config` 的别名、主机名，或 `user@host`）：

- **方向必须显式指定，没有 `both`**：方向不是一个可以取中间值的参数，而是"哪一边的监听对象已经存在"这个事实。`-R`（`in`）的前提是本机 pi 的 socket 存在——永远成立；`-L`（`out`）的前提是远端的那些 sock 存在——要先探测才知道。两者的前提不同源，所以一条命令同时断言两边，只是把两个不保证成立的假设叠在一起：真实的用法是先 `list <host>` 看到远端有什么，再对它们开 `out`。`in` 的落点 = 本机真名，进对端顶层目录。
- **无 TTY，因此必须免密**：spawn 的 ssh 带 `BatchMode=yes`，交互式密码提示不可能被回答（pi 的 stdin 归 TUI）。支持密钥与 ssh-agent；认证失败时把 ssh 的 stderr 翻成可执行的建议（放公钥 / ssh-add），而不是一个裸退出码。
- **生命周期 = pi 进程**：ssh 是扩展子进程，pi 退出即拆。这正是 ADR 0013 "上线单元 = 连接单元 = pi 实例" 的同一哲学——不出现"隧道活着但 pi 死了"的判死歧义。`ExitOnForwardFailure=yes` 写死；`StreamLocalBindUnlink=yes` 是**绑定时的**清理（下次建链不被远端残留 sock 阻塞），不是退出时的——死掉的 ssh 会在远端留下 `-R` 落点，由**对端的 gc** 按 orphan-sock 规则（ECONNREFUSED）收走，这是设计的清理路径而非失败。远端落点的出现也是异步的（sshd 建它晚于 ssh 就绪），建链会显式等待它落地后才报成功，否则对端发现会闪断。
- **名字冲突拒绝**：`-L` 的本地落点撞上已有本地 sock（且不是本 Link 的旧账本），或远端已有与本机真名同名的节点，命令直接拒绝。同 ADR 0013 的"先查后占、拒绝而非自动改名"；跨机名字唯一性是用户的账。注意 `-R` 的落点在**远端**，本地那个同名 sock 是转发的**目标**（本机监听器），必须存在，不参与碰撞判定。
- **`list <host>` 是只读探测**：只 ssh 过去读对端目录与节点名，不建隧道——先看清有什么、会不会撞名，再决定开哪个方向。
- **Link 是一等词汇，不是 Peer**：`<name>.json` 写 `{ via: "ssh", host, pid }`——json 即账本，不另建注册表；`/xfer list` 显示瘦条目（`· via ssh host`，无 cwd/model）。探测远端用 `ssh host 'echo ${XFER_DIR:-$HOME/.pi/xfer}'`，一次往返拿目录+快照。
- **gc 管文件，in/out/down 管进程**：gc 的 Link 分支只判 pid（不做 listener 探测——ssh 本地端永远 accept，探测无意义）；死 → 删 sock+json 并提示 `/xfer ssh in|out` 重建。gc 不 kill 进程。

**明确不做**：路由、离线缓冲、自动发现（发现 = 对端目录快照）、adapterd 支持（pi 扩展专属）。

## Considered

- 子目录物理隔离（`XFER_DIR/links/`）——否决：远端 `-R` 落点无论如何以 Peer 姿态出现在对端顶层（对端的 listPeers 我们控制不了），隔离只买到半个纯粹性，却要改两处代码。
- 自动改名落盘（落点改名成别的名字）——否决：落盘名与真名分裂，回信循环静默错投。
- 纯手动 ssh 命令——否决：与"离开 pi 进程 autodispose"矛盾。
- mesh 本身——不替代：Link 无引擎、无常驻组件，覆盖一次性点对点场景；两者并存，命令面显式区分（`/xfer <name>` 本地、`/xfer ssh` 隧道、`/xfer mesh <name>` 引擎）。

投递语义零改动：半死隧道上 ack 超时 → `unknown`，正是 `xfer_to` 为此准备的既有结论（"do not resend"）。

`out` 单向的后果要说清：远端节点收到 handoff 后回不了信——它们的回发目标是本机真名，而 `-L` 只让流量从本地发起。要回信，得在对端跑 `/xfer ssh in <本机>`，或本地同时开 `in`。这是显式方向的代价，也是它的意义。
