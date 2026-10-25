> 中文版 · 英文原文：[notes-identity-and-addressing.md](notes-identity-and-addressing.md)

# 身份、寻址、发现、可达性 —— 研究输入（命名 / 同名冲突 / 身份绑定 / 可达性判断 / 能力声明 / 凭据，local + mesh + adapterd）

来源：受项目 `pi-xfer` 人类 Node 委托，在 `ae1121c`（分支 `main`，2026-10-18）上进行的只读走查。没有改动任何代码；唯一写出的文件就是本文件。本文未触碰任何在线部署：没有启动 engine，没有读取 `~/.pi/xfer` 状态，`XFER_ALLOW_REMOTE` 从未被设置。下文关于 engine 的每一个事实都来自源码、测试中的 hermetic fake，或 ADR。术语遵循 `CONTEXT.md`（Mesh、Node、Runner/pool、Delivery verdict、Adapter Daemon、Inbox、Handoff）；不发明同义词。

全文引用的前置笔记：`docs/milestones/notes-mesh-peer-identity.md`（归档于 `f7d5f9f`，2026-10-17）。其 mesh 侧结论标注为 **沿用 (carried forward)** 或 **本次复核推翻 (overturned)**。local socket 与 adapterd 的身份语义在该笔记中未覆盖，属于新工作（§4、§5）。

断言以 `file.ts:line` 形式引用，行号以 `ae1121c` 为准。

---

## 0. 摘要 —— 四个层次，以及缺失的那一层

| 层次 | 真相所在 | 它是什么 | 与身份绑定？ |
|---|---|---|---|
| **Name** | 线上与磁盘上的一个字符串 | `xferName` | 否 —— 自由文本，不做校验，从不检查唯一性 |
| **Address（local）** | `<xferDir>/<encodeURIComponent(name)>.sock` | 文件系统路径 | 否 —— 地址*就是*名字 |
| **Address（mesh）** | actor 类型 `xfer-instance` + 单段 actor key `[name]` | engine 对象 | 否 —— key *就是*名字 |
| **Node ↔ 主机绑定** | `MeshConfig.pool`（mesh）、`<xferDir>`（local） | 放置 / 目录 | **部分** —— pool 把 actor 绑到某台机器的 Runner（`docs/adr/0017-mesh-runner-pools.md:20-26`）；没有任何东西把本地 peer 的 socket 绑定到应答它的进程 |

四层之下都没有凭据层（mesh：§8.1；local socket：§8.3；adapterd：§8.3）。因此身份就是"投递那一刻地址解析到的那个东西"，而名字是发送者对自己做出的声明，不是接收者核验过的事实。

---

## 1. 命名：名字从哪里来

### 1.1 pi 扩展

`deriveName()`（`utils.ts:82-95`）—— 先匹配者胜出：

1. `--xfer <name>` 标志（`utils.ts:83-84`；在 `index.ts:24-29` 注册为 `pi.registerFlag("xfer", … default: undefined)`）。
2. 相对**当前工作目录**的 `.pi/settings.json` `name` 字段（`utils.ts:86-91`）—— 同一个扩展二进制在不同目录下会得到不同名字。
3. 兜底 `<basename(cwd)>_<4 个随机 base36 字符>`（`utils.ts:93-95`）。

对结果**没有任何**校验：没有字符集、没有长度上限、没有保留名列表、没有大小写折叠。`/xfer name <new>` 可以用任意字符串重新绑定 socket（`controller.ts:127-158`、`commands.ts:196-206`）。

### 1.2 Adapter Daemon

`defaultAdapterName()` = `agent-<basename(cwd)>`，显式 `--name` 原样使用（`adapterd.src/daemon.ts:238-242`，在 `adapterd.src/main.ts:115` 接线）。`agent-` 前缀只是约定；它不会对照 pi 实例做检查，也没有任何东西阻止 `xfer-adapterd up --name alpha` 与名为 `alpha` 的 pi 会话冲突。`install` 把名字固化进推荐的启动命令（`adapterd.src/main.ts:350-355`），所以一次主机安装也是一个固定名字。

### 1.3 名字编码了什么 —— 以及没编码什么

这个名字同时是：(a) 本地 socket 文件词干、(b) 元数据文件词干、(c) adapterd Inbox 词干、(d) mesh actor key，以及 (e) agent 撰写的每份 Handoff prompt 里写入的"回信地址"（`commands.ts:466`；`commands.ts:684`）。一个字符串，五种角色，没有任何一层能和另一层不一致 —— 这正是同名冲突（§2）无法通过把"名字"和任何东西比较来上报的原因。

---

## 2. 编码：名字 → 文件名，名字 → actor key

### 2.1 本地 socket / 元数据 / Inbox

```
encodeAgentName(name) = encodeURIComponent(name)          utils.ts:13-15
decodeAgentName(s)    = decodeURIComponent(s), fallback s  utils.ts:17-23
endpointForName(name) = <xferDir>/<encode>.sock          utils.ts:25-27
metadataForName(name) = <xferDir>/<encode>.json          utils.ts:29-31
inboxPathForName(name)= <xferDir>/<encode>.inbox.jsonl   adapterd.src/inbox.ts:25-27
```

值得记录的性质：

- 该映射**在字符串上是单射**（percent-encoding 本身就是），所以两个不同的名字不会塌缩到同一个文件 —— `a b` 与 `a%20b` 不同（`a%20b` 编码为 `a%2520b`）。
- 该映射**对 `/` 有损**：`encodeURIComponent("/")` 是 `%2F`，所以包含 `/` 的名字是一个合法的单文件词干。`.`/`..` 也没有约束：`encodeURIComponent("..")` 就是 `..`，于是 `--xfer ..` 把 socket 命名为 `<xferDir>/...sock`（作为文件名无害，但 `endpointForName` 中的任何东西都不会拒绝它 —— 唯一的结构性防线是路径是 `join` 出来的，所以编码后的名字永远不可能包含字面分隔符）。
- **`decodeAgentName` 在列目录时被应用**（`utils.ts:114-116`、`targets.ts:51-53`、`gc.ts:74-86`），而在解析元数据时**不**应用：`targets.ts:52` 解码 socket 词干，然后读 `<同一词干>.json`（`targets.ts:53`）—— 没有再编码的往返，这是有意为之（`targets.ts:37-41`）。唯一跳过解码的地方是 `broker-main.ts:259` 的 `pushXferNotify`，它把线上传来的名字重新编码 —— 一致，因为线上携带的是解码后的名字。
- socket 文件名里出现畸形的 percent 序列时退化为原始词干（`utils.ts:19-22`）而不是抛错；因此 `gc` 和 `listPeers` 不会因为外来文件名而失败。

