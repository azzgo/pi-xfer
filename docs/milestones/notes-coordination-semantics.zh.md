> 中文版 · 英文原文：[notes-coordination-semantics.md](notes-coordination-semantics.md)

# 协调语义 — 研究输入(handoff / Board / broker 各面上的多发送方协调)

出处:应用户要求对 `main` 做的只读代码走读,2026-10-18。除本文件外未改动任何文件;
未运行任何测试;未启动任何 mesh 引擎;未接触任何线上部署,`XFER_ALLOW_REMOTE` 未设置。
论断均标注 `file.ts:line`(`file.ts:LINE`);仅从测试文件推断出的行为标 **[from tests]**。
刻意不包含产品判断 —— 开放问题集中列在文末。

范围:本仓对*多于一封消息、多于一个发送方、多于一次同时进行的交换*实际是怎么处理的。
原语有 `handoff`(单向文档,携带一个 Kind)、`Board` / `Card` / `Entry`(机器本地的异步协作)、
`Broker`(web-picker 的反向通道),以及 `Node` / `peer` 发现。所有术语均按 `CONTEXT.md`
的定义使用。

---

## 1. Handoff 线上格式:没有 thread、没有 reply 引用、没有因果链

### 1.1 两种线上格式

| 传输 | 帧 | 字段 | 出处 |
|---|---|---|---|
| local(peer socket) | `XferNotifyMessage` | `type:"xfer-notify"`, `msg_id`, `from`, `file`, `summary` | `types.ts:18-24` |
| mesh(Node actor 队列) | `MeshHandoffMessage` | `id`, `from`, `to?`, `summary`, `document` | `mesh-engine.ts:8-15` |

两者都是扁平的。mesh 格式把文档内联携带,local 格式携带指向 tmp 文档的文件系统路径
(`index.ts:102-108`、`mesh.ts:308-309`)。线上传输之后不保留任何其他信息。

local 的 ack 是 `{type:"ack", msg_id}`(`server.ts:44-47`,在 `client.ts:94-97` 匹配),
broker 的 unix-socket push 使用同样的 ack 语法(`broker-main.ts:290-296`)。这个 ack 是以
`msg_id` 匹配的*传输层*回执,不是应用层回复。

### 1.2 Kind 是唯一的关系性字段,而且它是声明,不是链接

`kind: task | notification` 是文档头里的一行,由 `readHandoffKind` 解析
(`handoff-kind.ts:53-62` → `parseHandoffKind` `handoff-kind.ts:44-50`),由发送工具从一个
必填参数打上(`stampHandoffKind` `handoff-kind.ts:72-80`)。它说明*这次 handoff 想要什么*。
它不说明它回答的是**哪一个** handoff。

对全树 `grep` `thread|reply_to|replyTo|parent_id|parentId|in_reply|causal` 返回
**零个实现点** —— 只有散文:
- `CONTEXT.md:86` —— "the reverse message is itself a Handoff — never a 'reply' or 'receipt'";
  `CONTEXT.md:57` —— "_Avoid_: thread, log"(针对 Conversation)。
- `docs/milestones/notes-reason-network-wake.md:31,106` —— 一份外部设计草图
  (`Envelope{id, from, to, reply_to, thread, …}`),明确框定为 *对齐但命名须用 CONTEXT.md 词汇*。
  不是代码,不是 ADR。
- `mesh-config.ts:267` —— "thread" 指 OS 线程,无关。

所以:**不存在 thread / 会话分组 / reply 引用 / 因果链,也没有为其中任何一个保留字段。**
唯一一处回复"指回去"的地方是文档正文里人类可读的散文:`/xfer <target>` 和
`/xfer mesh <target>` 的请求模板要求 agent 在文档里写一行 `**Return address**: from=<name>`
(`commands.ts:460`、`commands.ts:679`),web-picker 文档则渲染一个 `from:` / `handoff_id:`
页脚(`handoff-doc.ts:249-250`)。这些是要求模型产出的 markdown;没有任何代码把它们解析回去。

