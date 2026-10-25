> 中文版 · 英文原文：[mcp-gateway.md](mcp-gateway.md)

# MCP gateway —— 给宿主模型提供带类型的 xfer 工具

`mcp-gateway.mjs` 是一个 **stdio MCP server**：宿主启动它、持有它的
stdin/stdout，它的工具则去 fork 已经存在的 `xfer-adapterd` CLI。它不绑定
socket、不保留 inbox、不加入 mesh、也不跑 agent 循环——每个工具只是拼出一个
argv 并 fork 那个 CLI。

“不绑定 socket”这一点，正是这套设计廉价**并且**是用户唯一会注意到的那个行为的
全部原因：

| | |
|---|---|
| 创建的 Node | 无 |
| 出现在 `/xfer list` 中的宿主 | **仅当**有东西绑定了 socket（`xfer-adapterd up`）之后——只发送的 gateway 在那里是不可见的 |
| 接收方看到的发送者 | 你启动 gateway 时给的 `--name` |

不可见是诚实的：发送并不需要被列出。这也是唯一值得事先说明的行为差异，因为习惯了
在 `/xfer list` 里看到某个宿主的人会去找它，然后找不到。

## 为什么是每宿主会话一个，而不是一个共享进程

stdio 意味着进程归宿主所有，所以**每个宿主会话**有一个 gateway，各自可以携带自己
的名字。因此 `/xfer list` 不会塌缩，接收方看到的是那个宿主的名字而不是某个 gateway
的名字。残余风险是两个 gateway 配置了同一个 `--name`——那是配置错误，而 `--name`
是必填的，正是为了让它不可能意外发生。

## 安装

无构建步骤、无运行时依赖：它是一个入库的 `.mjs`，不从本仓库 import 任何东西。
把你宿主的 MCP 配置指向它即可。

**Claude Code / `claude_desktop_config.json` 风格：**

```json
{
  "mcpServers": {
    "xfer": {
      "command": "node",
      "args": [
        "/path/to/pi-xfer/mcp-gateway.mjs",
        "--name", "agent-my-host"
      ]
    }
  }
}
```

对于 npm 安装的 pi-xfer，路径是
`~/.pi/agent/npm/node_modules/pi-xfer/mcp-gateway.mjs`。

## 参数

| 参数 | 必填 | 含义 |
|---|---|---|
| `--name <n>` | **是** | 盖在每一份 handoff 上的发送者名字。永不推导——不来自 cwd，也不来自环境变量。 |
| `--dir <d>` | 否 | peer socket 所在目录。默认 `~/.pi/xfer`。测试会把它指向一个全新的临时目录。 |
| `--xfer-adapterd <path>` | 否 | 要 fork 的 CLI。默认是本文件旁边的 `dist/xfer-adapterd.cjs`；测试会把它指向一个 stub。 |

**`--name` 必填且永不推导。** 只发送的 gateway 不绑定任何东西，所以名字冲突无法像
重复的守护进程那样被抓住（`claimEndpoint`）——只能在启动时拒绝。`xfer-adapterd
install` 生成的那个名字就是正确的名字。

`--no-preflight` **刻意不作为工具参数**。它是留给调试引擎的人用的；模型不应该伸手
去拿它，所以 gateway 从不提供它。

## 工具

| 工具 | 背后是 |
|---|---|
| `xfer_send` | `xfer-adapterd send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>` |
| `xfer_mesh_send` | `xfer-adapterd mesh send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>` |
| `xfer_list` | `xfer-adapterd list --json --dir <dir>` |

`xfer_send` / `xfer_mesh_send` 接收 `{ target, summary, document, kind }`，
返回 `{ handoff_id, outcome, target }`。

`outcome` 永远是 ADR-0020 的**四个**取值之一——`queued`、`delivered`、
`unknown`、`not-delivered`——没有第五个。失败的 CLI 仍然是 `isError: true` 的
结果，但它的 `outcome` 仍留在这个集合内：