### 2.2 Mesh actor key

`XFER_INSTANCE_ACTOR = "xfer-instance"`（`mesh-config.ts:29`），每个 Node 一个 actor，key = `[name]`（`mesh-engine.ts:269-272` `client.getOrCreate(XFER_INSTANCE_ACTOR, [name], …)`）。key 的序列化与 engine 镜像一致（`mesh-config.ts:405-417`），反向在把 `/actors` 行映射回名字时使用（`mesh-engine.ts:488-496`，`deserializeMeshKey` 在 `mesh-config.ts:419-439`）。

- `serializeMeshKey` 把 `\` 转义为 `\\`、`/` 转义为 `\/`，并把空段映射为 `\0`（`mesh-config.ts:410-417`）；`deserializeMeshKey` 做逆操作。
- **只有 `deserialized[0]` 被用作 Node 名字**（`mesh-engine.ts:491`）：一个多段 key 会在每个列表里被静默截断为第一段，而 `queueSend` 寻址 `[target]` —— 单段 key（`mesh-engine.ts:303`）。engine 上任何写入两段 key 的东西都会以一个无法送达它的名字出现。
- 空名字端到端可表示：`deserializeMeshKey` 对 `""`/`"/"` 返回 `[]`（`mesh-config.ts:420`），随后 `toMeshNodeInfo` 报出 `name: ""`（`mesh-engine.ts:491`）。本仓库没有产生者会发出它；也没有任何东西拒绝它。

### 2.3 三方对应

`<name>.sock` ⇄ `<name>.json` ⇄ `actor(xfer-instance, [name])` 在一台主机上成立，只因三者都在同一时刻派生自同一个字符串。这里**没有**对账，也没有任何代码把 mesh actor key 与本地 socket 名字相互比较：

- pi：`/xfer mesh up` 以 `state.identity.name` 加入（`commands.ts:358`），与 `controller.start()` 绑定 socket 用的是同一个字符串（`controller.ts:96-97`）。单个进程无法自我分裂。
- Adapter Daemon：`--name`（或其 `agent-<dir>` 默认值）同时成为 socket 词干*和* mesh key（`adapterd.src/daemon.ts:66-69, 173-182`）。同样无法自内部分裂。
- 跨主机时，这个关系只是拼写：本机的 `alpha` socket 与另一台机器的 `alpha` actor 共享一个字符串，仅此而已。`xfer_to` 和 `xfer_mesh_to` 是针对两个不同命名空间的两个独立工具（`index.ts:71-76`、`index.ts:157-167`），而 agent 能得到的"这个名字对某个传输是错的"的唯一线索，就是尝试本身的报错文本。

---

## 3. 同名冲突：检测到什么、检测不到什么

### 3.1 Mesh：能检测，但有一个已记录的残留窗口

`MeshNode.up()` 在创建**之前**读取 engine 列表，且只在对方 `Running` 时拒绝（`mesh.ts:163-173`）：

```
conflict = existing.find(node => node.name === name)         mesh.ts:163
conflict?.status === "Running"  → throw (points at the other host)   mesh.ts:164-172
conflict (other statuses)       → assertPoolMatch() then adopt      mesh.ts:173
```

- 规则及其理由见 ADR 0016（`docs/adr/0016-actor-adoption.md:36-48`）：非 `Running` 的 actor 被收养（绝不销毁），`Running` 被拒绝，因为同一 key 会把这个进程的流量静默路由到另一台主机。
- **收养是名字接管，不是身份核验。** `up()` 从不问那个沉睡的 actor *是谁*；它重新解析同一个 actor 并复用其持久状态 —— 包括 `description`（`docs/adr/0016-actor-adoption.md:40-43`）。下一个调用 `up("alpha")` 的人继承 `alpha` 自我声明的能力说明。这是名字解析的性质，不是 ADR 的缺陷，但它是唯一一处*名字*在互不相关的主机之间传递能力信息的地方。
- 残留窗口被记录为一个毛边，而非 bug：一个刚崩溃的 actor 可能仍保留 `connectable_ts`，因此在 engine 察觉 Runner 消失之前一直读作 `Running`，于是拒绝可能恰在崩溃后成为误报；收养按决策不加重试循环（`docs/adr/0016-actor-adoption.md:28-32`）。
- **`Running` 是唯一的冲突信号；可达性不被参考。** 创建前检查只读 actor 记录，所以一个 `Running` 但其 pool 里没有活 Runner 的 actor 仍然阻断收养 —— 拒绝本身是对的（别的进程可能持有该 key），但消息（"already Running on another host"）可能指向一台当前什么都收不到的主机。反过来的情形正是 Delivery verdict 存在的理由：`no_envoys` 读的是 `Idle` 而非 `Running`（`mesh-engine.ts:127-134`），所以一个没有 Runner 的 actor 是*可收养的*而不是被拒绝的。一个 `Running` 但位于本主机配置之外的其他 pool 的 actor 会在 `assertPoolMatch` 之前就被 `Running` 分支拒绝（`mesh.ts:164-173`）—— pool 不匹配因此永远不会被提及。
- 管理控制台可以在确认框之后销毁**任何**列出的 Node 的 actor，包括在另一台主机上 `Running` 的那个（`admin-main.ts:437-448, 793-831`）。它在销毁前把 actor id 与列表重新核对（`admin-main.ts:821-824`），这关闭了渲染与销毁之间的竞态，但没有覆盖"别人的 Node"的情形。

### 3.2 本地 socket：**完全不检测**

这是本文件中最大的缺口，而且它是有意缺席，而不是某一处的疏忽：

- `controller.start()` 在绑定前 unlink 任何已存在的 `<name>.sock` 和 `<name>.json`（`controller.ts:98-100`）：以同名启动的第二个 pi 会话从第一个那里**抢走**名字，后者继续运行，但 socket 已被 unlink。发往该名字的 Handoff 落到新来者头上；输家什么都收不到，也无人告知。
- `controller.rename()` 对新名字做同样的事（`controller.ts:138-141`）。
- `startAdapterd()` 在监听前 unlink `endpoint` 和 `metadataPath`（`adapterd.src/daemon.ts:75-78`）—— 以某个活 pi 会话的名字启动的 adapterd 同样抢走它，反之亦然。
- *输家*一侧的失败模式是静默的：它的 `net.Server` 仍在监听一个已 unlink 的 inode，因此它的 `listenServer` 错误处理（`server.ts:56-63`）永不触发；它的元数据轮询（`state.ts:56-61`）持续重写一个已不再是该名字现行文件的文件。
- 检测只存在于*下游*，即 `/xfer gc` 对死进程遗留物的启发式（`gc.ts:20-32`，`planGc` 在 `gc.ts:82-143`）：pid 已死 → 回收，`ECONNREFUSED` → 回收，任何含糊的 → 保留。`gc` 看不到一个名字下的两个活进程，因为被抢的名字至多留下一个 `.sock` 文件。
- `/xfer list`（`commands.ts:184-193`）枚举 socket 文件；一个名字下的两个进程塌缩成一行。

### 3.3 本地 vs mesh：同一输入，相反行为

| 输入 | Mesh（`MeshNode.up`） | 本地（`controller.start` / `startAdapterd`） |
|---|---|---|
| 无此名字 | 创建 | 创建 |
| 同名，对方 idle/离线 | 收养（`mesh.ts:173`） | **抢走**（`controller.ts:98-100`） |
| 同名，对方存活 | 拒绝（`mesh.ts:164-172`） | **抢走，静默** |

ADR 0013 的"先检查、再占用、宁可拒绝也不自动改名"（`docs/adr/0013-xfer-mesh-rivetkit-transport.md:10`，由 `:26` 细化）只对 Mesh 实现。本地传输在 `docs/adr/` 里没有任何等价决策记录；unlink-before-bind 写得好像过时 socket 是唯一可能的占用者（`controller.ts:98`）。

---

## 4. 身份真实性 —— 本地 socket（新内容；前一份笔记未覆盖）

### 4.1 本地 peer 实际证明了什么

线上协议是 `AF_UNIX` 上的 JSON-lines（`server.ts:12-46`）：唯一被接受的帧是 `{type: "xfer-notify", msg_id: string, …}`（`server.ts:35-39`），以 `{type:"ack", msg_id}` 应答（`server.ts:40`）。入站 `from` 字段服务端**根本不读** —— `delivery.deliver(msg as XferNotifyMessage)`（`server.ts:37`）把帧原样放行，`controller.deliverInbound` 把 `msg.from` 直接渲染进 prompt（`controller.ts:36, 42-45, 46`），mesh 路径给同一字符串加 `· mesh` 标注（`controller.ts:33, 58`）。

于是本地 Handoff 声称的发送者就是连接进程写进帧里的任何东西：

- `xfer_to` 发送 `from: state.identity.name` —— 真实（`index.ts:118-124`）。
- `broker-main.ts` 发送 `from: FROM_WEB_PICKER`（`broker-main.ts:402-408`），接收会话对这一确切字符串做特判，引导 agent 不要回信（`controller.ts:48-58, 61-77`）。**该字符串可被伪造**：任何本地进程连接 `<name>.sock` 并写入 `{"from":"web-picker"}` 就能得到浏览器待遇；反过来，若这个常量哪天变了，真正的 broker 就会失去它。帧与发送 socket 之间没有通道绑定，因为接收方从不查看 peer 的凭据。

### 4.2 有什么（弱）绑定

- **文件系统权限**：`<xferDir>` 是 `0700`，socket 是 `chmod 0600`（`controller.ts:94-95`；`server.ts:66`；`adapterd.src/daemon.ts:226`）—— 于是*用户账户*是信任单位。同一用户下运行的任何进程都可以冒充任何人发送。
- **元数据里的 `pid`**：`<name>.json` 携带 `pid` 和 `startedAt`（`state.ts:33-41`；`adapterd.src/daemon.ts:92-107`）。它在三处被用作存活性的代理 —— `hasLivePeer()` 门控 `xfer_to` 在 prompt 中的出现（`index.ts:51-59`）、`peerRows()` 给本地 peer 标 online/zombie（`admin-main.ts:106-119`）、`planGc()` 决定回收什么（`gc.ts:82-143`）—— 而**从不**用作身份校验。`utils.readPeerMetadata`（`utils.ts:63-79`）读了 `pid`，但没有任何调用方把它与某个发送者比较。
- **`startedAt`**：只写，从不比较。一个名字下的两个进程无法靠它区分。

### 4.3 今天无法判定的事

1. 刚到达的帧是否来自持有 socket 元数据 `pid` 的那个进程。
2. 声称的 `from` 是否对应任何活着的本地 peer。
3. 发送者是 pi 会话、Adapter Daemon，还是 broker —— `broker-main.ts:402` 是唯一设置标记（`FROM_WEB_PICKER`）的产生者，而它是一个字符串，不是通道属性。
4. 出现在 `/xfer list` 里的 peer 是否就是会应答连接的那个进程（抢到名字的进程会代为应答）。

---

## 5. 身份真实性 —— Adapter Daemon（新内容；前一份笔记未覆盖）

Adapter Daemon 不是一种独立的身份类别：它是同一本地 peer 的第二种实现，同样的 socket、同样的元数据 schema 外加两个额外字段、同样缺乏认证。

- 每个 daemon 写入的元数据（`adapterd.src/daemon.ts:82-108`）：`xferName`、`sessionName: "<host> adapter"`、`cwd: process.cwd()`、`model: "adapterd"`、`status: "idle"`（常量）、`pid`、`startedAt`，外加 `kind: "adapterd"`、`host`、`inbox`。
- `kind` 字段是区分 adapterd 行与 pi 行的唯一持久标记，而它是**自我声明且未校验的**：`listTargets()`（`targets.ts:42-54`）读 `sessionName/cwd/status/description` 并**丢弃 `kind`、`host` 和 `inbox`**（它是 `Pick<TargetInfo, "sessionName" | "cwd" | "status" | "description">`，`targets.ts:8-12`）。于是 broker 的 `targets.list`（`broker-main.ts:501-508`）无法向 picker 用户展示目标是什么类型的主机。只有 `skills/xfer` 包装器读 `kind`（`skills/xfer/scripts/xfer:90`），而且只因它重新实现了扫描。
- adapterd 的 `status` 永远是字面字符串 `"idle"`（`adapterd.src/daemon.ts:88`）—— 它不是 busy/idle 的事实，不像 pi 那样由事件驱动的 `state.currentStatus`（`index.ts:206-209`）。
- Inbox 是 daemon 自己的 append-only 记录（`adapterd.src/inbox.ts:11-23`），其 `from` 与其他一切一样来自帧（`adapterd.src/daemon.ts:141-163`）。
- daemon 的存活性只能间接发现：带显式 `--name` 的 `inbox take|list` 在 `<name>.sock` 不存在时拒绝（`adapterd.src/main.ts:306-309`）；不带 `--name` 时它采纳目录中唯一的 `kind: "adapterd"` 元数据，0 个或 >1 个时拒绝（`adapterd.src/main.ts:321-341`）。两者都是文件系统事实，不是进程事实。
- adapterd 用同一个 `MeshNode` 加入 Mesh（`adapterd.src/daemon.ts:168-190`），因此 ADR 0016 的收养/拒绝语义对它完全适用 —— ADR 明说了这一点（`docs/adr/0016-actor-adoption.md:37-38`）。于是 mesh 侧的 `alpha` 与本地侧的 `alpha` 可以是同一个进程（adapterd）、两个进程（adapterd + pi），或一个进程加一个空名 —— 系统中没有任何东西能分辨是哪种。

---

## 6. 可达性：各表面报告什么、不能报告什么

词汇表由 `mesh-status.ts:1-12` 和 `CONTEXT.md` 固定（"Delivery verdict" ≠ "actor status"；"Offline" 永远不是 verdict）。存在两个不同的问题，由不同的代码回答：

- **本地："是否有一个该名字的 socket？"** —— 文件系统事实，从来不是连通性事实。
- **Mesh："actor 是否被列出，其 pool 是否持有活的 Runner？"** —— engine 事实，从来不是投递事实。

### 6.1 `/xfer list`（`commands.ts:184-193` → `listPeers`，`utils.ts:110-125`）

报告：每个 `*.sock` 文件一行，`xferName`、`sessionName`、`cwd`、`model`、`status`、`description` 从 `<name>.json` 合并（`utils.ts:114-123`；渲染在 `commands.ts:186-189` 与 `utils.ts:39-46`）。

**不报告**：是否有东西在监听（不尝试连接 —— `targets.ts:37-42` 对 `listTargets` 陈述了同一规则）、记录的 `pid` 是否存活（`listPeers` 从不调用 `process.kill`；只有 `index.ts:51-59` 和 `admin-main.ts:107-119` 这么做）、元数据是否过时、是否有两个进程共用该名字。一个过时的 `.json` 挨着一个过时的 `.sock` 渲染出来和一个活 peer 一模一样。

### 6.2 `/xfer status`（`commands.ts:648-651`）

只报告本会话自己的监听行：`unix socket: <endpoint> — name "<name>"`，或 `(not initialised)`（`commands.ts:39-44`）。对客户端、积压、accept 状态只字不提。

### 6.3 `/xfer doctor`（`doctor.ts:65-82`）

- `Socket dir` —— 存在且可写（`doctor.ts:117-134`）。
- `Peers` —— `listPeers(myName)` **减去** `planGc` 算出的僵尸集合（`doctor.ts:136-146`）。这是唯一把文件系统扫描与连通性探测结合起来的本地表面（`planGc` 调用 `socketHasListener`，`gc.ts:60-79, 117, 135`），而它仍不证明 socket 背后是谁：`socketHasListener` 有意把 `ECONNREFUSED`/`ENOENT`/`ENOTSOCK` 以外的超时与错误当作"在监听"（`gc.ts:71, 75-76`）。
- `Broker` / `Admin` —— 仅探测（`doctor.ts:148-170`）。
- `Mesh` —— 在 `MESH_PROBE_TIMEOUT_MS` 下 `loadMeshConfig` + `resolveMeshConfig` + `listMeshNodes`（`doctor.ts:172-201`）：engine 的可达性、Node 数量，以及任何列出的 actor 读到 `status === "Idle"` 时的 `warn`（`doctor.ts:187-199`）。注意 `doctor.ts:187` 的 `"Idle"` 是 **actor 生命周期**状态（`mesh-engine.ts:114-134`），不是代码库的 `currentStatus` —— `notes-reason-network-wake.md` §10 标记过的命名冲突仍然存在。`doctor` **不**联查 `/envoys`，因此给不出 Delivery verdict；它的 mesh 行弱于 `/xfer mesh list`。

### 6.4 `/xfer mesh list`（`commands.ts:383-401` → `mesh.state()` → `listMeshState`）

对每个列出的 actor 报告一行，带 **Delivery verdict** `Running | Sleeping | NoRunner | Mismatch | Pending | Crashed | Unknown` 外加 pool 与 reason（`mesh-status.ts:23-31, 71-107`；`deriveMeshNodeState` 在 `mesh-engine.ts:429-441`；`listMeshState` 在 `mesh-engine.ts:450-455`）。

该 verdict 是两次可独立失败的 engine 读取的联查：`GET /actors?name=xfer-instance`（`mesh-engine.ts:475-483`）与 `GET /envoys`（`mesh-engine.ts:461-464`）。**`envoys: null` 意味着"engine 没有应答"**，此时每一行都渲染为 `Unknown`，reason 是"其 pool 的 runner 未知"（`mesh-engine.ts:433`；`mesh-status.ts:72`）。文件明确指出 runner 的缺失不等于 Node 的缺失（`mesh-status.ts:1-12`）。

**不报告**：actor 的 Runner 是否在人类以为的那台*机器*上（pool 名字是自指派的字符串，§6.6）；列出的 Node 是否在本主机的命名空间里（列表按配置做了命名空间限定，`mesh-engine.ts:362-363`）；该 Node 是否是真正的 pi-xfer 实例（actor 类型是唯一的过滤器 —— 从上一份笔记沿用，§8.1）；现在入队的 Handoff 是否真会被消费（队列深度、ack 状态、每条消息的 outcome 都不在列表上）。

### 6.5 `/xfer mesh status`（`commands.ts:402-419` → `meshSelfStatus` + `meshStatusLines`）

报告同一问题的*接收*方 —— "有什么能到达我吗？" —— 为：本会话在线与否、engine endpoint、本主机 pool 是否有活 Runner 及数量、Node 数量，以及没有时的一条 `→ fix` 行（`mesh-status.ts:146-183`）。engine 完全未应答时是另一种形状 `meshUnreachableLines`（`mesh-status.ts:201-207`）。

**不报告**：队列当前是否持有未投递的 Handoff；actor 是否被另一个进程收养；pool 里的 Runner 是否是本进程启动的那个（pool 是 Runner 的集合，不是进程：`mesh-engine.ts:424-426`）。

### 6.6 发送前检查（mesh）—— 存在，且 fail-closed

`preflightMeshSend`（`mesh-engine.ts:563-604`）使"目标是否存在"在入队*之前*可答，且 `MeshNode.send()` 总是运行它（`mesh.ts:248-256`）：

- engine 未在 `PREFLIGHT_TIMEOUT_MS`（6 秒，`mesh-engine.ts:510`）内应答 `/actors` 或 `/envoys` → `MeshPreflightError`，什么都不发，文本如实说明（`mesh-engine.ts:567-581`）；
- 目标不在列表中 → `MeshPreflightError`，指明"never brought up there … or its actor was destroyed"（`mesh-engine.ts:591-598`）；
- `NoRunner` → 阻断（`mesh-engine.ts:518-526`）；`Mismatch` → 仅警告，engine 在下一次发送时放置（`mesh-engine.ts:527-534`）。
- 入队本身仍是三态：`not-delivered`（engine 返回 `guard.actor_ready_timeout`）、`unknown`（我们不再等待 —— 可能仍会到达）、`failed`（`mesh-engine.ts:652-661`）。`unknown` 恰是 preflight 时可达、入队时不可达的情形。

**`MeshNode.send()` 总要支付一次 preflight**，即使 `up()` 已证明该 Node 在线 —— `verified` 参数正是为此存在（`mesh-engine.ts:171-177`），但 `send()` 先调 `preflight` 再 `queueSend(target, message, verified)`（`mesh.ts:249-251`），所以一次普通的会话内发送多花一次 engine 往返。adapterd 的 `mesh send` 有逃生口 `--no-preflight`（`adapterd.src/main.ts:320-338`）。

### 6.7 本地：除 `existsSync` 外没有发送前检查

`xfer_to` → `sendNotify`（`client.ts:9-16`）：`fs.existsSync(endpoint)` 否则 `peer "<target>" not found`；然后以 `CONNECT_TIMEOUT_MS` 5 秒连接（`constants.ts:14`），以 `ACK_TIMEOUT_MS` 5 秒等 ack（`constants.ts:15`）。`/xfer <target> <req>` 在更早一层跑同样的 `existsSync` 门（`commands.ts:664-668`），因此 agent 不会被要求为一个没有 socket 的名字撰写文档。上一份笔记在 mesh 侧标记的区分（"进程在但 socket 不可达" vs "元数据过时"）在这里**只有部分**可用：

| 情形 | 发送者看到什么 |
|---|---|
| socket 文件消失 | `peer "x" not found`（`client.ts:10-13`） |
| socket 文件在，无人监听 | 连接失败 → `ECONNREFUSED` 以原始 socket 错误浮出（`client.ts:84`），最多等 5 秒 |
| socket 在，监听者接受但从不 ack | `ack timeout`（`client.ts:51`） |
| socket 在，监听者 ack | 成功 —— 但 ack 的含义是"`deliver()` 返回了"，不是"agent 读了"（`server.ts:35-40`） |
| 元数据过时，socket 活着 | 与新鲜的无法区分；`listPeers` 合并 `.json` 说的任何内容（`utils.ts:110-125`） |
| socket 活着但*不是*被命名的那个进程 | 无法区分（§3.2） |

最后一行在 mesh 侧完全没有对应物：mesh 的误路由是事后*可检测的*（`onHandoff` 把 `message.to` 与本进程持有的 actor key 比较并以 `onMisroute` 拒绝，`mesh.ts:303-366`），而一次发往抢名进程的本地投递与一次正确的投递无法区分 —— 本地帧里没有可比较的 `to`（`types.ts:17-23`）。

### 6.8 管理控制台

`/control` 展示本地 peer，带由 `pid` 存活性导出的 `online` 标志（`admin-main.ts:107-119, 468-475`），以及带同样 verdict 字形的 mesh Node（`admin-main.ts:430-466`），外加每个 Node 一个 `down` 按钮（§3.1）。它读 `listPeers`（不是 `listTargets`），因此同样丢弃 `kind`、`description`、`model`。

---

## 7. 能力声明（`/xfer desc`）—— "未验证的自我声明"在代码里的确切含义

README 那句话 —— "Unverified self-declaration — routing stays with the consumer"（`README.md:38`）—— 准确且略有低估。精确语义：

### 7.1 存储：两个位置，其中只有一个是 Mesh

- **本地**：`XferState` 上的 `state.description`（`state.ts:11`），非空时作为 `description` 写入 `<name>.json`（`state.ts:33-41`；经 `commands.ts:225-231` 的 `/xfer desc` 设置，随后在 `commands.ts:228` 调 `state.writeMetadata(true)`）。
- **Mesh**：actor 的持久状态，`XferInstanceState.description`（`mesh-engine.ts:18-24`），由 `setDescription` actor action 写入（`mesh-engine.ts:75-78`，接线于 `mesh-engine.ts:230`），由 `getDescription` 读取（`mesh-engine.ts:80-82`，接线于 `mesh-engine.ts:231`）。
- **两者只做机会主义同步**：`/xfer desc` 先写本地，然后若本进程 mesh 在线则推送到 actor（`commands.ts:231-250`）；`/xfer mesh up` 在加入后重推本地值（`commands.ts:364-368`）。在另一台主机上设置的 `desc` 从不被拉回；由另一个进程（收养，§3.1）设置的 actor description 也从不会落入本地 `.json`。
- **`MAX_NODE_DESCRIPTION = 500`**（`mesh-engine.ts:35`），只在 mesh 写路径上强制（`normalizeNodeDescription`，`mesh-engine.ts:58-68`）。**本地**写路径没有上限：`commands.ts:226-228` 存储命令行的整个剩余部分。于是 `/xfer desc` 可能本地成功、随后 mesh 同步以 "description is limited to 500 characters" 失败（`mesh-engine.ts:63`），`commands.ts:241-245` 将其报为 "Saved locally, but mesh sync failed"。

### 7.2 读取路径 —— 三条，覆盖范围不同

| 读取者 | 读什么 | 覆盖到 |
|---|---|---|
| `MeshNode.describe(target)`（`mesh.ts:221-223`） | 目标 actor 上的 `getDescription` action | 仅 mesh；**仓库内无调用者** |
| `createMeshDescriber`（`mesh-describer.ts:25-36`） | 同一 action，5 秒超时（`mesh-describer.ts:19`），退化为 `undefined` | 仅 broker 的 `targets.list`（`broker-main.ts:503-504`） |
| `listTargets`（`targets.ts:42-54`） | 本地 `<name>.json` 的 `description` | 任何本地读取者（admin 丢弃它，§6.8） |

`TargetInfo.description` 被文档规定为"缺失即未知"，从不做空占位（`types.ts:36-46`），且 `listTargetsWithDescriptions` 吞掉 rejecting 的 describer，使列表绝不因一个 describer 而失败（`targets.ts:67-80`，注释在 `targets.ts:36-41`）。注意 `targets.ts:36-41` 的 docstring 描述的是一条"actor 离线 / engine 宕机 / 未配置 mesh"的拒绝路径而实现里捕获了它 —— 一致，但那个*原因*从不抵达消费者：挑选目标的人看不到 description，也看不到解释。

### 7.3 "未验证"与"路由归消费者"，精确地说

- **未验证**：没有任何东西校验这段文本。它是自由字符串，仅在 mesh 路径上限制 500 字符，任何能到达该 actor 的进程（包括外来 `xfer-instance`，§8.2）都能设置它。它不签名、不版本化、不被机器对照任何能力清单检查。
- **路由归消费者**：`index.ts`、`commands.ts`、`mesh.ts`、`mesh-engine.ts` 中没有任何分支依赖 description。`xfer_mesh_to` 要求模型点名目标（`index.ts:164-165`），从不拉取 description 帮忙；`/xfer mesh list` 有意**只渲染名字 + verdict**（`mesh.ts:217-220`："listings stay names-only, so consumers loop this and cache locally"）；控制台根本不显示 description（§6.8）。唯一把 description 变成决定的是 web picker 里的**人类**（`broker-main.ts:501-508`），而 description 在 actor 之外唯一被*持久化*的地方是 skill 包装器的本地缓存（`skills/xfer/scripts/xfer:62-71`，读 `descriptions.json`）—— 一个本仓库从不写入的存储（`descriptions.json` 在 `*.ts` 中无处出现），于是对一台刚装好的主机，"cached locally" 分支永远为空。

### 7.4 声明的可达性

description 与 actor 同在，因此在 **Node 离线时**也可读 —— actor 的状态属于 engine，`MeshNode.up()` 的注释就是这么说的（`mesh.ts:141-145`），且 `getDescription` 用 `client.get`（不 create），所以它可解析沉睡的 actor。description *不能*告诉消费者的是该 Node 当前是否能接收；那是 verdict 的职责（§6.4），两者由不同的代码路径读取（broker：只读 description；CLI：只读 verdict）。**今天没有任何一个表面把两者放在一起展示。**

---

## 8. 凭据 —— 认证在哪里止步

### 8.1 Mesh：一个根凭据，没有 per-peer 身份（沿用，本次复核）

- `MeshConfig.token`（`mesh-config.ts:7-9`），可从字面量、`$ENV_VAR` 或 `!command` 解析（`mesh-config.ts:360-395`），拒绝出现在 URL userinfo 中（`mesh-config.ts:52`，`rejectUrlAuth` 在 `mesh-config.ts:92-119`）。
- token 走每个 engine 平面：REST `Authorization: Bearer`（`mesh-engine.ts:358`），以及经 `setup({ token })` / `createClient(...)`（`mesh-engine.ts:252-260`、`mesh-engine.ts:266`）。ADR 0019 记录了这意味着什么：admin token 是根凭据，它还搭 WebSocket 子协议和 URL 路径段的车（`docs/adr/0019-mesh-transport-security.md:36-40`）。
- **没有 peer 级凭据。** peer 身份 = actor 类型名 + key，无握手（`docs/adr/0019-mesh-transport-security.md:41-43`）。对照今天的树复核：actor 定义只注册 `setDescription`/`getDescription` 和一个队列，别无其他（`mesh-engine.ts:224-266`）；`XferInstanceState` 没有协议版本、没有身份字段（`mesh-engine.ts:18-24`）；发现只按 actor 类型过滤（`mesh-engine.ts:475-483`）。
- 值得记录的一个凭据行为：`if (config.token) headers.Authorization = …`（`mesh-engine.ts:358`）—— 未配置 token 时请求**不带认证**发出而不是本地失败；是否接受由 engine 决定（`docs/guides/mesh-setup.md:44` 注明当前 engine 要求认证，除非 `auth.insecure_allow_unauthenticated: true`）。
- `mesh-guard.ts` *不是*认证层：它只在 `NODE_TEST_CONTEXT` 被设置时拒绝非 loopback endpoint（`mesh-guard.ts:62-64, 86-98`）。

### 8.2 对寻址的后果

因为 token 覆盖整个命名空间而 actor key 就是地址，**持有 token 就足以成为 `bob`**（ADR 0019："A same-namespace actor registering as `xfer-instance` is indistinguishable from a real node"，`docs/adr/0019-mesh-transport-security.md:84-86`）。这是本次调研中没有任何表面能上报的一件事：如果两个 actor 竟然共享一个 key（它们做不到 —— key 唯一性属于 engine），`/xfer mesh list` 会显示两行 `bob`；而唯一的 `bob` 是冒名者时，只显示一行 `bob`。

### 8.3 本地 socket 与 Adapter Daemon：完全没有认证

- `createServer` 接受任何连接和任何格式正确的 `xfer-notify` 帧（`server.ts:12-46`）；在该设计下 `AF_UNIX` 上无法做 peer 凭据查询，也没有尝试。
- 唯一的访问控制是 mode 位：目录 `0700`、socket `0600`（`controller.ts:94-95`、`server.ts:66`、`adapterd.src/daemon.ts:226`）、元数据 `0600`（`state.ts:47-48`）。
- broker 自身的表面按构造是"localhost 信任"：绑定 `127.0.0.1`（`broker-main.ts:102, 879`），其 `auth_failed` 分支明说没有什么可认证的（`broker-main.ts:818-823`）。WebSocket 升级处理器只检查路径和 `Sec-WebSocket-Key` 头，别无其他 —— **没有 `Origin` 检查**（`ws-server.ts:186-204`）。由于 `annotation.submit` 会写一份文档并把一条 `xfer-notify` 推进一个具名目标 socket（`broker-main.ts:399-417`），任何能打开本地 WebSocket 的进程（包括本地浏览器里的网页 —— WebSocket 不需要 CORS 预检）都能以 `web-picker` 身份向任何本地 peer 提交 Handoff。这是本地信任设计，此处作为事实记录，不是缺陷指控。
- adapterd 的 `--on-handoff` 每份 Handoff 派生一条 shell 命令，stdin 给数据，外加三个 `XFER_HANDOFF_*` 环境变量（`adapterd.src/daemon.ts:110-139`）。这些值是发送者自报的字符串；把 `XFER_HANDOFF_FROM` 内插进 shell 行的消费者，内插的是攻击者可控的字符串。

---

## 9. 对上一份笔记（`notes-mesh-peer-identity.md`）的核验

方法：每条承重断言在 `ae1121c` 上重读。该笔记归档于 `f7d5f9f`（2026-10-17）；此后 `mesh-engine.ts`（+502）、`mesh-config.ts`（+369）、`mesh.ts`（+87）都变了，行号移动但结构性结论未变。

| # | 上一份的断言 | 结论 | 今天的证据 |
|---|---|---|---|
| 9.1 | peer 身份是 actor 类型名 + 单段 key；无握手、无凭据 | **沿用** | `mesh-config.ts:29`；`mesh-engine.ts:224-266, 475-496`；ADR 0019:41-43 |
| 9.2 | `XferInstanceState` 只有 `{description}` —— 无协议版本、无身份 | **沿用**，外加一项 | `mesh-engine.ts:18-24`；该笔记早于 `delivered?: string[]`（去重窗口），那是传输状态，不是身份 |
| 9.3 | 发现只过滤一种 actor 类型，因此其他 Rivet actor 种类从不出现 | **沿用** | `mesh-engine.ts:475-483`（`GET /actors?name=xfer-instance`） |
| 9.4 | 发送经 `queueSend` / `sendMeshHandoff`，30 秒超时 | **沿用** | `mesh-engine.ts:300-310`、`mesh-engine.ts:332-349`、`QUEUE_SEND_TIMEOUT_MS` 在 `mesh-engine.ts:188` |
| 9.5 | 缺失/外来的目标过去只能等 30 秒后以 "target may be offline or stuck" 失败 | **本次复核推翻（已修复）** | 那段文本已消失。现在一个 6 秒的发送前检查在入队前区分"无此 Node"/"其 pool 无 Runner"/"engine 未应答"（`mesh-engine.ts:510, 563-604`），入队再按 engine 错误码分诊为 `not-delivered` / `unknown` / `failed`（`mesh-engine.ts:652-661`）。*原本的*底层歧义（超时的入队仍可能送达）被有意保留为 `unknown` |
| 9.6 | `up()` 拒绝 `Running` 的同名 actor、收养其余；`down()` 是唯一的销毁路径 | **沿用** | `mesh.ts:163-173`（`Running` 拒绝）、`mesh.ts:197-215`（仅 `down()` 销毁）、ADR 0016。**发现的例外**：管理控制台也销毁 actor，包括在另一台主机上 `Running` 的（`admin-main.ts:793-831`）—— "`down()` 是唯一销毁路径" 对类成立，对二进制不成立 |
| 9.7 | 发送前探测不得扰动目标的持久状态或队列 | **沿用（作为约束），现已满足** | `getDescription` 是纯读 action（`mesh-engine.ts:80-82`）；`preflightMeshSend` 只做两次 GET（`mesh-engine.ts:461-483`） |
| 9.8 | "未检查：对某个外来 `xfer-instance` actor 的 `getDescription` 探测能否与普通离线目标区分" | **本次复核：仍是未检查项** | 如今按*表面*可区分，按身份不可：actor 探测路径（`getDescription`）完全没有错误分类学并退化为 `undefined`（`mesh-describer.ts:31-35`），而列表路径有 verdict 词汇表和显式的 `Unknown` 表示"engine 未应答"（`mesh-engine.ts:429-441`）。两者都说不出"这不是一个 pi-xfer Node" |
| 9.9 | 没有仓库文档覆盖该信任边界；做决策需要一份 ADR | **本次复核推翻** | `docs/adr/0019-mesh-transport-security.md`（已接受）现已覆盖：peer 身份是类型+key，冒名是**被接受**的风险，仅有部署层面的缓解（ADR 0019:41-43, 84-86） |

旧笔记 §"加固选项" 的三个选项应据此解读：选项 2（发送时探测）现已基本实现为 preflight（§6.6）；选项 1（actor 状态里的协议标记）**未**实现，且 ADR 0019 记录没有后继计划；选项 3（命名空间/token 隔离）仍是部署义务，不是代码。

---

## 10. 今天不可判定的事（能力上限）

1. **"peer 是否名副其实"** —— 任何传输上都不行。本地：帧与 socket 属主之间无绑定（§4）。Mesh：命名空间级 token 之下没有凭据（§8.1）。Adapterd：两者皆承（§5）。
2. **"这个名字是否被一个活进程占用"** —— 本地不探测即不可知，且探测也说不清*哪个*进程应答（§6.7）。`/xfer list` 会欣然把被抢的名字显示一次。
3. **"目标读了吗"** —— 本地 ack 的含义是 `deliver()` 返回（`server.ts:35-40`）；mesh ack 的含义是队列接受，且去重窗口在 `onHandoff` 返回后、agent 尚未做任何事之前就被记录（`mesh-engine.ts:248-249`；`docs/guides/cf-serverless-node.md:81-83`）；`xfer_to` / `xfer_mesh_to` 返回常量 `status: "sent"`（`index.ts:194`、`index.ts:191`）。自 `notes-reason-network-wake.md` §8.3/§9.2 沿用 —— 仍成立。
4. **"能力说明是最新的吗 / 是谁的"** —— description 属于某个 actor key，收养会转移它（§3.1、§7.3）；本地副本与 mesh 副本是两次写入，从不对账（§7.1）。
5. **"此刻谁在这台机器上"** —— `listTargets` 丢弃 `kind`/`host`（`targets.ts:8-12`），所以 picker 用户分不清 pi 会话与 Adapter Daemon；仓库内唯一保留 `kind` 的读取者是 skill 包装器的私有扫描 `skills/xfer/scripts/xfer:85-102`。
6. **"pool 的 Runner 在我以为的那台机器上吗"** —— pool 是一组带自指派名字的 Runner（`mesh-engine.ts:424-426`）；没有任何东西把 pool 名绑到主机身份。
7. **"多段 actor key 的哪一段是 Node"** —— 只有 `[0]`，静默截断（`mesh-engine.ts:491`）。
8. **"是否有一份 Handoff 正滞留在队列中未投递"** —— 任何表面上都没有（§6.4、§6.5）。

---

## 悬而未决的问题（给人类 Node；不带建议）

- Q1. 本地传输在名字冲突时 unlink 活 peer 的 socket（§3.2）。ADR 0013 的"宁可拒绝也不自动改名"是对 Mesh 做的决策。本地行为是从未写下的既定决策，还是未经审视的默认？
- Q2. adapterd 把 `kind`/`host`/`inbox` 写进本地元数据，而 `TargetInfo` 丢弃它们。"传输对消费者不透明"是有意的，还是 `TargetInfo` 仅仅早于 ADR 0015？
- Q3. `README.md:38` 说路由归消费者，`mesh.ts:217-220` 让列表只有名字。但唯一真正消费 description 的地方是 web picker —— 也就是说消费者是浏览器里的人，不是 agent。这是预期的形态吗？
- Q4. 没有表面把 verdict 与 description 放在一起（§7.4）。这个割裂是有意的（CLI = 存活，picker = 能力），还是两条读取路径各自生长的意外？
- Q5. `MeshNode.send()` 总要支付一次 preflight，即使 `up()` 已证明该 Node 在线（§6.6）—— `verified` 接缝是存在的。多出的一次往返是刻意的（目标可能在 `up` 之后消失），还是未实现的优化？
- Q6. `docs/guides/mesh-setup.md:104` 仍把 E2EE 称作"开放候选项"，而 ADR 0019 记录 P1-C 为**已拒绝**，`docs/adr/0019-…:81-83` 说没有计划中的后继。两份文档在应用层加密是否仍在议程上互相矛盾。
- Q7. `skills/xfer/SKILL.md:36` 宣称有"持久的 `descriptions.json` 存储"；本仓库没有任何 `*.ts` 写它（`skills/xfer/scripts/xfer:62-71` 读它）。是包装器跑在实现前面，还是该存储本就打算由仓库之外的什么来写？
- Q8. broker 的 WebSocket 不做 `Origin` 检查地接受本机任何页面（`ws-server.ts:186-204`），并能让页面以 `web-picker` 身份提交 Handoff（§8.3）。localhost 信任是声明的模型（`broker-main.ts:818-823`）；其对*跨源*本地页面的后果没有在任何地方写明。
- Q9. 收养转移前任持有者的 `description`（§3.1）。ADR 0016 说持久状态的保留是刻意的。被转移的是能力声明（而非队列/去重状态），这在意图之内吗？
- Q10. 除去 `descriptions.json` 不谈，`/xfer desc` 只在 Mesh 路径上限制 500 字符（§7.1），于是过长的本地 description 注定 mesh 同步失败。应该让本地写路径共享该上限，还是让 mesh 路径接受本地所持的一切？

---

## 核对与存疑 (verification notes, and where this file is uncertain)

**仅凭读源码核对过的内容。** 上文每条 `file.ts:line` 都在 `ae1121c` 读取过。除为归档日期跑的 `git log`/`git diff` 外没有运行任何测试；没有触碰 engine、`~/.pi/xfer`、任何在线部署，`XFER_ALLOW_REMOTE` 未被设置。

**有意不作断言（不确定）：**

- **`decodeURIComponent` 的过宽输入。** `utils.ts:114-116` 在进入列表的路上解码*每个* `.sock` 词干，任何碰巧是合法 percent-encoding 的字符串都会被解码 —— 一个名为 `%41.sock` 的外来文件会列为 peer `A`。而 `endpointForName("A")` 随后指向 `A.sock`，不是 `%41.sock`。我没有测试 engine 或任何其他工具是否创建此类名字；这里记录为对代码的解读，不是观测到的故障。
- **actor `Running` 与另一个 pool 中的 Runner。** `assertPoolMatch`（`mesh.ts:279-290`）只在 actor *不*是 `Running` 时到达（`mesh.ts:164-173`），因为 `Running` 分支先抛。我没有探测处于外来 pool 的 `Running` actor 是否是真实状态；顺序解读来自源码。
- **key 序列化的等价性。** `serializeMeshKey`/`deserializeMeshKey`（`mesh-config.ts:410-439`）被文档说明为对"mesh key 使用的形状（非空字符串段）"与 engine 镜像（`mesh-config.ts:405-409`）；空名或两段 key 的情形可表示但从未在此演练，因此那些形状的往返未经验证，不是断言已坏。
- **engine 列表语义。** "处于另一个 *pool* 的 actor 仍出现在本主机 `/actors` 列表中"这一断言来自 `mesh-engine.ts:265-266` 的注释（"`get`/list stay un-pooled"）和 `mesh-engine.ts:475-483`（不发送 pool 过滤器）—— 不是本次会话的 engine 观测。`docs/guides/cf-serverless-node.md:102-103` 针对无服务器 pool 专门限定这一点（无服务器 pool"不持有自己的 runner"），那是另一个轴（pool 种类，不是列表成员资格）。
- 上一份笔记的 §9.8 问题（"`getDescription` 探测能否区分外来 actor 与离线 actor"）**仍未验证**：外来 `xfer-instance` actor 从 `getDescription` 返回什么没有被观测，也无法在 hermetic 条件下观测。§9.8 *确实*记录的是较弱的一层、代码级的事实：两个*表面*不同 —— 探测路径没有错误分类学（`mesh-describer.ts:31-35`），列表路径有显式的 `Unknown`（`mesh-engine.ts:433`）—— 而两者都没有"非 pi-xfer Node"的 verdict。

**本文件依赖文档而非代码之处：** §8.1 的子协议/URL token 载体是 ADR 0019 的测量（`docs/adr/0019-mesh-transport-security.md:36-40`）与 `notes-mesh-transport-encryption.md` §2-3；`mesh-engine.ts` 只展示了 `Authorization` 头（`mesh-engine.ts:358`）和 `setup({ token })` 的透传（`mesh-engine.ts:249`）。token 旅程的其余部分在 rivetkit 内部，不在本仓库源码中。