### 1.3 接收方被告知了什么顺序信息

`controller.deliverInbound` 构造信封文本并把 `msg_id` 原样传递:
`**Handoff**: \`${msg.msg_id}\` — kind: ${kind}`(`controller.ts:38`、`controller.ts:47-53`)。
id 只被展示;不与任何东西比较。没有接收侧的 id 索引,所以 agent 无法问"这是不是对我发出去
那个的回答"。

---

## 2. `msgId()` — 近似唯一,不单调,不可排序,不含因果

```ts
export function msgId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
```

`utils.ts:9-11`。精确陈述其性质:

- **构造上并非全局唯一**:`Math.random()` 取 6 个 base36 字符(约 2.2 × 10⁹ 空间)。碰撞不太
  可能但无防护 —— 没有注册表、没有计数器、没有时钟序列。
- **不单调**:`Date.now()` 不单调(NTP 跳变、跨机器时钟偏斜),而随机部分主导同一毫秒内的
  顺序。
- **只能按前缀排序,且只在一台机器的时钟内**:对整个 id 做字典序排序也会比较随机后缀;同一
  毫秒内铸出的两个 id 顺序是任意的。
- **不含因果**:id 不编码 `from`、目标、父节点。两个 peer 并发铸 id,产出的 id 无法排出先后。

调用点,全部铸造新 id,除一个有意的恢复探测外不重用 id:`index.ts:102`(`xfer_to`)、
`mesh.ts:242`(`MeshNode.send` 的默认参数,`xfer_mesh_to` 经 `index.ts:172` 使用)、
`adapterd.src/main.ts:186`(local `send`)、`adapterd.src/main.ts:263`(`mesh send`)。同一 id
只在调用方有意传回时才被重用 —— `MeshNode.send(target, params, id)` 的 doc 注释说明:以原 id
重发正是接收方去重窗口覆盖的恢复探测(`mesh.ts:230-241`)。

broker 用**另一套方案**铸 id:`m<base36 Date.now()><base36 counter>`
(`broker-main.ts:255-258`,`nextMsgId`),请求 id 用 `r` 前缀(`broker-main.ts:260-263`)。
所以 id 空间有两套语法;没有任何程序化手段区分它们,也没有字段说明某个 id 出自哪套语法。

推论:**因果性无法从 id 推断;它必须是一个显式字段**,而这样的字段不存在(§1.2)。

---

## 3. 多个发送方进入同一个接收方

### 3.1 local socket 路径(pi 扩展)

`server.ts:11-50` —— `<name>.sock` 上的一个 `net.Server`。每个连接:一个字符串缓冲,按 `\n`
切分 JSON-lines,对每个 `type === "xfer-notify"` 且 `msg_id` 为字符串的解析出的帧:
`delivery.deliver(msg)` **同步执行,然后** `socket.write(ack)`(`server.ts:40-47`)。

`XferController.deliverInbound`(`controller.ts:25-72`)从头到尾同步:读 sender-cwd 戳
(`controller.ts:31`)、读 Kind(`controller.ts:37`)、拼一个字符串并调用
`pi.sendMessage(...)`(`controller.ts:66-70`)。send 之前没有任何 await。

所以对 local 传输:
- **没有覆盖**:每个 `xfer-notify` 都成为独立的 `sendMessage` 调用,标
  `customType: "xfer-inbound"`(`controller.ts:67`)。没有任何东西按发送方或 id 做 key,
  所以不会碰撞。
- **排队**:xfer 里没有。顺序就是事件循环给的:同一连接上的帧按到达顺序处理;*不同*连接上的
  帧(发送方 A 和 B 是不同的 `net.createConnection` 客户端,`client.ts:17`)按 socket 调度
  交错。没有序列号,所以接收方 transcript 里的顺序无法证明就是写入方顺序。
- **渲染顺序由 pi 决定,不由 xfer 决定**(见 §3.2)。

### 3.2 忙 vs 闲:`steer` vs `followUp` —— 唯一一个有意的排序决定

