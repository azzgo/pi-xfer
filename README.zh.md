> 中文版 · 英文原文：[README.md](README.md)

# pi-xfer

[![npm version](https://img.shields.io/npm/v/pi-xfer.svg?style=flat-square)](https://www.npmjs.com/package/pi-xfer)
[![license](https://img.shields.io/npm/l/pi-xfer.svg?style=flat-square)](./LICENSE)

在 [pi](https://github.com/nicobailon/pi) 编码 agent 之间做结构化的 markdown 交接。agent 交换的不是聊天碎片，而是一份文档——Context / Problem / Requirements / 回信地址——接收方拿到就能直接干活。本地 Unix socket 投递开箱即用；**Mesh** 提供可选的跨机传输；**web picker** 直接从浏览器里抓取结构化上下文。

## 简介视频

**聊天记录不是交接 —— pi-xfer 发送的是文档**

约 76 秒，两场真实 pi 会话互相交换 handoff。

**[▶ 在 B 站观看 →](https://www.bilibili.com/video/BV1oQWc6fEn9)**

或者，如果你更愿意花 30 秒读一张图——整件事就在这一张画里：

![pi-xfer — 一个 agent 眼中的网络](docs/guides/assets/architecture-panorama.svg)

一份 **Handoff**——一份盖了 Kind 标记的 markdown 文档（`task` 期望恰好一条反向结论；`notification` 除非有误否则保持沉默）——把你的 agent 送到它需要抵达的那一端：

1. **同一台机器** — 其他 agent 自动被发现；handoff 立刻落地
2. **另一台机器，走 mesh** — 跨机的主路径；对方休眠期间 handoff 会持久排队，由一台 server 把网络维系起来
3. **另一台机器，走 ssh** — 给两台已经互信的机器用的点对点补充；无 server，Link 活着期间才可用
4. **进入你的 agent** — 浏览器页面可以把它的 Pick 和 Record 交进来，其他 agent 宿主（Cursor、bot、仅 MCP 的宿主）也能作为 peer 加入同一个网络

每次发送都会报告 handoff 落在哪里（`delivered` / `queued` / `unknown` / `not-delivered`）——绝不报告它是否被读过。回信本身也是一份 Handoff，不是回执。对于比任何会话活得更久的异步话题，agent 读写本机的 **Board**。这张图的交互版在 [`docs/guides/assets/architecture-panorama.html`](docs/guides/assets/architecture-panorama.html)。

## 快速开始

```bash
pi install npm:pi-xfer
pi --xfer alpha   # terminal 1
pi --xfer beta    # terminal 2
```

然后对 `alpha` 说：

```
/xfer beta Summarize this repo and send it back as a handoff
```

完整走查见 [`docs/guides/quickstart.zh.md`](docs/guides/quickstart.zh.md) · 跨机配置见 [`docs/guides/mesh-setup.zh.md`](docs/guides/mesh-setup.zh.md)。

## 能力

| 能力 | 做什么 |
|---|---|
| **本地传输** | Unix socket peer 位于 `~/.pi/xfer/<name>.sock`；`/xfer list`、僵尸回收（`/xfer gc`）、元数据文件、安装自检（`/xfer doctor`）；为 web picker 提供 `/xfer broker start\|status\|stop\|logs` 守护进程 |
| **Mesh 传输** | 基于 [RivetKit](https://rivet.dev) 的可选跨机投递（`/xfer mesh status/up/down/list`，带逐节点的投递判定与发送前检查）；每个实例一个进程内 actor、引擎侧发现、持久队列、bundle + 按需 native runtime（见 `docs/adr/0013`）。**这是跨机的主传输通道。** |
| **SSH Link** | 当你不想立一台 mesh 引擎时使用的点对点补充路径：`/xfer ssh in <host> [name...]` 打开或扩展一条 Link：一个 ssh 进程同时导入那些远端节点（`-L`）**并**导出本机这个 pi（`-R`），于是隧道在构造上就是双向的，`task` 和本地一样安全。`/xfer ssh list <host>` 只读探测，`/xfer ssh status` 显示本 pi 维持的 Link，`/xfer ssh down` 拆掉整台 host 的 Link，且只拆自己的。发往 Link 的 handoff 走 **inline**（接收方读不到本机的文件）。Link 与启动它的 pi 同生共死。无发现、无路由、无缓冲——它借用既有的本地 socket 扫描。**需要免密 ssh（密钥或 agent）：spawn 的 ssh 没有 TTY，密码提示无法被回答。** 它不是 mesh 的替代品；见 `docs/adr/0021` |
| **节点描述** | 每个 mesh 节点自述的能力说明（`/xfer desc <text>`，不带文本即清除）；存于该节点的 actor，按节点读取，并附加到 broker 的 `targets` 列表上，让 picker 用户按契合度挑选。这是未经核实的自我声明——路由仍由消费方决定 |
| **Handoff 结果** | `xfer_to` 与 `xfer_mesh_to` 都会报告 handoff 落在哪里——`delivered` / `queued` / `unknown` / `not-delivered`——以各传输通道能诚实给出的程度为限。绝不表示"是否被读过"：`unknown` 是一个真实答案，且永远不是重发的理由（见 `docs/adr/0020`） |
| **Handoff 完整性** | 走 ssh Link 的 handoff 会带上发送端的 `docSha256`；接收方对自己写入的字节取哈希，并在 ack 中报告 `integrity: verified \| mismatch`，结果会出现在发送返回值里。它证明的是这一帧的正文原样过了线——不是这段文本在取哈希之前从未被改写（见 `docs/adr/0021`） |
| **Board** | 机器本地的异步协作卡片（`/xfer board`）；只追加的条目，由人清理（见 `docs/adr/0014`） |
| **Web picker** | Tampermonkey 用户脚本 + 本地 broker：拾取页面元素、录制交互时段、作为 handoff 提交（见 `docs/dev/web-picker.zh.md`） |
| **MCP gateway** | `mcp-gateway.mjs`——一个 stdio MCP server，通过 fork adapter CLI 把 `xfer_send` / `xfer_mesh_send` / `xfer_list` 暴露给任何 MCP 宿主。不绑定 socket：只发送，因此不会出现在 `/xfer list` 中（见 `docs/guides/mcp-gateway.zh.md`） |

直接从 raw URL 安装用户脚本（`.user.js` 后缀会触发 Tampermonkey 的安装提示）：<https://raw.githubusercontent.com/azzgo/pi-xfer/main/dist/web-picker.user.js>


## 定位

pi-xfer 覆盖的是**重上下文交接**：结构化文档、跨机传输、浏览器采集。对于同机轻量留言（"看下这个文件"、随口一问），[pi-intercom](https://github.com/nicobailon/pi-intercom) 更合适——两者天然共存。

跨机有两条路径，顺序如下：**mesh** 是预期的主路径（发现、持久队列、对方休眠时也能送达），**SSH Link** 是点对点场景的小补充，适用于不值得立引擎的场合。Link 假设两台机器已经通过 ssh 互信，仅此而已——无引擎、无注册表、无离线缓冲。

## 文档

**用户指南**

- [快速开始](docs/guides/quickstart.zh.md) — 五分钟送出第一份 handoff
- [Mesh 配置](docs/guides/mesh-setup.zh.md) — 基于 RivetKit 的跨机传输（主路径）
- [SSH Link](docs/adr/0021-ssh-link-peer-to-peer-transport.zh.md) — 点对点补充路径（设计与边界）
- [Agent 宿主配置](docs/guides/agent-host-setup.zh.md) — 接入非 pi 的 bot（adapter daemon、飞书注意事项）
- [Serverless Cloudflare 节点](docs/guides/cf-serverless-node.zh.md) — 只在有活时才存在的 Cloudflare mesh 节点
- [MCP gateway](docs/guides/mcp-gateway.zh.md) — 通过 stdio 给 MCP 宿主提供带类型的 xfer 工具

**开发**

- [Web picker](docs/dev/web-picker.zh.md) — 用户脚本 + broker 工作流
- [架构决策记录](docs/adr/) — mesh 传输、board 范围、web-picker 的 record 理念
- [CONTEXT.zh.md](CONTEXT.zh.md) — 词汇表与心智模型（Mesh、Node、Board、Card、Marker……）

## 目录结构

- `docs/guides/` — 用户指南（[快速开始](docs/guides/quickstart.zh.md)、[mesh 配置](docs/guides/mesh-setup.zh.md)、[agent 宿主配置](docs/guides/agent-host-setup.zh.md)、[serverless Cloudflare 节点](docs/guides/cf-serverless-node.zh.md)、[MCP gateway](docs/guides/mcp-gateway.zh.md)）
- `docs/adr/` — 决策记录（mesh 传输、board 范围、web-picker 的 record 理念）
- `CONTEXT.md` — 词汇表（Mesh、Node、Board、Card、Marker……）
- `mesh-runtime.src/` + `dist/mesh-runtime.cjs` — 打包的 mesh 引擎，源码与入库的构建产物
- `web-picker.src/` + `dist/web-picker.user.js` — 用户脚本源码与入库的构建产物（模块测试在 `tests/`）
- `src/` — 扩展源码，按域划分（`core/`、`mesh/`、`link/`、`board/`、`session/`、`broker/`、`admin/`），测试与模块同目录；`index.ts` 是入口
- `daemon/broker-main.ts` + `dist/broker.cjs`、`daemon/admin-main.ts` + `dist/admin.cjs` — 两个守护进程，源码与入库的构建产物（`npm run build` 会把五个产物全部生成到 `dist/`）

pi-xfer 原先维护在 [azzgo/dotfiles](https://github.com/azzgo/dotfiles)（`pi/agent/extensions/xfer/`）中；历史自初始提交起保留。

## 开发

```bash
npm install
npm test
npm run build
```

要运行工作区而不是已安装的 `npm:pi-xfer` 副本，用 `pi -ne -e ./` 启动 pi——`-ne`
会跳过扩展发现，已安装的副本就无法与这一个同时加载，也不会在 `xfer_to` /
`xfer_mesh_to` / `--xfer` 上冲突。

`dist/` 下入库的 bundle（`broker.cjs`、`admin.cjs`、`mesh-runtime.cjs`、`web-picker.user.js`）用 esbuild 构建，目标为 **Node 20+**；扩展宿主跑在 pi 所需的任意 Node 上（`engines: >=22`）。如果入库的 bundle 过期，`npm test` 会失败——跑 `npm run build` 并提交产物。

贡献方式与宿主预设：见 [`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md)。

## 致谢

- 设计灵感：[the video that started it](https://www.youtube.com/watch?v=PIdETjcXNIk)
- 第一版基于 [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code)

## 许可

MIT
