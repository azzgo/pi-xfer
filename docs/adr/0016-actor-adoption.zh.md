> 中文版 · 英文原文：[0016-actor-adoption.md](0016-actor-adoption.md)

# mesh up() 中的 status-aware actor 接管

状态：accepted

## 背景

ADR 0013 定下了"名字冲突：先查后占——拒绝，不自动改名"，因为同一个 actor key 会路由到已经
存在的那个 actor。那条规则被实现成无条件拒绝：引擎列表里任何同名 actor 都会阻塞 `up()`。
它写于 mesh 还没有常规崩溃叙事的时期，使得恢复必须在另一台宿主上手动 `down`——即便那台宿主
早已消失。

Rivet 的 actor 生命周期让大多数同名 actor 根本不是竞争者：

- 虚拟 actor 永远不会被自动清理。runner 丢失时（pi 进程死掉、机器睡眠、网络断开），引擎会
  让 actor 休眠而不是删除它；它的持久状态被保留。
- 因此一个丢失的 actor 通常读作 `Sleeping`（或 `Crashed`，或一个从未变得可连接的
  `Pending` 分配），而不是一个活着的参与者。它的名字可以被最先重连的一方接管。
- actor 状态是引擎时间戳字段（`destroy_ts` / `error` / `sleep_ts` / `connectable_ts`）的纯
  函数；actor 列表上没有状态字段。

唯一不安全的情形是 `Running`：一个活的 runner 此刻正连着，第二个解析同一 key 的进程会静默地
把流量路由到那里。

剩下的锐利之处是心跳延迟。一个刚崩溃的 actor 可能仍然带着 `connectable_ts`（因而读作
`Running`），直到引擎发现 runner 已不在。接管有意不加重试循环：对列表的一次读取就做决定，
一具新鲜的尸体可能需要在片刻之后再 `up()` 一次。

## 决策

`MeshNode.up()` 变得 status-aware，没有 `--takeover` flag，pi 与 adapter daemon 也没有
分开的代码路径——每个宿主都是同一种行为：

- **名字未找到** → 正常创建。
- **同名 actor 为 `Sleeping` / `Crashed` / `Pending`** → 接管：在本进程中重新解析已有的
  actor（`getOrCreate` + `resolve()`），让本进程的 run 循环拥有它。持久 actor 状态（节点
  描述）被保留，接管路径上**绝不销毁**该 actor。
- **同名 actor 为 `Running`** → 拒绝，并指向另一台宿主
  （`先在那边 /xfer mesh down`）。

`down()` 仍是唯一的销毁路径：它才是有意离线的含义，接管不能与它混为一谈。

## 后果

- 崩溃的宿主不再需要在别处手动 `down`；同名下的下一次 `up()` 会恢复该节点，包括它的描述。
- 真正并发的启动仍然安全失败：`Running` 的 actor 会被拒绝。
- 心跳窗口是一个有文档记录的粗糙边缘，不是本轮该用重试糊过去的 bug。
- `MeshNodeInfo` 现在携带 `status`；`/xfer mesh up` 与 adapter daemon 共用同一批 hermetic
  测试（睡眠时接管、运行时拒绝）。

## 参考

- ADR 0013（mesh 传输）——本文细化的那条冲突规则。
- ADR 0015（adapter daemon）——共享这一生命周期的第二个宿主。
