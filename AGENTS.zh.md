> 中文版 · 英文原文：[AGENTS.md](AGENTS.md)

# AGENTS.md

你正在开发 **pi-xfer**，一个用于跨上下文交接的 pi 编码 agent 扩展。
本文件是一张地图，不是规则手册——权威指引在它指向的文档里。

**本仓库是双语的。** 下面提到的每份文档都还有一份中文镜像，位于同一路径、以
`.zh.md` 取代 `.md`。英文是源头；中文文件是它的镜像，**两侧必须在同一次提交里
一起改动**——只改英文而不改对应的 `.zh.md` 是未完成的改动，不是后续任务。
完整规则（共享资源、代码逐字保留、链接改写、哪些有意不配对）见
`docs/i18n.md`；能机械检查的那一半由 `npm test` 中的
`src/docs-pairs.test.ts` 强制。

## 按此顺序阅读

1. **`README.md`** — 扩展是什么、安装、能力表
2. **`CONTEXT.md`** — 词汇表与心智模型（Mesh、Node、Board、Card、Marker……）。按定义使用这些术语；不要发明同义词。
3. **`docs/adr/`** — 架构为何如此。已记录的决策是定论；不要重新争论或绕过它们：
   - mesh 传输（bundle + 按需 native runtime、引擎侧发现）
   - board 范围（只追加、由人清理）
   - web-picker 的 record 理念
4. **`docs/dev/web-picker.md`** — 用户脚本 + broker 工作流细节
5. **`docs/dev/mesh-log.md`** — mesh 日志：记录了什么、native runtime 有哪些内容不进文件、如何维护
6. **`docs/release.md`** — 如何发版：升版本、打 tag、推送；发布工作流负责其余部分

## 工作约定

- **主干开发**：以小而聚焦的提交直接提交到 `main`。
- **入库的构建产物**（都在 `dist/`：`web-picker.user.js`、`mesh-runtime.cjs`、`xfer-adapterd.cjs`、`broker.cjs`、`admin.cjs`；`.cjs` 那几个还附带 `.sha256`）：改动 `web-picker.src/`、`mesh-runtime.src/`、`adapterd.src/`、`daemon/broker-main.ts` 或 `daemon/admin-main.ts` 之后，跑 `npm run build` 并提交产物；`npm test` 强制字节级新鲜度。`mcp-gateway.mjs` **不在**其中——它是入库的单文件，没有打包步骤，也不从本仓库导入任何东西。
- **测试**：每次推送前 `npm test` 必须全绿。测试必须密闭——绝不依赖开发者真实的 `~/.pi/xfer` 状态。
- **绝不针对线上部署做测试。** 密闭的 mesh 测试使用注入的引擎接缝（`fakeDeps`）或测试自己启动的引擎；它绝不能触及已部署的引擎、隧道或中继，也绝不能需要 token。针对真实部署的手工端到端检查是每次都要由人决定的事——先问，并且绝不把它接进脚本、测试或 sub-agent 的默认指令。**读也是检查**：一个 `GET`（`/xfer mesh list`、`/xfer mesh status`）和敲进交互式 tmux 窗格的命令都会到达已部署的引擎，所以两者都需要同样的许可——守卫覆盖不到交互式会话。
  有一个已记录的例外：`examples/` 里的 serverless 节点没有别的办法验证——Durable Object 没有本地替身——所以它的验证是**手工的、一次性的、写下来的流程**，跑在真实部署上。它不进 `npm test`，不进任何脚本；流程写在示例的文档里，不写在代码里。
  这一点现在是**结构性的，而不只是规则**：只要设置了 `NODE_TEST_CONTEXT`（一个 `node --test` worker，或它 spawn 的任何进程），`mesh-guard.ts` 就会武装自己，然后从两个出站平面（经 `engineApi` 的 `fetch`、经 `createClient` 的 `rivetkit/client`）以及默认 mesh 配置路径上拒绝一切非 loopback 端点。`XFER_ALLOW_REMOTE=1` 是唯一的放行开关，而没有任何测试设置它——`mesh-guard.test.ts` 在全仓库范围内断言这一点。忘记注入桩的测试会大声失败，而不是连到某个部署上。
