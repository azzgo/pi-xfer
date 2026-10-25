> 中文版 · 英文原文：[phase2-summary.md](phase2-summary.md)

# Milestone 2 总结 — Release Note 素材

> Milestone:阶段2 — 健壮性 + 站点兼容性 + 跨 agent 人机工程。
> 状态:所有计划项已实现并验证。候选清单与逐特性
> 设计计划:`docs/milestones/phase2-candidates.zh.md`、`phase2-design-p0a.zh.md`、
> `phase2-design-p0b.zh.md`、`phase2-design-p1d.zh.md`、`phase2-design-p1e.zh.md`。

## Shipped

### P0

- **P0-A Web picker 站点兼容性** — userscript 现在能在充满敌意的页面上存活。
  根因是在真实站点上通过 chrome-devtools 现场验证的(诊断见下方 *Fixes*):
  一个 Trusted Types 兼容层(`createPolicy('pi-xfer')`,用 `setHTML`
  替换所有裸 `innerHTML` 赋值)修复了在强制 Trusted Types 的站点上的初始化崩溃;
  被 CSP 拦截的 WebSocket 连接现在通过基于 `securitypolicyviolation` 的
  blocked 状态浮出,而不是静默失败;当 broker 通道不可达时,picker 降级为
  离线 copy-prompt 流程(本地 prompt composer,不提及页面工具通道,
  未连接时隐藏发送按钮)。
- **P0-B Broker/admin daemon 作为提交的构建产物** — `broker-main.ts` 和
  `admin-main.ts` 现在由 esbuild 打包为提交的 `broker.cjs` / `admin.cjs`
  (各带 `.sha256`,重建时做新鲜度测试,与 `mesh-runtime.cjs` 一致)。daemon 不再
  通过 Node 的实验性 type stripping 启动,同时消除了实验性 API 风险和
  `node_modules` spawn 限制。提交的构建产物从两个变成四个;AGENTS.md 相应更新。

### P1

- **P1-D Handoff 的 cwd 锚定** — `xfer_to` / `xfer_mesh_to` 在投递的 markdown 里写入
  发送方 cwd 注释(cwd / project / machine / branch),注入信封
  现在指示接收方 agent 在发送方目录里编辑。跨机
  handoff 降级为项目名 + 机器/用户 + 分支提示,接收方不再在
  错误的 checkout 里编辑。
- **P1-E Mesh 节点描述** — 节点可通过 `/xfer desc` 自我描述;描述
  存放在引擎上该节点的 actor state 里(所以跨机传播免费),可按目标
  通过 `describe` RPC 读取,并被附加到 broker `targets` 的结果上。
  有意不做批量列表扇出、不做调度逻辑 —— 决定给谁发消息留给
  消费方 agent。

## Fixes(里程碑期间)

- Web picker 根因,在修复前现场诊断:npmjs.com 的 CSP `connect-src`
  白名单拦截 `ws://127.0.0.1`,并且 —— 重要 —— `new WebSocket()` **不会**
  抛错,`onclose` 也永不触发,所以旧的错误 toast 根本到不了;YouTube
  强制 Trusted Types,因此 `root.innerHTML = …` 在初始化期间抛错,杀死了整个
  userscript 且没有任何错误出口。
- 后续修复(`978b89e`):web picker 中降级态布局与 blocked 态时机的修正。
- Broker 版本现在从 `package.json` 读取,而不是硬编码的 `0.1.0`。

## Key decisions

- 提交的构建产物以 bundle 形式发布(现在是四个:`web-picker.user.js`、
  `mesh-runtime.cjs`、`broker.cjs`、`admin.cjs`),关闭了 milestone-1 关于
  `stripTypeScriptTypes` 是实验性 Node API 的后续项。
- P0-A 遵循「先调查」的决定:两种失败模式都在改任何代码之前于真实站点上定位了
  根因;无法修复的情况可见地降级,而不是静默。
- P1-D 是发送方机械式写入,而不是接收方约定或强制 ——
  只做锚点 + 信封指示,只有错误 cwd 编辑再次出现时才重新考虑。
- P1-E 保持 mesh 的平等性:描述默认不存在、节点可编辑、
  按需拉取;扩展里没有调度/分派逻辑。

## Verification

- `npm test`:285/285 全绿。
- 打包后的 daemon 单独冒烟测试(`broker.cjs` / `admin.cjs` 可直接运行)。
- P1-D 通过 tmux 驱动的 pi session 现场验证(接收时可见锚点 + 信封)。
- 待办的人工后续:Tampermonkey 上重测 picker UI 修复
  (YouTube/npmjs),并对普通站点做一轮回归;重测 npm 安装场景。

## Follow-ups / Deferred

- Mesh 描述调度的消费方(一个用描述来路由工作的 agent)——
  按用户决定推迟;数据层已发布,消费方没有。
- 若出现更多 CSP 变体,为 web picker 记录不兼容站点类别的说明。

## Closed / out of scope

- Quickstart 视频 —— 改为发布在 YouTube
  (https://youtu.be/0mm2CirJMUo,milestone 1)。
- Publish workflow 的 release notes —— 已在 `publish.yml` 自动化。
- Verify skill —— 已在 milestone-1 retro 落地(`e6ec107`)。
