> 中文版 · 英文原文：[phase1-polish.md](phase1-polish.md)

# Milestone: 阶段1 — 打磨

> 目标:初步具备从"个人 extensions"扩展到一定的公共性、易用性、对外部人员的吸引力。
> 插件当前仍以自用为主,不急于推广,因此优先做噱头和自用体验,推广性工作以低成本为主。
>
> 状态:草案 → 待作者批准 · 发散来源:2026-10-11 brainstorm 节点

## 功能清单(按优先级排序)

### P0 — 必做

1. **Xfer Admin(`/xfer admin`,原称 dashboard)**
   实时可视化控制台,本里程碑最大的"噱头"和吸引力来源。设计已定稿,见下方 *Admin 设计计划*。
2. **Quickstart(文档版)**
   面向新来者的上手路径:是什么 → 装 → 30 秒跑通第一个 handoff。当前 README 无法让新人知道怎么用。

3. **演示素材**
   60–90 秒无声 MP4 + 字幕标注,嵌入 README(另传 YouTube 作为备用引用)。设计已定稿,见下方 *演示素材设计计划*。

### P1 — 应做

4. **i18n(web-picker.user.js)**
   中英文适配:跟随浏览器语言 + 手动切换;不做通用 i18n 框架,简单映射表即可。

5. **提示信息规范化**
   `/xfer` CLI 输出与 agent-facing 提示信息统一为英文(规范化,非全面国际化)。

6. **`/xfer doctor`**
   安装后自检:broker / socket / mesh 状态检查,给出下一步指引;与 quickstart 配套。

