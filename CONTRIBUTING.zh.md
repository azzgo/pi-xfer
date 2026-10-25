> 中文版 · 英文原文：[CONTRIBUTING.md](CONTRIBUTING.md)

# 为 pi-xfer 做贡献

给人和外部贡献者的一份简短指引。**如果你是在本仓库里干活的 agent，请改读 `AGENTS.md`**——它更严格，也是事实来源。本文件不复述它；两者可能漂移之处，以 `AGENTS.md` 为准。

## 这是什么

一个 pi 扩展，做单向的跨上下文交接：`xfer_to` 写一份 markdown 文档，交给另一个 agent 的 socket，然后立刻返回。能力表读 `README.md`，词汇读 `CONTEXT.md`，设计为何如此读 `docs/adr/`。

## 开 PR 之前

- **`npm test` 必须全绿。** 测试在*规则上*就是密闭的：测试绝不能碰到已部署的引擎、隧道或中继，也绝不能需要 token。`mesh-guard.ts` 从结构上强制这一点——只要设置了 `NODE_TEST_CONTEXT` 它就武装自己，并拒绝一切非 loopback 端点，所以一个忘记注入桩的测试会大声失败，而不是悄悄连上别人的部署。
- **如果你改动了 `web-picker.src/`、`mesh-runtime.src/`、`daemon/broker-main.ts` 或 `daemon/admin-main.ts`，请跑 `npm run build` 并提交产物**——`dist/web-picker.user.js`、`dist/mesh-runtime.cjs`、`dist/broker.cjs`、`dist/admin.cjs`，以及 `.sha256` 文件。一个新鲜度测试强制字节级一致，过期的产物会让 CI 失败。
- **不新增运行时依赖。** 扩展本身不携带任何依赖；rivetkit 是打进 bundle 的，不是安装的。`examples/` 保留自己的 `package.json`，不发布。
- **文档要成对更新。** 每份面向人的文档都有一份 `.zh.md` 中文镜像，两侧在同一次提交里一起改。规则见 [`docs/i18n.zh.md`](docs/i18n.zh.md)，`npm test` 会检查配对与结构，但译文质量只能靠 review。

## 增加一个宿主

`generic` 覆盖任何有 shell 的宿主。如果你的宿主需要不同的安装位置或不同的启动命令，`skills/xfer-agent/hosts/` 里的命名预设才是正确的形状——预设里可以有什么，见 `skills/xfer-agent/install.md`。**预设只携带配置，绝不携带投递逻辑。**

## 我们不接受的东西

这些是已经定下的决定，不是待议问题。请先讨论决定本身，再为它的实现开 PR：

| | 原因 |
|---|---|
| A2A | pi-xfer 在设计上无状态；A2A 会把这个选择反过来 |
| 存储支撑的持久读回执 | ADR-0015 有意选择了一个会丢失的 take-to-read Inbox |
| 入站的 `held` 状态 | ADR-0020——mesh 的队列契约表达不了它 |
| 预设内部的逐宿主投递逻辑 | 会随其他项目的发版漂移，也无法被本仓库的密闭测试覆盖 |
| handoff 上的线程或因果字段 | 推迟到后续 milestone；需要先有它自己的决定 |

## 决定如何被记录

任何难以逆转的事都会在 `docs/adr/` 里留一份 ADR——一段话加后果，在决定做出时写，而不是事后补。词汇住在 `CONTEXT.md`；如果你的改动引入了新术语，或让既有术语更精确，就在同一个 PR 里更新它。