```ts
}, isIdle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" });
```

`controller.ts:70-72`,其中 `isIdle = state.isRuntimeIdle()`(`controller.ts:27`)委托给
`runtimeContext.isIdle()`,在没有 context 或调用抛错时默认为 idle(`state.ts:73-77`)。

- **闲的接收方**:`followUp` + `triggerTurn` —— 消息启动一个 turn 并作为 follow-up 排队。
- **忙的接收方**:`steer` —— 消息被注入正在运行的 turn。
- **没有 context**(controller 已构造但 session 从未启动):按 idle 处理,所以走 `followUp`。
  这个分支里 `state.identity` 也是 null,但 `deliverInbound` 从不读 identity,所以投递仍然
  进行 **[from code]**;`controller.test.ts:31-34` 测的正是这个:一个只有 `sendMessage`、
  没有 `runtimeContext` 的假 `pi`。

`deliverAs: "steer"` 对第二个并发消息的语义 —— 是打断、在 turn 中途追加,还是等待 —— 属于
pi 的 runtime,不属于本仓。**无法从这棵树验证**(§7)。

### 3.3 mesh 路径(Node actor 队列)

actor 的 `run` 循环是对 `c.queue.iter()` 的单个 `for await`(`mesh-engine.ts:236-249`):
每条消息先查重,再 `onHandoff(...)`,再 `recordMeshDelivery(...)`,按顺序,一次一条。
`onHandoff` 同步写文档并调用与 `deliverInbound` 等价的逻辑(`mesh.ts:304-323`;controller
在 `index.ts:38-41` 接线)。所以 **mesh 传输按 Node 串行化,且不覆盖**:队列顺序即投递顺序,
A 和 B 都会到达。

注意两条传输落进同一个 `deliverInbound`,因此走同样的 `steer`/`followUp` 分支 —— mesh
handoff 与 local handoff 在下游不可区分,只差 `· mesh` 标签
(`controller.ts:29`、`controller.ts:55`)。

### 3.4 文档文件系统是一个共享的、按名字做 key 的命名空间

mesh 投递和 local `xfer_to` 投递都写到
`path.join(os.tmpdir(), \`pi-xfer-${id}.md\`)` —— `mesh.ts:308`、`index.ts:103`,以及 broker
的提交路径 `broker-main.ts:363`。文件名只是 `msg_id`(或 broker 自己的 id)的函数。没有按
发送方或按传输的目录。直接从代码得出的两个推论:

- **跨机器**碰撞(主机 A 的 `msgId` 等于主机 B 的)会让两个节点在*各自*机器上写同一路径
  —— 无害 —— 但在同一台机器上,一个 local 发送方与一个 mesh peer 铸出相同 id 就会碰撞。
  概率即 §2 的 `Math.random()` 碰撞。
- **恢复探测**有意重用 id,因此会覆盖之前的文档文件(`mesh.ts:308` 是无条件的
  `writeFileSync`)。这是有意的去重/探测设计;它也意味着如果探测携带不同字节,旧文档内容
  就没了。
- `/tmp` 清理**没有实现**(`grep tmpdir` 只看到写入方:`index.ts:103`、`mesh.ts:308`、
  `broker-main.ts:363`、`adapterd.src/main.ts:215`;`gc.ts` 和 Admin 都不删它们)。

### 3.5 Adapter Daemon(非 pi 的 Agent Host)—— 另一种多发送方答案

`adapterd.src/daemon.ts:141-160`:每个投递的帧在**任何其他事发生之前**被追加为一行 JSONL,
写入 `<name>.inbox.jsonl`(`appendInbox`、`adapterd.src/inbox.ts:38-42`),然后带着 stdin
上的记录 spawn `--on-handoff`。消费用 `takeInbox`(`adapterd.src/inbox.ts:76-91`),它先把
文件改名挪走,这样并发追加会落进一个新文件并存活 **[from tests]**
(`adapterd.test.ts:132-140`)。

