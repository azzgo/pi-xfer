> 中文版 · 英文原文：[web-picker.md](web-picker.md)

# Xfer Web Picker 用户脚本 — 安装、验证、排错

`web-picker.user.js` 是一个 Tampermonkey 用户脚本，它为 xfer broker 提供页面这一侧：

- **Pick / note 内核** — 悬停拾取元素、批量备注、逐条删除（原先由 CDP 注入的流程，
  为 broker 重写过）。
- **Shift 分组（v1.5）** — ⇧Enter / ⇧click 把元素聚进一个待定分组（琥珀色虚线标记）；
  Enter 为整个分组打开一条共享备注。成员以互相链接的 record 形式进入 handoff
  （可选的 `group` id 字段）。
- **发送流程** — 一段 prompt（可选——留空则发送一条默认指令，按每条 pick 的备注作答，
  或解释该元素的渲染方式）加上拾取到的标注，作为 xfer handoff 投递进一个本地 pi 会话
  （`annotation.submit` → `ack`）。在 prompt 文本域里按 ⌘/Ctrl+Enter 即可发送。
- **复制 handoff prompt（v1.10）** — 发送按钮是一个分裂按钮组（发送 → + ▾）。▾ 下拉里的
  **复制 handoff prompt** 要求 broker 渲染出一次提交将会投递的那份 handoff 文档原文
  （`annotation.compose` → `ack{prompt}`——只渲染，不写入、不投递），并复制到剪贴板。
  那些有 bash 但没有 xfer 的非 pi 编码 agent 由此也能收到同一份 handoff：粘贴该 prompt，
  它们就能自己调用 `node daemon/broker-main.ts page-tool <target> <op>` 做后续页面查询。
- **页面工具（v1.6 + v1.12 写操作）** — agent 的工具调用以
  `page.request{tool:{op, params}}` 帧到达，并在本页上执行：
  `page.info` · `dom.query` · `dom.html` · `console.logs` · `network.log` ·
  `framework.inspect` · `page.wait`（固定的读操作——没有自由 eval，没有人机模态框），
  外加受门控的写操作 `dom.click` · `dom.setValue`（见下文的自动连接/授权）。结果以
  `page.response{ok:true, text:<JSON>}` 返回。console 与 network 抓取是常开的环形缓冲
  （200 条），因此 agent 也能看到请求之前的历史。v1.2 的询问模态框已移除。
- **自动连接（v1.12）** — 第一次**手动**连接成功即授权该 origin
  （GM storage 中的 `wp.autoLink.<origin>`）：此后刷新（HMR 整页刷新、broker 重启）都会
  以指数退避（1s/4s/16s→60s）静默重连。按 origin 撤销：设置里的复选框「本域名自动连接
  broker」或 GM 菜单「撤销本页自动连接」；手动断开只会暂停当前这次页面加载的自动连接。
  另一个按 origin 的复选框「允许 agent 操作本页」（`wp.writeOps.<origin>`）开启写操作——
  `dom.click`（pointer/mouse 序列 + native click）、`dom.setValue`
  （native setter + input/change，让 React 受控输入框得以更新）以及读操作 `page.wait`。
  未获授权的写操作返回 `page.response{ok:false, error:"denied_op: ..."}`。
- **源码与构建** — 自 v1.12 起，用户脚本由 `web-picker.src/` 构建（esbuild，在本目录运行
  `npm run build`）；构建出的 `web-picker.user.js` 已入库，因此 raw URL 安装流程不变。
  协议常量来自共享的 `wire.ts`（`broker-main.ts` 也导入它），两端因此不会漂移。hello 的
  tab id 按页面持久化（sessionStorage 中的 `pi.wp.tabId`），broker 因而能在刷新之后把后续
  的 `page.request` 路由回**同一个** tab。路由永远显式（ADR-0022）：page-tool 要求
  `--tab <tabId>`（HTTP body 里的 `tabId`），未命中时返回 `missing_tab`（未给 tabId）/
  `tab_unreachable`（页面已关闭）——原先的"取最近 tab"猜测与广播兜底都已移除。agent 遇到
  `tab_unreachable` 要停下来问人；只有连接层的 `timeout` 可以重试。

线协议：**v0，localhost 信任（无 token）**。每一帧都带 `{v, type}`；每个请求恰好得到一条
回复。用户脚本所有帧都由单一的 `PROTOCOL` 段落构造——broker 镜像它（下面的帧形状与
`mock-broker.mjs`、`.pi/wayfinder/prototypes/` 一致）。

