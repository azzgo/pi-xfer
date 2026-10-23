# SSH Link: 点对点 ssh 转发作为 mesh 之外的跨机传输

Status: accepted

## Context

Mesh（ADR 0013）为跨机 handoff 提供了注册/发现/路由/离线缓冲，但它需要一台常驻引擎。点对点场景——两台互信机器、临时连通、用完即拆——不应该要求起引擎。ssh 本身就是互信通道：它自带认证、加密和 unix socket 转发（`-L`/`-R`），而本地发现（`listPeers`）只扫描 `XFER_DIR` 顶层的 `.sock` 文件——ssh 创建的转发落点天然落入该扫描，零注册代码。

## Decision

新增 `/xfer ssh up <user@host>` / `down <host>`，由 pi 扩展 spawn 一条 `ssh -N` 建立双向 **Link**：

- **一条命令，内建双向**：`-L` 为远端每个现有 sock 各建一条（`up` 时刻快照，重跑刷新），`-R` 为本机 pi 建一条（落点 = 本机真名，进对端顶层目录）。单向转发没有价值——发得过去回不来。
- **生命周期 = pi 进程**：ssh 是扩展子进程，pi 退出即拆。这正是 ADR 0013 "上线单元 = 连接单元 = pi 实例" 的同一哲学——不出现"隧道活着但 pi 死了"的判死歧义。`ExitOnForwardFailure=yes` 写死；`StreamLocalBindUnlink=yes` 是**绑定时的**清理（下次 `up` 不被远端残留 sock 阻塞），不是退出时的——死掉的 ssh 会在远端留下 `-R` 落点，由**对端的 gc** 按 orphan-sock 规则（ECONNREFUSED）收走，这是设计的清理路径而非失败。远端落点的出现也是异步的（sshd 建它晚于 ssh 就绪），`up` 会显式等待它落地后才报成功，否则对端发现会闪断。
- **名字冲突拒绝**：落点撞本机真名或已有 Link 名，`up` 直接拒绝。同 ADR 0013 的"先查后占、拒绝而非自动改名"；跨机名字唯一性是用户的账。
- **Link 是一等词汇，不是 Peer**：`<name>.json` 写 `{ via: "ssh", host, pid }`——json 即账本，不另建注册表；`/xfer list` 显示瘦条目（`· via ssh host`，无 cwd/model）。`up` 探测远端用 `ssh host 'echo ${XFER_DIR:-$HOME/.pi/xfer}'`，一次往返拿目录+快照。
- **gc 管文件，up/down 管进程**：gc 的 Link 分支只判 pid（不做 listener 探测——ssh 本地端永远 accept，探测无意义）；死 → 删 sock+json 并提示 `/xfer ssh up` 重建。gc 不 kill 进程。

**明确不做**：路由、离线缓冲、自动发现（发现 = 对端目录快照）、adapterd 支持（pi 扩展专属）。

## Considered

- 子目录物理隔离（`XFER_DIR/links/`）——否决：远端 `-R` 落点无论如何以 Peer 姿态出现在对端顶层（对端的 listPeers 我们控制不了），隔离只买到半个纯粹性，却要改两处代码。
- 自动改名落盘（`name@host.sock`）——否决：落盘名与真名分裂，回信循环静默错投。
- 纯手动 ssh 命令——否决：与"离开 pi 进程 autodispose"矛盾。
- mesh 本身——不替代：Link 无引擎、无常驻组件，覆盖一次性点对点场景；两者并存，命令面显式区分（`/xfer <name>` 本地、`/xfer ssh` 隧道、`/xfer mesh <name>` 引擎）。

投递语义零改动：半死隧道上 ack 超时 → `unknown`，正是 `xfer_to` 为此准备的既有结论（"do not resend"）。