所以 adapterd **确实**排队,持久性勉强(文件就是队列;`CONTEXT.md:44-48` 坚持它是
"take-to-read … 背后没有持久存储")。与 pi 扩展相比有两个值得记录的差异:
- 先追加后处理意味着 ack 之后、`take` 之前崩溃会把记录留在 inbox 里;pi 扩展完全没有这样的
  记录 —— 它唯一的痕迹是 tmp 文档和 `mesh.log`。
- 多个 `--on-handoff` 子进程可以同时在飞(`adapterd.src/daemon.ts:107-138` 维护一个
  `handoffChildren` 集合),所以 adapterd 的并发模型是每个 handoff 一个进程,而不是进程内注入。

---

## 4. Board:它支持什么、谁在用它、它能承载什么样的会话形态

### 4.1 形态

`board.ts`:
- 位置:`~/.pi/xfer/board/`(`board.ts:7`),按 ADR 机器本地
  (`docs/adr/0014-board-stays-machine-local.md`)。
- `Card` = front matter `id/title/created_by/created_at`(`board.ts:12-17`,序列化于
  `board.ts:86-88`)+ Entry 正文。内存中的 `Card` 另有 `file`、`body`、`entries`
  (`board.ts:20-25`)。
- `Entry` = `id`、`type`、`author`、`at`、`text`(`board.ts:27-34`);渲染为
  `### e-XXXX · type · author · timestamp`(`board.ts:92-95`)。
- id:`c-0001`、`e-0001`,扫描现存 id 取最大值分配(`board.ts:63-70`、`board.ts:72-79`)。
  没有 uuid,没有计数器文件 —— 分配读目录。
- `create`(`board.ts:179-192`)、`append`(`board.ts:194-200`)、`del`(`board.ts:202-207`)、
  `clean`(`board.ts:209-215`)。**没有 Entry 的 read-modify-delete,没有编辑,没有 status
  字段。** append-only 之所以成立,是因为没有别的写入方。
- 每次写都是 `serialize(card, appendEntryText(...))` 的整文件 `fs.writeFileSync`
  (`board.ts:198`)。没有锁、没有原子改名、没有合并:**两个进程并发 append 同一张卡会产生
  last-writer-wins,丢掉先到的 entry**。`board.ts` 完全没有跨进程防护;`grep` 在文件里找不到
  任何 `flock`/`O_EXCL`/lockfile。
- `Marker` **不是 Board 概念** —— `CONTEXT.md:69-71` 把它定义在 Web Picker 之下,Board 代码
  从不提它(`grep -i marker` 在 `*.ts` 上只命中 web-picker / handoff-doc)。

### 4.2 谁在用它 —— 完整调用点清单

| 调用点 | 做什么 | 能写吗 |
|---|---|---|
| `commands.ts:79` | `registerBoard(pi, {boardDir, getAuthor: identity.name})` —— 唯一注册点 | — |
| `board.ts:244-283` | `agent_end` 拦截器:取 pending write,从最后一条 assistant 消息解析 ` ```board-entry ` 块,然后 `create`/`append` | **能** |
| `commands.ts:495-607` | `/xfer board list\|new\|read\|write\|del\|clean\|open` | 经 `setPending`(`commands.ts:513`、`commands.ts:558`) |
| `admin-main.ts:480-494,585,637` | Admin 控制台:`new Board(boardDir).list()`、`.read()` —— 只渲染 | **不能**(设计上只读,`admin-main.ts:614`) |
| `admin-main.ts:764-773` | `/board/open` → `board.read(card)` → `openPath(file, true)`(打开编辑器) | 页面内不写 |

这就是全部表面。**没有 `pi.registerTool`** —— agent 无法未经提示触碰一张 Card;按 ADR 0009,
人是唯一协调者(`docs/adr/0009-xfer-board-command-driven.md:20-27`)。

### 4.3 Pending-write 状态是单个槽

`Board.pending: PendingWrite | null`(`board.ts:150-151`、`board.ts:158-168`)恰好持有一个
pending write。`/xfer board write` 设置它(`commands.ts:558`)并注入 prompt;`agent_end`
处理器第一时间消费并清空它(`board.ts:248-251`)。因此:

- **两个重叠的 board write 不排队。** 第二个 `setPending` 覆盖第一个;第一个 prompt 的回复
  随后落在第二张卡上。代码对第一个 `agent_end` 触发前 `/xfer board write` 被发出两次毫无
  防护 —— 覆盖是静默的,只有落败的意图消失(两个 `setPending` 处都没有警告)。
- 意定回复之前任何其他 turn 的 `agent_end` 都会消费 pending 状态并以"reply had no
  ```board-entry block"中止(`board.ts:259-263`),写入未生效。单槽 + 首个 `agent_end` 胜出,
  就是并发故事的全部。