| 方向 | 帧 | 形状 |
|-----------|-------|-------|
| page → broker | `annotation.submit` | `{id, page, picks, prompt, target:{namespace:"local", name}}` → `ack{result:{handoff_id, doc, routedTabId?}}`（ADR-0022：broker 从 `hello` 登记的那条连接取 tabId，写进 doc 的 `## Page` 节与每条 page-tool 命令里的 `--tab`，ack 的 `routedTabId` 是同一事实的副本） |
| page → broker | `annotation.compose` | `{id, page, picks, prompt, target?}` → `ack{result:{prompt:<handoff doc>}}`（只渲染，不落盘不投递） |
| page → broker | `annotation.stage` | `{id, pick, page:{tabId, origin, url, title, ts}}` → `ack{result:{id, count}}`（入袋；broker 分配 id，不去重） |
| page → broker | `bag.list` | `{id}` → `ack{result:{items:[StagedMarker]}}`（全量快照，重连重建的唯一来源） |
| page → broker | `bag.submit` | `{id, prompt, target:{name}}` → `ack{result:{handoff_id, doc}}`；渲染为每页一节的 handoff（节头带 tabId/url/title），发送即清袋，失败保袋 |
| page → broker | `bag.unstage` | `{id, entryId}` → `ack{result:{id, count}}`（按 broker 分配的条目 id 删除一条暂存；id 不存在 → `invalid_payload`，抽屉据此重新拉取而不是静默成功） |
| page → broker | `targets.list` | `{id}` |
| broker → page | `page.request` | `{id, handoff_id, from, tool:{op, params?}, timeoutMs}` — ADR-0022：定向到显式 tabId，无广播 |
| page → broker | `page.response` | `{id, ok:true, text}` / `{id, ok:false, error}` |

---

## Record 模式（v1.13）

Pick 标记记录*哪里*；Record 模式记录*何时*。用户亲手复现问题；picker 把时间线与现场数据
录下来，作为一次提交。没有重放步骤——人的操作**本身**就是证据（理由：ADR 0007）。

- **用法** — ⇧⌥R（或 fab 菜单「开始/停止录制」/ `__PI_WP_API__.record()`）进入 record 模式
  并立刻开始（横幅就是起始标记）。底部横幅显示 ● REC · N events 以及停止/丢弃按钮；随意
  操作页面，然后停止 → 这条 record 以摘要卡的形式出现在备注面板顶部（逐事件预览，删除
  即丢弃），并随下一次发送 / 复制 handoff prompt 一起带走。record 是一次性的：发送成功后
  清空，新一次录制会替换掉尚未发送的那条。
- **捕获的事件**（监听器只在录制期间挂载）：`click`（选择器 + 文本片段）、`input`
  （字段最终值——防抖到 1s 静默或 `change`；`type=password` 掩为 `***`，其他字段不做启发式
  掩码——面板摘要才是审阅点）、SPA 路由变化（500ms 轮询 href——pushState 不触发任何事件）、
  `submit`、裸 `Enter`（不在 textarea 内）。事件带 `seq` + 毫秒偏移 `t`，当某条已提交的 pick
  共享同一选择器时，还带一个指向它的 `ref`（从 1 起算）。硬上限：50 个事件。
- **线上** — 没有新帧：`annotation.submit`/`.compose` 增加一个可选的 `record` 字段
  `{id, start, end, url0, url1, events[], console[], net[]}`。broker 校验结构最低要求
  （`broker-main.ts` 里的 `parseRecord`），并把它渲染为 handoff 文档的 "Operation timeline"
  一节（每段现场切片最多 40 行）。
- **SSE / 长轮询（v1.13 netRing 改动）** — netRing 原先只记录*已完成*的请求，因此永不结束的
  响应是看不见的。现在改为 pending 优先：请求一开始就推入一条 record，完成时原地修改
  （按开始时间排序）。响应为 `content-type: text/event-stream` 的 fetch 保持
  `pending:true, kind:'sse'`；`EventSource` 包装器额外加一个 `msgs` 计数器；长轮询 XHR 在
  send 时推入、在 loadend 时完成。时间线上显示一个简短标记
  （`GET /api/events → pending sse msgs=37`）；agent 通过
  `page-tool network.log '{"urlFilter":…}'` 深挖——正是那条 pending 记录让这种反向查询成为
  可能。