| 情况 | `outcome` |
|---|---|
| 本地发送收到 ack | `delivered` |
| mesh 入队被接受 | `queued` |
| 目标没有 socket（`peer "x" not found`） | `not-delivered` |
| ack 超时、连接断开、无法归类的拒绝 | `unknown` |
| CLI 无法说明（配置错误、二进制缺失、崩溃） | `unknown` |

**`unknown` 永远不是确定的否定，也永远不构成重发的理由。** ack 超时意味着这份
handoff 很可能已经到达；把它报成“未发送”会让模型重发，而这正是这个取值存在所要
防止的重复风险。`detail` 字段携带 CLI 自己的消息，外加一句明确的“请勿重发”，
于是这条指引连同判定一起抵达模型。

**preflight 警告**（mesh 的 `Mismatch`：actor 记录读作 idle，而目标的 pool 里确实
有一个活着的 runner）*不是*失败——handoff 已经入队，引擎会在下一次发送时把它放上去。
它写到 stderr，退出码保持 0。

`xfer_list` 接收 `{}`，返回 `{ targets: [{ name, sessionName, cwd,
status }] }`。**仅限本地**——mesh 节点由 xfer 扩展列出，不在这里。

gateway 自己把 handoff 文档写到临时文件，与 `xfer_to` 完全一样，并传这个路径；
调用返回后文件即被删除。

## 接收不在范围内

没有 inbox、没有 `xfer_inbox`、也没有 `--on-handoff`。采用这个 gateway 的宿主仍然
只会*发送*。任何期待入站投递的东西都会一无所获，本文档也不得暗示相反的情况。

## 发现能力需要一个新的子命令

`xfer-adapterd` 此前无法从 CLI 列出 peer——`/xfer list` 是一个 pi 命令。没有替代
方案的话，只发送的宿主仍然需要一个 shell 去找目标，而这正是这个特性存在所要解决的
一半问题。于是新增了 `xfer-adapterd list [--dir D] [--json]`：它打印那些 `*.sock`
兄弟文件及其元数据，`--json` 每行输出一个对象（与 `inbox` 打印的形状相同）。这也
改善了 skill 路径——此前它告诉宿主手工去读目录。

## 验证

`npm test` 在 `mcp-gateway.test.ts` 中覆盖：

- 一次**真正的 stdio JSON-RPC 握手**——`initialize`、`tools/list`、
  `tools/call`——针对一个被启动的 `mcp-gateway.mjs`，而不是传输层 mock；
- **stdout 纯净性**：stdout 上的每一行都是 JSON-RPC 帧，错误路径上也一样。一行杂音
  就会破坏会话，而且看起来像客户端坏了而不是服务端坏了，所以这是本文件里最可能
  出现的 bug；
- 三个工具的**精确 argv**，通过 `--xfer-adapterd` 上的 stub CLI 验证，这样 CLI 参数
  的改动无法悄悄与工具 schema 脱节；
- `adapterd.test.ts` 中的 `xfer-adapterd list` 与 `send -`（从 stdin 读文档）。

**loopback 端到端 mesh 测试**存在但默认跳过：它需要固定的 `rivet-engine` 二进制，
而且第二个引擎必须有自己的 `guard` 端口和自己的数据库，否则它只会半工作，看起来像
引擎坏了。`XFER_ENGINE_BINARY` 用于开启；共存的引擎的配方在
`.agents/skills/verify/SKILL.md`（贡献者）中——注意 `runner-configs` 的 PUT 会被
2.3.26 引擎拒绝，所以 loopback 引擎目前只适合读，不适合真实的 mesh 入队。

gateway 本身从不接触引擎，所以这里不加载 `mesh-guard.ts`——也不需要。mesh 代码路径
在被 fork 的 CLI 里，它从测试继承 `NODE_TEST_CONTEXT`，因此与其他任何被启动的
adapter 一样在结构上被守护。

**针对真实部署的 smoke 是人的决定**，按 AGENTS.md 的规定，而且它比一次 loopback
运行多买到的东西很少。