### 4.4 它能承载什么样的会话形态

今天支持的:一张 Card 内的有序 append-only Conversation(`CONTEXT.md:54-57`),*只*由某个
agent session 里人类调用的命令写入。读者 = 人类把它注入给谁(`commands.ts:531-542`,注入时
带 "Do not take action yet — wait for their instruction")。

代码里缺席的:
- **没有通知**:卡变了不通知任何参与者。没有文件 watcher,没有 socket 事件;`admin-main.ts`
  按请求重读,`commands.ts` 按命令重读。
- **没有按参与者的 read 游标 / ack**:没有东西记录谁读过哪个 Entry。
- **没有"这条 Entry 回答谁"的归属**:只有自由文本正文;Entry id 是按卡的,所以一个 Entry id
  无法跨卡寻址。
- **没有跨机器路径**(ADR 0014:用目录同步,零代码)。Entry id 是本地目录上的 `max+1`
  (`board.ts:72-79`),这恰恰是并发双向文件同步下会碰撞的 id 方案。
- **没有生命周期**:`CONTEXT.md:52-53` —— "no lifecycle statuses, cleanup happens only when
  the human explicitly runs del / clean"。Entry `type` 是一个"不驱动任何逻辑"的标签
  (`CONTEXT.md:54-56`、`board.ts:27-34`)。