- **SSE 内容捕获（v1.14）** — 元数据不再是 agent 能拿到的全部：`content-type:
  text/event-stream` 的 fetch 响应会被克隆（页面保留原始响应不受影响），克隆由后台的 SSE
  帧解析器消费；`EventSource` 包装器记录 `message` 事件以及具名事件（`event: <type>`，
  经由包装过的 `addEventListener`）。存储有界且只限 SSE：每条流保留最近 50 个事件，每个事件
  尾部截到 8KB，全局预算 1MB——预算超限时淘汰最老的流缓冲，某条流的缓冲随其 netRing 记录
  一起消亡。被淘汰的流，其记录仍然可见，只是带 `sse:{captured:false}`（元数据
  `msgs`/`chars` 仍在），这样 agent 能区分"内容被丢弃"与"没有这条流"。用新的读操作反查内容：
  `page-tool network.sse '{"urlFilter":"/api/chat","lastN":3,"eventLast":20,"maxCharsPerEvent":2000}'`
  → `{total, returned, streams:[{stream, url, method, status, pending, msgs,
  chars, captured, events:[{ts, type, id?, data}]}]}`（events 是最近的 `eventLast` 条，data
  按尾部切到 `maxCharsPerEvent`，以便回复落在 broker 帧预算之内）。SSE 的 `network.log`
  条目带相匹配的 `sse:{stream, msgs, chars, captured}` 摘要作为索引。
- **挺过整页加载** — record 状态在每个事件之后镜像到 `sessionStorage`（`pi.wp.rec`），并在
  重新注入时恢复（与 `pi.wp.tabId` 同一先例）；URL 变化在同一条 record 里变成一个 `nav`
  事件。跨 origin 的跳转会刻意打断 record（sessionStorage 按 origin 隔离）——不支持；若将来
  确有需要，得在 broker 侧做暂存。

---

## 安装（Tampermonkey）

**最简**——在启用了 Tampermonkey 的浏览器里打开 raw URL；`.user.js` 后缀会自动触发安装提示：

<https://raw.githubusercontent.com/azzgo/pi-xfer/main/dist/web-picker.user.js>

手动：打开 Tampermonkey → Dashboard → **+**（Create a new script），把编辑器内容替换为
**`web-picker.user.js` 的完整内容**，保存（Ctrl/Cmd+S）。然后刷新任意页面——右下角附近会
出现一个圆形 fab。

> 从 "PI Web Picker" 改名（v1.5）：改名 = Tampermonkey 里的一个新脚本条目。装好之后删掉
> 旧的那个；它的 GM storage（broker URL、上一个 target）会重置一次，因为 storage 按脚本
> 隔离。

| 快捷键 | 动作 |
|----------|--------|
| ⇧⌥P | 进入 / 退出 pick 模式 |
| ⇧⌥L | 切换备注面板（发送框在里面） |
| ⇧⌥R | 开始 / 停止 record 模式（时序标记序列，见上文 Record 模式） |
| ⇧Enter / ⇧click（pick 模式） | 把高亮的元素加入 / 移出待定分组 |
| Enter（有待定分组时） | 打开分组备注卡 → 所有成员共用一条备注 |
| Enter（无待定分组时） | 钉住高亮元素写单条备注，同以前 |
| ⌘/Ctrl+Enter（prompt 文本域） | 发送这一批（等同点发送 →） |

fab 左上角的点是 broker 状态：灰 = 未连接，琥珀 = 连接中，绿 = 已连接。右下角的角标是
marker 数量（picks + record）；什么都没收集时它以灰暗的 `0` 保持可见。

fab 本身只有一个动作：点击它开始拾取。另外两个动作在悬停时向上扇出——**标注面板**
打开备注面板（即使没有任何 marker 可标注，这也是抵达 targets / 反查 / network / logs
的路径），**录制操作**开始/停止录制。角标只是读数，不再是第二个点击热区：图标与角标
共用一个视觉主体时，点击结果全靠猜。

备注面板的表头里也有同样的两个入口（**⌖ 拾取** 与 **● 录制**），所以不碰 fab 也能
拾取和录制。

> 脚本只与 `127.0.0.1` 通信（`@connect` 头）。在你显式连接 broker 并点击发送之前，什么都
> 不会被发出去。

## 启动 broker

```bash
/xfer broker start     # daemon on ws://127.0.0.1:4719/ws — survives session exit
/xfer broker status    # alive? how many tabs are connected
/xfer broker logs      # recent daemon output
/xfer broker stop      # pid ladder (SIGTERM → ~2s → SIGKILL)
```

