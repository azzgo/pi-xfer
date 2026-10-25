> 中文版 · 英文原文：[phase2-candidates.md](phase2-candidates.md)

# Milestone 2 — 候选清单草案(brainstorm,尚未批准)

来源:milestone-1 各 session 的 retro(agentsview)、用户输入,以及来自 `refine` 的跨项目
retro handoff(2026-10-13)。

## P0-A — Web Picker 站点兼容性:静默失败
## P0-A — Web Picker 站点兼容性:静默失败

- 决定(2026-10-13):**先调查** —— 为两种失败模式定位根因(npmjs 的 WS
  拦截、YouTube 完全未初始化),能修的就修;修不了的,记录受影响的站点
  类别/策略(README 或 docs/guides 的已知限制说明)。
- npmjs 假设:CSP 的 `connect-src` 拦截了 `ws://127.0.0.1`;`new WebSocket` 在 CSP 拦截时
  **不会**抛错 —— 只有异步的 `onerror` 和页面的 `securitypolicyviolation` 会触发,所以
  现有的 `conn.wsFailed` toast(挂在构造函数 catch 上)永远不显示。
- YouTube:userscript 根本没有初始化 —— 需要另行复现并定位根因
  (注入模式 / SPA 时机 / `window.__PI_WEBPICKER__` world / Trusted Types)。
- 无论能否修复都大概率的交付物:可见的连接失败反馈
  (监听 `securitypolicyviolation` + `onerror`,fab 徽标/toast)+ 记录在案的
  不兼容站点类别。

## P0-B — Broker/admin daemon:去掉实验性 Node 依赖
- 决定(2026-10-13):像 `mesh-runtime.cjs` 一样**打包** broker/admin daemon(提交到仓库的
  构建产物,`npm run build` + 新鲜度测试)。同时消除实验性 API 风险和
  node_modules 限制。
- 来自用户的打包备注:打包之后,npm publish 应**排除 `.ts` 源码**
  (当前 `files` 包含 `*.ts`)—— 发布 bundle,而不是源码。
- README 必须写明 Node 版本要求(当前缺失);确切下限在设计阶段确定。
## P1-E — Mesh 节点能力描述

- 用户请求(2026-10-13):mesh 节点是平等、独立的 actor;目前它们全是
  agent 类型节点,当一个 agent 想主动调用另一个时,它无从
  知道谁在做什么。为每个节点增加描述性元数据,让其他 agent 能决定该给谁
  发消息。
- 用户设定的要求:**默认不存在**、由节点自己可编辑、**按需查询**
  (列表只带名字;描述在需要时按目标逐个拉取)。
- `mesh.config.json` 被排除 —— 它是一个机器全局文件,只含连接信息,
  没有逐节点数据。
- 合适的方向:描述存放在引擎上该节点自己的 actor state 里
  (每个节点本来就已是 `getOrCreate("xfer-instance", [name])`)。通过节点侧的
  命令设置/修改(与 `/xfer name` 同级的兄弟命令,例如 `/xfer desc`);其他 agent 按需查询目标
  actor。跨机传播自动获得,因为这是引擎侧状态。
- 留给设计阶段的问题:查询面(新工具还是扩展发现)、描述是
  自由文本还是结构化、以及临时性的「向 ExecutiveAgent 报告接口
  能力」handoff 模式(session `pi:01a11120`)是否应成为这个
  一等机制。

## P1-D — Handoff 的 cwd 锚定(来自 refine 的跨项目 retro)

- 问题:接收方 agent 在处理跨项目 handoff 时反复在错误的 checkout 里改文件;
  doc 不带权威的工作目录锚点。
- 方向:在发送方做机械式写入,而不是靠约定。`xfer_to`/`xfer_mesh_to`
  在发送时知道发送方的 cwd;把锚点写进投递的 markdown(例如
  `<!-- xfer:sender-cwd ... -->`),并把相应指示加入注入信封。
- 消费方给出的设计答复(refine,2026-10-13,原样记录在 handoff
  `pi-xfer-mv647ogc-8iltwn.md` 中):
  1. 写入锚点 + 信封指示就够了;暂不做接收方强制 ——
     只有在锚点上线后仍反复出现错误 cwd 编辑时才重新考虑。
  2. 跨机 mesh:降级为项目名锚点**加上**发送方机器/用户和
     worktree/分支提示 —— 同一个项目在不同机器上位于不同路径,
     仅凭 worktree 名会有歧义(dev/dup2/dup3)。
  3. 把指示放在 `📨 [Xfer from ...]` 信封文本里(接收方第一眼看到的东西),
     而不是只作为 doc 里的 HTML 注释。

## 已关闭 / out of scope

- Quickstart 视频/GIF —— 改为发布在 YouTube;不列为里程碑条目。
- Publish workflow 自动 release notes —— 已在 `publish.yml` 实现。
- `docs/guides/` 拆分 —— milestone 1 已完成。
- verify skill / chrome-devtools MCP —— 已在 milestone-1 retro 落地(`e6ec107`)。

## 状态
两个待决决定均已于 2026-10-13 定案(P0-B:打包;P0-A:先调查)。清单
已可进入最终批准,之后转入 design 节点。
