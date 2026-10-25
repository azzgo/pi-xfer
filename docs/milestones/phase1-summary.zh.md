> 中文版 · 英文原文：[phase1-summary.md](phase1-summary.md)

# Milestone 1 总结 — Release Note 素材

> Milestone:阶段1 — 打磨 · 目标:初步具备公共性、易用性、对外部人员的吸引力。
> 状态:13/13 项已实现并验收。功能清单与设计计划见 `docs/milestones/phase1-polish.md`。

## 已交付(13 项)

### P0

- **P0-1 `/xfer admin`** — 独立 localhost web 控制台 daemon(`idempotent start + open URL`,`/xfer admin stop` 释放端口)。MPA 零依赖服务端渲染页面:dashboard / events / board / control;SSE push-and-forget 实时事件流;board list + view,编辑委托系统(open folder / open in editor,页面零写 API);gc、broker start/stop、自检控件复用现有逻辑;亮色默认 + 暗色主题。视觉经 `prototype/admin-ui` throwaway 分支两轮原型定稿(variant B "Ink"),原型不进 main。
- **P0-2 Quickstart** — `docs/guides/quickstart.md`(是什么 → 装 → 30 秒第一个 handoff),经真实端到端 headless session 交付验证。附 Archify 交互式架构图(`docs/guides/assets/xfer-architecture.html` + svg,支持 static 内嵌)。
- **P0-3 演示视频** — 全自动管线在 `promo/intro/`:VHS 录制两段真实交互 pi TUI session、Playwright 驱动真实 web-picker 与 admin 画面、HyperFrames 合成(含免版税合成 BGM)。已发布 YouTube:https://youtu.be/0mm2CirJMUo ;README 已链接;仓库不追踪任何二进制素材。

### P1

- **P1-4 web-picker i18n** — `web-picker.src/i18n.js`(约 114 keys,en/zh);默认跟随 `navigator.language`,油猴菜单手动切换并经 GM storage 持久;产物 `web-picker.user.js` 已重出。
- **P1-5 agent-facing 字符串英文化** — 全仓 Han 扫描为零。
- **P1-6 `/xfer doctor`** — 只读自检(socket 目录 / peers + siblings zombie 计数 / broker / admin / mesh),复用现有探测;severity 永不为 error;opt-in 服务未运行视为 pass 并给修复提示。
- **P1-7 Mesh 部署指南** — `docs/guides/mesh-setup.md`:Rivet Cloud vs 自托管 control plane 两条路线、`~/.pi/xfer/mesh.config.json` 逐字段说明(已对代码核实)、端到端验证、与 doctor 联动的故障排查表。附 Archify 交互式 mesh 架构图。

### P2

- **P2-8 README 英文重写** — what/why → YouTube demo → quickstart → capabilities → Docs 分节(用户指南 vs 开发文档)。
- **P2-9 Acknowledgements** — 设计思想来源视频 + disler/pi-vs-claude-code。
- **P2-10 npm 元信息** — package.json 补 bugs / homepage。
- **P2-11 徽章** — npm + license badge。
- **P2-12 自动 Release Notes** — `publish.yml` 在 npm publish 后创建 draft GitHub release(自动生成 notes;`contents: write`;`continue-on-error`),人工补注后手动 publish。

## 修复(里程碑期间)

- npm 安装的 extension 无法启动 daemon:node 内置 TS stripping 拒绝 node_modules 内 `.ts` + wire.js 符号链接被解引用 — 自定义 `stripTypeScriptTypes` load hook 修复;移除 wire.js symlink。
- 浮动传递依赖(zod、p-retry)导致 `mesh-runtime.cjs` bundle 漂移 — build.mjs 中 pin 死;新增产物新鲜度测试(重建 `web-picker.user.js` / `mesh-runtime.cjs` 与提交版逐字节比对)。
- `admin-main.ts` xfer-dir watcher 引用未定义的 `peerName`(peer socket 变化即崩溃)— 录 demo 时发现并修复。
- esbuild pin 到 exact 0.28.2。

## 关键决策

- Admin 为独立全局单例 daemon(镜像 broker-manager 生命周期),仅绑 localhost;board 网页只读,编辑委托系统。
- 保持零运行时 npm 依赖:admin 手写 node:http + SSE,无 bundle;docs 分层为 `docs/guides/`(用户向)vs `docs/adr/`、`CONTEXT.md`、`docs/dev/`(AI/开发者向)。
- 图表用 Archify(MIT),视频用 VHS + Playwright + HyperFrames — 全部代码驱动、可重渲染、管线在仓。
- 仓库不追踪二进制素材;YouTube 作为分发渠道。
- 文档暂仅英文(中文文档本里程碑 out of scope)。

## 后续 / 推迟

- Mesh 部署指南尚未做真实双机验证(guide 已标注 untested steps);rivet 文档中的自托管 runner-config 细节未在本地复现。
- 远程 admin(跨设备控制)、board 写 API、admin 图表 — 明确 v1 out of scope。
- `stripTypeScriptTypes` 为实验性 Node API;若上游移除,长期方案是 bundle daemon(先例:`mesh-runtime.cjs`)。
- `admin-main` 的 /control 页 minimal selfCheckReport 可与 `doctor.ts` 收敛。