- **扩展本身不引入运行时 npm 依赖**；rivetkit 不进入依赖列表（见上面的 ADR）。
- **可见改动要验证**：对 UI 或交互式改动来说，`npm test` 全绿不算验证——改动 admin 页面（`daemon/admin-main.ts`）或 `src/commands.ts` 流程之后，跑 `.agents/skills/verify/` 技能（admin 页面用 chrome-devtools MCP，命令冒烟用 tmux）。web-picker 用户脚本不在范围内（手工）。
- **跨机验证有自己的规则**：当改动涉及 Link（或任何双机传输）时，判断结果是另一套技能——运行中的进程永远不会加载新代码、tmpdir 每台机器不同、mesh 与 Link 的投递会落在同名文件里。在相信任何跨机观察之前，先看 `.agents/skills/verify/SKILL.md` 里的 "Judging results across two machines" 和 `docs/dev/ssh-link-verification.md` 里的三行检查单。
- **只装一份**：让 `npm:pi-xfer` 成为 `~/.pi/agent/settings.json` 里唯一的 pi-xfer 条目，并用 `pi update --extensions` 升级它。同一个会话里两份副本会在 `xfer_to` / `xfer_mesh_to` / `--xfer` 上冲突，第二份加载失败。绝不 `pi install <指向本仓库的路径>`；用 `pi -ne -e ./` 运行工作区（跳过发现，加载本 `index.ts`）。
- **发版**：遵循 `docs/release.md`——`npm version` + `git push origin main --follow-tags`；绝不分别手改版本号和 tag。
- **双语文档**：每份配对文档都有一个 `.zh.md` 孪生文件，改一个就是改两个——同一次提交、同一次 review。具体而言：
  - 先改英文，再把中文镜像带到同一状态。绝不"以后再翻"。
  - 保持结构一致（标题数、围栏块数、图片数），并让**围栏代码块字节一致**——命令、flag、路径、配置键、标识符和 URL 一律不翻译。
  - 相对链接指向 `.zh.md` 对应文件；两侧的文档链接集合保持一致。
  - 资源（`docs/guides/assets/`）是共享的：两侧引用同一个文件，绝不复制或翻译它。
  - 术语在中文行文里保持英文（`CONTEXT.md` 固定了它们；它们是名字，不是单词）。
  - 有意不配对：`skills/**`、`.agents/skills/**`、`.pi/**`、`.pig/**`——原因见 `docs/i18n.md`。
  - `README.zh.md` 在 `README.md` 链接 YouTube 的位置使用 B 站版本（<https://www.bilibili.com/video/BV1oQWc6fEn9>）。
  - 新增文档时在同一次提交里加上它的 `.zh.md`；`src/docs-pairs.test.ts` 会在缺少配对、结构漂移、代码块被翻译、或中文文件的链接没有指向对应文件时失败。

## 布局指引

| 路径 | 职责 |
|---|---|
| `index.ts`（根目录） | 扩展入口（`pi.extensions` 指向它） |
| `src/` | 按域划分的扩展源码：`core/`（共享内核）、`mesh/`、`link/`、`board/`、`session/`、`broker/`、`admin/`——测试与模块同目录 |
| `mesh-runtime.src/` | mesh 引擎源码（打包为 `mesh-runtime.cjs`） |
| `web-picker.src/` | 用户脚本源码（打包为 `web-picker.user.js`） |
| `daemon/` | 守护进程源码（`broker-main.ts`、`admin-main.ts`——打包为 `broker.cjs`、`admin.cjs`，由各 manager spawn） |
| `tests/` | 未打包的 web-picker 源码的模块测试（其余一切由 `src/` 下同目录的 `*.test.ts` 覆盖） |
| `docs/adr/`、`CONTEXT.md` | 决策与词汇表——只在有理由时更新，绝不随意 |
| `*.zh.md`（每份配对文档旁边） | 中文镜像；`docs/i18n.md` 是规则，`src/docs-pairs.test.ts` 是守卫 |
| `skills/xfer/` | pi 侧技能 + 它的 `scripts/xfer` 包装——这里是权威副本，以符号链接部署（绝不复制进 dotfiles） |
| `skills/xfer-agent/` | 非 pi 宿主技能，由 `xfer-adapterd install` 渲染 |