7. **Mesh 部署指南**
   Mesh 跑通需要:自建 control plane(自托管 VPS,参考 [rivet.dev self-host 文档](https://rivet.dev/docs/deploy/self-host/control-plane/))或直接使用官方能力,再在本地配置 `mesh.json` 才能工作。当前完全无文档,外部人员无法自主理解这一链路。需写一份具体 guide:control-plane 两条路线(官方 vs 自托管)、`mesh.json` 字段说明、端到端验证步骤。
### P2 — 顺手做
### P2 — 顺手做

8. **README 叙事重写(英文优先)**
   按"是什么 / 为什么 / 30 秒上手"重写叙事;中文文档是否单列(`docs/zh/`)在 design 节点定。

9. **README 致谢**
   Acknowledgements:设计思想来自 [PIdETjcXNIk](https://www.youtube.com/watch?v=PIdETjcXNIk),第一版基于 [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)。

10. **npm 包元信息打磨**
    description / keywords / repository 字段,npm 页面观感。

11. **README 徽章**
    npm version / CI badge,低成本可信度。

12. **发布流程自动生成 Release Notes**
    当前 `publish.yml` 只发 npm,不发 GitHub Release,release note 全靠手动。改为 workflow 自动创建 draft release(可用 [generate release notes API](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release) 从 commits/PRs 提取初稿),人工补几句后 publish;摆脱每次手动操作。

13. **docs 目录分层:AI/开发文档 vs 用户指南**
    现有 `docs/`(ADR、CONTEXT.md、web-picker.md)是面向 AI/开发者的;quickstart、mesh 部署指南等用户向内容应独立目录(如 `docs/guides/`),README 只放入口链接。具体目录结构在 design 节点定。
## 明确 out of scope

- 视频 quickstart(若 P0-3 的演示素材最终选视频形态,则视为同一条,不重复投入)
- 通用 i18n 框架(仅中英硬编码)
- Board 的 UI 化(dashboard 只读展示可以,不做操作界面)
- `examples/` 示例场景 / 完整 transcript 示例
- 推广动作(发帖、投稿、外部宣传)——本阶段只打磨,不推广

## 下一步

## Admin 设计计划(design 节点定稿,2026-10-11)

**定位**:本机全局单例 web 控制台,观察 + 轻控制;术语已入 CONTEXT.md。

**部署与生命周期**
- `/xfer admin`(裸命令)= 幂等 start + open URL,输出顺带显示 running 状态;`/xfer admin stop` 用于释放端口与故障重置。不设单独 status 子命令。模式照抄 broker-manager
- 独立 daemon,与 broker 职责分离(broker 服务 web-picker,admin 服务人)

**功能范围 v1**
- 实时事件流(本机 handoff/peer/mesh/broker 活动,SSE 推送)
- 在线状态:本地 peers + mesh node 全景(本机渲染 mesh 引擎状态,非远程 admin 协议)
- Board:list + 查看;编辑/清理走 `open folder` / `open in editor` 按钮委托系统,页面零写 API
- 控制:gc、broker start/stop、状态自检(全部复用现有命令逻辑)

**技术路线**
- 零运行时依赖、零 bundle:node:http 多页(MPA)+ 服务端渲染 + htmx 式局部交换 + 原子化 CSS
- 复用 `ws-server.ts` 级别的手写 SSE;静态资源由 admin server 直接吐
- 仅绑定 localhost,信任模型与 broker 一致,无鉴权

**Out of scope(v2+)**:broker 之外的远程启停、从其他设备访问、网页新建/编辑 board card、图表面板(若需要则升级为 mesh-runtime 式 bundle 模式)

**原型结论(2026-10-11,经两轮原型与外部评审定稿)**
- 信息架构:卡片仪表盘形态——dashboard 为总览层(统计卡 + live activity);events / board / control 各自独立成页(MPA 导航),board 为两层(list → `/board/:title` markdown 详情 + open in editor,list 层带 open folder)。
- 视觉:**variant B "Ink"**——暖纸色背景、柔和边框、统计卡彩色顶边与彩色数字(peers 绿 / mesh 紫 / board 蓝 / broker 琥珀);弃选 primer 灰(A)与色块瓷砖(C)。
- 布局:去掉 1080px 宽度上限,内容随视口 + 两侧留白;events 面板占满视口剩余高度,页内滚动在面板内部,页面本身不滚动。
- 控件:胶囊按钮、无阴影、danger 从一开始就是实心红;一切可点元素必须是按钮形态。
- 提示:`since page open · not persisted` 的内联文案改为 kind 过滤器后的小号斜体 **i**,hover 显示完整说明。
- 主题:亮色默认,支持暗色切换。
## 演示素材设计计划(design 节点定稿,2026-10-11)

**形态**:60–90 秒无声 MP4(字幕标注节奏),README 顶部嵌入;同时上传 YouTube,README 加备用引用。不做 GIF。

**镜头脚本(顺序即叙事)**
1. 痛点钩子(~10s):agent 收到 `[Xfer from peer]` → 打开结构化 handoff 文档
2. web-picker(~15s):浏览器圈选 + record → 提交 handoff
3. Admin(~20s):`/xfer admin` 一键起,实时事件流 / mesh 在线 / board(依赖 P0-1 实现)
4. 原理动画(~15s):mesh 架构示意——本地 socket 路径 + control-plane + handoff 跨机飞行(替代实拍双机)
5. 收尾(~10s):logo + `pi install npm:pi-xfer` + repo 地址

**制作方式**:[HyperFrames](https://github.com/heygen-com/hyperframes)(Apache 2.0,HTML → 确定性 MP4,agent-friendly)驱动原理动画与字幕合成;镜头 1–3 为真实录屏(OBS),剪辑合成也在 HyperFrames 流程内。工具链不进 extension 运行时依赖,素材源码入仓(如 `demo/`)。

**制作时机**:implement-and-verify 节点,Admin 与核心流可演示之后。

## 其余功能设计要点(design 节点定稿,2026-10-11)

**P0-2 Quickstart** — `docs/guides/quickstart.md`:是什么(3 行)→ `pi install` → 30 秒跑通第一个 handoff(最短可复现命令序列);README 顶部放 3 行复制即用代码块 + 链接。收尾不是链接堆砌,而是一张 **Archify 交互式架构图**(static 导出图内嵌 + 链接打开交互版;分层:peer → broker → mesh → control-plane),作为理解入口。验收:新人 5 分钟内发出第一个 handoff,不读 ADR。

**P1-4 web-picker i18n** — `web-picker.src/i18n.js` 扁平 `{key:{en,zh}}` + `t(key)`;默认跟随 `navigator.language`(zh* → zh,否则 en),油猴菜单手动切换(`GM_getValue` 持久);仅 UI 字符串;`npm run build` 重出产物。

**P1-5 提示信息英文化** — `commands.ts`/`broker-manager.ts`/`gc.ts`/`client.ts` 等全部 CLI/agent-facing 输出统一英文:动词开头、错误带原因 + 下一步;硬编码不做 i18n;同步更新测试断言。

**P1-6 `/xfer doctor`** — 逐项检查(peers socket、broker 进程/端口、mesh 配置与 engine、admin 状态)输出 ✓/✗ + 修复提示(指向具体命令);复用现有状态查询,不新造探测;输出遵循 P1-5 规范。

**P1-7 Mesh 部署指南** — `docs/guides/mesh-setup.md`:两条路线(官方托管 / 自托管 VPS,链 rivet.dev)→ `mesh.json` 逐字段说明 → 端到端验证 → 常见故障。配一张 **Archify 交互式架构图**(与 Quickstart 同源),关键节点可复用演示 MP4 的关键帧截图。写完由未接触过项目的子代理冷读验证"照抄能跑通"。

**P2-8 README 英文叙事重写** — what/why(3 行)→ demo MP4 → quickstart 3 行 → capabilities 表 → Docs 小节;**仅英文,不做中文文档**;在 Admin 实现并产出 demo MP4 之后做。

**P2-9 致谢** — Acknowledgements:设计思想来源视频 + disler/pi-vs-claude-code。

**P2-10 npm 元信息** — `package.json` 补 description/keywords/repository;npm 页面观感检查。

**P2-11 徽章** — README 顶部 npm version + CI badge。

**P2-12 自动 Release Notes** — `publish.yml` 在 npm publish 后调 generate-release-notes API 创建 **draft release**(自动取上一 tag);人工补注后手动 publish,不全自动。

**P2-13 docs 分层** — `docs/guides/`(用户向:quickstart、mesh-setup)/ `docs/adr/` + `CONTEXT.md`(AI/开发向)/ `docs/web-picker.md` 移至 `docs/dev/`;README 增 Docs 小节分组列出。

- 原型存于 throwaway 分支 `prototype/admin-ui`(根目录 `admin.server.prototype.mjs`),main 不保留。

## 下一步

各功能的实现方案在 **design** 节点逐一 settle;本节点不做文档式设计。