状态位于 `~/.pi/xfer/broker.{pid,json}` + `broker.log`。在已经运行时（pid 存活）再启动会
报告 "already running" 并以 0 退出。若配置的端口被一个*外来*程序占用（没有存活的 broker
pid），daemon 会告警并回退到临时端口——`/xfer broker start` 会 toast 出实际端口，它总会
记录在 `broker.json` 里。

在 `/xfer broker` 命令组接好之前，可以直接运行 daemon：
`node pi/agent/extensions/xfer/daemon/broker-main.ts`。page-tool 调用走同一个 daemon
（HTTP `/page-tool` + CLI `page-tool`），因此不需要单独的 oracle。

## 验证

1. **连接** — 灰点 → 连接设置… → 确认 `ws://127.0.0.1:4719` →
   保存并连接。点变绿（"broker 已连接"）。
2. **拾取** — ⇧⌥P，悬停元素，⇧⌥L 打开面板，编辑 / 删除备注。
3. **发送** — 拾取几个元素，写一段 prompt（或留空：agent 会收到一条默认指令，按每条 pick
   的备注作答 / 解释它的渲染），在下拉里选择目标会话（⟳ 刷新），发送 →
   toast 显示 `handoff_id`，目标会话收到一份 `📨 [Xfer from web-picker]` handoff。
4. **page-tool 往返** — tab 已连接的情况下，从任意 shell：
   `node pi/agent/extensions/xfer/daemon/broker-main.ts page-tool <session-name> page.info`
   → broker 打印结果 JSON（`url`、`title`、`viewport`、……）。试试
   `dom.query '{"selector":"a","maxCount":3}'` 或 `console.logs`。broker 日志显示
   `[page.request r… ] → tab <id>: …` 和 `[page.response r…] ok=true`。
   超时（默认 30s，`--timeout-ms` 可覆盖）或没有已连接的 tab 会以 1 退出，错误打到 stderr。

## 站点兼容性（v1.15）

真实站点以两种特定方式与用户脚本对抗；两种都已处理，且 picker 会告诉你看到的是哪一种。

**Trusted Types 站点**（YouTube 会下发 `require-trusted-types-for 'script'`）。
每一次标记写入都经过 `web-picker.src/tt.js`：当该 API 存在时创建一个 `trustedTypes`
策略，不存在时回退为普通赋值。过去会把整个用户脚本吞掉的站点，现在能得到完整 UI。如果注入
终究还是失败，会在 shadow DOM 之外渲染一条带错误文本的小提示——一个沉默的用户脚本是最难
报告的那种失败。

**CSP `connect-src` 站点**（npmjs.com 只允许 `'self'`，因此
`ws://127.0.0.1:4719` 被拒）。这种拒绝很古怪：WebSocket 构造正常，触发 `onerror`，而且
**从不**关闭。现在连接会在等待连接期间监听 `securitypolicyviolation`，当被阻止的 URL 正是
我们的 broker socket 时，进入终态 **blocked**：

- 状态点和状态行变红，并用大白话说明（"blocked by site policy"），这与"broker 没在运行"
  不是一回事；
- 自动重连停止——在那个页面上重试不可能成功——toast 会解释原因，而不是静默失败；
- **发送按钮被隐藏**，取而代之的是一个简短的 **⧉ Copy** 按钮：它在 tab 里本地组装同一份
  文档（picks、录下的时间线、console/network 切片）并复制，不与 broker 往返。

这个判定**无需任何点击**就能探测到：加载时，一个从未连接过的 origin 会做一次静默的探测
socket。如果策略拒绝它，blocked 角标立刻出现，并且该判定按 origin 记住
（`wp.policyBlocked.<origin>`）——之后访问该站点根本不开 socket。连接成功会清除这条记忆。
探测刻意保持静默：角标就是消息，而一个普通的 "broker down" 失败会让页面保持原样
（无 toast、无退避——那些只留给已授权的 origin）。

那份离线文档刻意**不含 "Follow-up channel" 一节**——反向查询通道需要 broker 连接，而这
正是本页所禁止的。保存复制出来的文本，在 agent 会话里打开它。

这里没有任何东西试图绕过站点策略；picker 只是适应它。

## 排错