所以今天的 Board 承载的是*人类策展的"agent 说过什么"的记录*,不是 agent 之间自行推进的会话。
每一跳的两端都是人(ADR 0009 把它记录为有意的:"latency floor of one human round-trip per
hop",`docs/adr/0009-xfer-board-command-driven.md:59-62`)。

---

## 5. 重复投递与去重:mesh 有,local 没有,adapterd 只是结构上有

### 5.1 Mesh —— 持久 actor 状态里的 3 条滑动窗口

- `XferInstanceState.delivered?: string[]` —— "Handoff ids already delivered, oldest first.
  Absent on actors that never received one."(`mesh-engine.ts:18-23`)。
- `DELIVERED_WINDOW_SIZE = 3`(`mesh-engine.ts:32`),doc 注释说明*为什么*是三:预期中的
  重投递都落在"窗口活动边缘的紧邻处"(`mesh-engine.ts:25-31`)。
- `isDuplicateMeshHandoff` = `delivered.includes(id)`(`mesh-engine.ts:90-92`);
  `recordMeshDelivery` 对 id 去重、追加,然后 `slice(-3)`(`mesh-engine.ts:95-99`)。
- 接线:actor run 循环命中即丢弃并写一条 `mesh duplicate` 日志记录(`mesh-engine.ts:236-245`
  → `meshDuplicateLogLine` `mesh-engine.ts:102-108`);未命中路径先投递*再*记录
  (`mesh-engine.ts:247-248`),即**窗口内每个 id 至多一次,总体至少一次** —— `onHandoff` 与
  `recordMeshDelivery` 之间崩溃,重投递时会重复投递。
- 窗口有界,所以在又落了 3 个 handoff 之后同一 id 的真实重发**不会**被去重,会再次投递。
  这是文档化的边界,不是 bug(`mesh-engine.ts:25-31`)。
- 一个测试断言窗口的边缘行为,以及投递失败不被记录(`mesh-dedupe.test.ts:110-113`、
  `mesh-dedupe.test.ts:172`)**[from tests]**。

### 5.2 local socket —— 完全没有去重

`server.ts:40-47` 对每个带字符串 `msg_id` 的 `xfer-notify` 都投递。没有 recent-id 集合,没有
文件检查,没有比较。`grep isDuplicateMeshHandoff` 显示它是 mesh 专属(外加 Cloudflare 示例,
`examples/cf-serverless-node/src/mesh-actor.ts:44-61,84`)。发送方以同一 `msg_id` 重试 local
`xfer_to` **会**被投递两次;local 路径上没有任何东西能分辨。`XferState`(`state.ts:8-20`)
只保留 identity/status —— 没有消息记账。

### 5.3 adapterd —— 永远追加,不做 id 去重

`appendInbox` 在每次投递时无条件运行(`adapterd.src/daemon.ts:141-156`)。mesh 侧去重仍然
生效(`adapterd.src/daemon.ts:169-177` 里的 `MeshNode` 包装同一个 `createRivetEngine`),
所以窗口内的 mesh 重投递到不了 inbox。**local** 投递每次都进 inbox,包括字节级相同的重试。
`InboxRecord.id` 就是 `msg_id`(`adapterd.src/inbox.ts:9-21`),所以去重*可以*由消费者做,
但树里没有任何代码做。

### 5.4 broker 自己的 last-write-wins 映射

两个只在**目标名字**上做 key 的模块级 map:
`latestHandoffByTarget: Map<string,string>` 和 `latestTabIdByTarget: Map<string,string>`
(`broker-main.ts:529`、`broker-main.ts:538`),每次成功的 `annotation.submit` 都写入
(`broker-main.ts:395`、`broker-main.ts:400`)。`routePageTool` 读它们决定下一次 `page.request`
去*哪个 tab*,并打上 `handoff_id: latestHandoffByTarget.get(target) ?? "demo"`
(`broker-main.ts:596-612`)。

- 两个浏览器 tab 向同一目标提交:**第二个**提交赢得两个 map;第一个 tab 不再收到 follow-up,
  直到它再次提交(只有被记录的 tab *消失*时才退化为广播 —— `broker-main.ts:601-603`)。
- 所以反向通道只携带*最近一次* handoff 的 id;没有按 tab 或按 handoff 的路由。未文档化的
  推论:定向的 `page.request` 回答的是"当前这个 tab",与这次工具调用本想对应哪个 handoff
  无关。
- 这些 map 是模块作用域的 `const`,**不被 `startBroker` 重置**(不同于 `broker-main.ts:721`
  的 `tabConns`),所以同一进程里重启 broker(测试,或内嵌重启)会继承上一实例的条目。

---

## 6. 交换收尾语义:约定,而非强制

### 6.1 断言了什么

`kind: task` "comes back with exactly one conclusion (done, blocked, or needing input)"
(`index.ts:7` 附近的工具描述 `index.ts:88`,以及 `xfer_mesh_to` 的 `index.ts:146`);接收
信封把它重复为一句 prompt(`controller.ts:57-59`):"Send exactly one reverse handoff … A
bare acknowledgement is not a conclusion."。`notification` 得到相反的一句 ——
"Do not reply"(`controller.ts:60`)。

### 6.2 强制了什么

**什么都没有。** 枚举每一种可能闭合一个 task 的机制:

| 机制 | 存在吗 | 出处 |
|---|---|---|
| Reply 等待 / 阻塞 | 无 —— "returns immediately … (no reply wait)" | `index.ts:88`、`index.ts:146`,ADR 0018 "no reply wait" `docs/adr/0018-handoff-kind-sender-declares.md` |
| local socket 在 ack 后关闭 | 有 —— 匹配 ack 后 `sock.end()` | `client.ts:44-48` |
| mesh send 在入队时 resolve | 有 —— `handle.send(...)`,然后 return | `mesh-engine.ts:255-262` |
| 发送方的 pending-exchange 记录 | **无** —— 任何地方都没有按 handoff id 做 key 的表(发送方侧除 identity/status 外没有 `state`,`state.ts:8-20`) | — |
| "恰好一次"被强制(第 2 次回复被拒) | **无** —— 第二次反向 handoff 是全新的 handoff;接收侧去重只丢*同一 id* | §5.1 |
| 超时 / 陈旧 task 检测 | **无** —— `doctor.ts` 有五项检查(socket dir、peers、broker、admin、mesh),没有一项看过未决 handoff | `doctor.ts:67-73`、`doctor.ts:184-206` |
| 无回复时通知发送方 | **无** | — |
| 入站回读 Kind 以*闭合*链条 | Kind 被读并展示(`controller.ts:37`),从不与任何未决事物比较 | — |

ADR 0018 有意把这陈述为一个后果:"A Task's reply is an obligation on the receiver, not a
delivery guarantee … a sender must not block on it"
(`docs/adr/0018-handoff-kind-sender-declares.md:14-16`)。所以 `kind: task` 是**由一行
markdown 加一句 prompt 承载的社会契约**。

关于*声明* Kind,有两个相邻事实值得单独记录:
- pi 工具要求 `kind` 作为工具参数并打戳(`index.ts:92-96`、`index.ts:112` /
  `index.ts:151-153`、`index.ts:168`),模型无法省略它。
- adapterd CLI 要求 `--kind`,缺失即失败(`adapterd.src/main.ts:178-182`、
  `adapterd.src/main.ts:245-249`)。
- **broker 的 picker 文档硬编码 task**:`renderHandoffDoc` 总是产出
  `formatHandoffKind("task")`(`handoff-doc.ts:226`),注释为 "A submit is a Task"。所以
  web-picker 提交总是要输出,而 `controller.deliverInbound` 也把它路由到 web-picker 分支,
  该分支既不输出 task 也不输出 notification 的义务文本(`controller.ts:54-58` 只走 agent
  分支)—— 它指向 page-tool CLI(`controller.ts:55-65`)。Kind 行在文档里,但不在那个
  发送方的信封里。
- 一个既无 kind 行**又**头不可读的文档读作 `notification`(`handoff-kind.ts:27`、
  `handoff-kind.ts:53-62`),即一个旧的或损坏的 handoff 会静默地什么都不要求。

### 6.3 今天一次交换会死在哪里

- 发送方发出 task;接收方从不接。Mesh:唯一信号是入队 verdict(`not-delivered` / `unknown` /
  `failed`,`mesh-engine.ts:610-700`),它关于*队列*,不关于人或模型。Local:`sendNotify` 在
  传输 ack 上 resolve(`client.ts:44-48`)。
- 发送方 session 在回复到达前结束。没有东西持有那个 id;回复的入站信封只是来自另一边的全新
  消息,没有任何标记说明它回答了什么。
- 接收方在 task 中途死掉。Mesh 重投递会重复这项工作(窗口为 3,§5.1);local 不会
  (socket 写已经 ack)。

---

## 7. 没有检查过的内容

- **pi 的 `deliverAs: "steer"` 语义** —— steer 消息是立即到达正在运行的 turn,还是被追加到
  pending user messages,还是可能被丢弃,定义在 `@earendil-works/pi-coding-agent` 里,不在
  这里。`controller.test.ts` 完全没有断言 option 对象(它的假 `pi` 只记录
  `{customType, content}`,`controller.test.ts:20-34`),所以连 steer vs followUp 的*选择*
  都未被测试;只有内容被测了。
- **RivetKit 对多生产者队列的 queue-actor 排序与重投递保证**。代码假设按 Node FIFO,以及
  活动边缘附近的重投递(`mesh-engine.ts:25-31`),但该假设写在注释里,树里没有任何地方
  对引擎做断言。
- **第一个 tab 的 page-tool 调用在飞时,第二个 tab 的 `annotation.submit` 是否会让第一个
  tab 饿死** —— 可以从 `latestTabIdByTarget` 是 last-write-wins 推出(§5.4),但没有测试
  覆盖。
- **Board 单一 `pending` 槽在真实并发下的行为** —— 没有测试覆盖两个重叠的 `/xfer board
  write`;覆盖是从代码读出来的。
- **跨机器 `/tmp` id 碰撞**及其实际速率 —— 仅受 §2 约束。
- **`examples/cf-serverless-node` actor 的去重**被读过但未被运行(按 `AGENTS.md` 它没有
  本地替身)。
- 什么都没运行:没有 `npm test`,没有引擎,没有 admin 页面,没有 tmux smoke。

---

## 核对与存疑

核对方式：逐条对着工作树重读被引用的行；没有运行任何测试或引擎，因此除标注 **[from tests]**
的两处外，所有行为断言都来自源码阅读。

已在阅读中自查并修正的几处：
- `index.ts` 的工具描述行号是 `:88` / `:146`（`xfer_to` / `xfer_mesh_to`），`kind` 参数分别是
  `:92-96` / `:151-153`；先前草记成 156 一类的旧行号，已按当前树更正。
- `mesh.ts` 的 `onHandoff` 行号 `:304-323`、doc 写入 `:308`，与 `notes-mesh-peer-identity.md`
  verification notes 里"行号已漂移 ~20-30 行"的提醒一致，本文全部用当前树行号。
- `state.ts` 的 `setStatus` / `isRuntimeIdle` 是 `:68` / `:73`（不是文件头注释所说的一处集中
  区块），`grep -n` 复核过。

存疑（未能在本仓内解决，列为开放问题，不构成建议）：
1. **`steer` 与 `followUp` 的真实排序语义**在 pi runtime 内。本仓只选择了其中一支
   （`controller.ts:70-72`），并把它当作"忙时插话、闲时排队"。多发送方并发时，这是整个
   协调语义最关键的一处外部依赖，而本仓既无测试断言选择本身，也无法断言其效果。
2. **Board 的单一 `pending` 槽**（`board.ts:150-151`）与 ADR 0009 的"two-phase writes … nothing
   half-written"（`docs/adr/0009-xfer-board-command-driven.md:42-47`）之间存在张力：ADR 保证的是
   单个写入不会写半张卡，代码确实做到了；但两次重叠的 write 会让第一次的意图**静默消失**，
   这不是"half-written"，却也不是任何一处文档描述过的状态。是否算 ADR 覆盖范围之外，留给人判断。
3. **`CONTEXT.md` 说 Inbox「There is no durable storage behind it」（`:44-48`），而 adapterd 的
   Inbox 恰恰是一个 append-only JSONL 文件**（`adapterd.src/inbox.ts:8-21,38-42`），只有在 `take`
   之前才是持久的。用词本身不矛盾（语义是 take-to-read），但"no durable storage"这句话在
   阅读代码时容易被读成"不落盘"。
4. **handoff id 的两套语法**（`utils.ts:9-11` vs `broker-main.ts:255-258`）共存，且 `handoff_id`
   字段在 web-picker 文档里写作 `demo` 兜底（`broker-main.ts:610`）。是否有下游会把这个兜底当成
   真实 id，本仓内看不出来。
5. **`latestHandoffByTarget` / `latestTabIdByTarget` 不被 `startBroker` 重置**
   （`broker-main.ts:529,538` vs `broker-main.ts:721` 的 `tabConns = new Map()`）。这是否会影响
   开发中的 broker 重启与测试隔离，未验证。
6. **`xfer_to` 一次发送 = 一个 `/tmp` 文件，无人回收**。是否有意为之（`/tmp` 依赖系统清理），
   文档未说；`gc.ts` 明确只管 socket 与 metadata。

Related: `docs/adr/0009-xfer-board-command-driven.md`、`docs/adr/0014-board-stays-machine-local.md`、
`docs/adr/0018-handoff-kind-sender-declares.md`、`CONTEXT.md`（Handoff / Notification / Task /
Board / Card / Entry / Conversation / Inbox 条目）。