| 症状 | 原因 / 修复 |
|---------|-------------|
| 连接失败，点保持灰色 | broker 没在运行——`/xfer broker start`；或连接设置里的 URL 不对。健康检查：`curl http://127.0.0.1:<port>/status`（端口以 `/xfer broker status` 为准，fallback 后不是 4719）。 |
| 端口 4719 被另一个程序占用 | daemon 回退到临时端口并告警：启动 toast / `/xfer broker status` / `broker.json` 显示真实端口——在连接设置里填那个 URL（失败 toast 会链接到那里）。要稳定地址，要么释放端口，要么一次性地钉死一个自定义端口：`/xfer broker start --port N`（0 = 临时端口）。`broker.pid` 里的 `pid` 存活意味着那是我们自己的 broker → "already running"，不回退——决定权在 pid（不是端口），因此无论你传什么端口，存活的 broker 都不会被重复启动。 |
| 下拉显示（无活跃 local session） | 没有在监听的会话：targets 来自 `~/.pi/xfer/*.sock`。启动一个加载了 xfer 的 pi 会话（它的 `.sock` 会出现），然后 ⟳。完全没连接 → 下拉显示（未连接 broker）。 |
| https 页面连不上 | 在 Chromium 里，发往 `127.0.0.1` 的 ws 属 loopback，不受混合内容阻止，且 Tampermonkey 的 `@connect 127.0.0.1` 覆盖了该请求——https 页面通常可用。若某页仍然拒绝，在非 https 页面试一下，或复核 URL 是否恰好是 `ws://127.0.0.1:4719`（不是 `wss://`，不是 `http://`）。 |
| broker 重启后点保持灰色 | 连接过一次的 origin 会自动重连（v1.12 自动连接，指数退避）。新 origin 仍需手动：点状态行 / Tampermonkey 菜单 → 连接，或重新保存连接设置——成功一次即授权该 origin。若始终不重连，自动连接可能被撤销了：检查连接设置 → 「本域名自动连接 broker」。 |
| SPA 跳转 / HMR 之后 fab 消失 | 页面清掉了脚本的 shadow host。v1.8 会自动重新挂载（mutation observer）；Tampermonkey 菜单 → **重新注入 trigger** 或 `__PI_WP_API__.reinject()` 可手动强制恢复。 |

> page-tool 的处理器有 JSON 安全上限（深度、字符串与数组上限），因此单次调用永远不会撞破
> 1MB 的 broker 帧预算。`framework.inspect` 只在通过连接设置复选框或
> `__PI_WP_API__.setFrameworkProps(true)` 选择加入时才附带组件的 props/state。写操作
> （`dom.click` / `dom.setValue`）还会拒绝 picker 自身 overlay host 内的目标，且只在
> origin 具备页面写授权（连接设置 → 「允许 agent 操作本页」）时才执行。

---

## 暂存袋（跨页暂存）

备注面板发送的是*本页*的 picks。暂存袋是第二条显式路径：broker 连接在线时，▾ →
「暂存到 broker」把本页的 picks 移入一个由 broker 持有的袋，带完整 Provenance
（tabId、origin、url、title、时间——词汇表：**Bag**、**Staged marker**、**Provenance**）。
在若干页面上都做一遍，然后从其中任意一页发送整袋。

- **入口与抽屉** — 面板头部只在已连接时显示「暂存袋 ▾」（袋是 broker 状态；离线入口会是
  谎言）。抽屉按页分组列出袋内容（url+title 手风琴，每个页头带自己的 tabId），并带自己的
  prompt 文本域、target 下拉和发送整袋按钮。备注面板本身不受影响——两条路径在视觉上保持
  分离。发送整袋成功后抽屉自动收起，和主面板发送成功后收起一致：面板是用来"看"的，
  不是一个 handoff 完成之后还留在那儿的地方。
- **生命周期** — 只有一个默认袋，仅在内存中（broker 重启即丢；每条都带 provenance，
  重新暂存很便宜）。`bag.submit` 会消费这个袋：成功即清空，失败则保留（重试提交）。不去重：
  同一个元素暂存两次会产生两条条目。
- **文档形状** — `bag.submit` 渲染出一份 handoff，每页一个 `## Page:` 节
  （url/origin/tabId 页头，该页的 picks 在里面），外加一段 Routing 说明，告诉 agent 每节
  各取 `--tab`，并在遇到 `tab_unreachable` 时停下来问人（skills/xfer 里有完整规则）。
- **删除** — 每行的「删除」用 broker 分配的条目 id 发 `bag.unstage`；袋是 broker 状态，
  只删本地会让抽屉与 `bag.submit` 实际发送的内容不一致。备注仍在暂存时刻固定（broker 所有），
  复制 prompt 也永远只覆盖本页的 picks，从不覆盖袋。
