> 中文版 · 英文原文：[phase4-design-p2.md](phase4-design-p2.md)

# Milestone 4 design — 条目 2(本地 MCP gateway)

> Design 节点后续,2026-10-19。范围已在 `phase4-design-p2-p5.md` 定案;这是该范围所蕴含的
> 实现计划。条目 0+1 在 `phase4-design-p0-p1.md`(ADR-0020)。任何测试都不得触及已部署的引擎;
> 端到端 mesh 冒烟是人的决定 —— 见「验证」。

## 当初的框定是错的,而修正改变了成本

`phase4-design-p2-p5.md` 记录了「一个本地 gateway、许多本地 agent」的一项已知成本:
它背后的每个 agent 共享一个 Node 名字,`/xfer list` 塌缩成一行,接收方
看到的是 gateway 而不是 agent。

**那不是 stdio MCP server 的行为。** stdio 意味着宿主 *spawn* 该 server 并
拥有它的 stdin/stdout,所以是**每个宿主 session 一个** gateway 进程,而不是一个共享
进程。每个都可以带自己的名字,成本基本消失:

| | 一个共享进程(错的) | 每个宿主 session 一个进程(实际的) |
|---|---|---|
| `/xfer list` | 塌缩成一行 | 不变 —— 只发送的 gateway 不 bind 任何东西,所以根本不会出现在列表里 |
| 接收方看到 | `from: <gateway>` | `from: <该宿主的名字>` |
| 残余风险 | —— | 两个 gateway 配了同一个名字,那是配置错误 |

所以先前记录的「盖戳调用方 agent」缓解措施降级为共享名字场景的 escape hatch,
而不是该特性的必需部分。仍然留下的成本值得说明一次:**只发送的宿主在 `/xfer list` 里
不可见**,因为没有东西为它 bind socket。这是诚实的 —— 发送并不需要被列出 ——
但这是用户会注意到的差别。

## 它是什么

一个 stdio MCP server,暴露带类型的工具,这些工具 shell out 到已经存在的 CLI。它
不 bind socket、不保留 inbox、不加入 mesh、不运行 agent loop —— 正是
`sendMeshHandoff` 自己的 docstring 所描述的形状(「用于只发送的宿主……它们不必需要
自己的 daemon 或注册节点」)。

### v1 工具集:三个工具

| 工具 | 背后是 |
|---|---|
| `xfer_send` | `xfer-adapterd send <target> <file> <summary> --kind <task\|notification>` |
| `xfer_mesh_send` | `xfer-adapterd mesh send <target> <file> <summary> --kind <task\|notification>` |
| `xfer_list` | `xfer-adapterd list`(**新子命令**,见下) |

mesh 工具在范围内,而它为何可验证值得精确说明,因为本计划早先的草稿弄错了。
gateway 从不与引擎对话:它拼一个 argv 并 fork `xfer-adapterd`,所以它的 mesh 工具可以用两种方式
验证:一个 stub 在进程内无引擎的情况下断言 argv;以及 —— 因为测试可以自己启动
loopback control plane,而守卫只拦非 loopback —— 第二个测试可以针对它端到端地驱动
该工具。那一层以下的一切(`sendMeshHandoff`、fail-closed 预检、`not-delivered | unknown | failed`
分诊)已由 `mesh.test.ts` 通过 `fakeDeps` 覆盖,而本次改动不触碰它。
把「该不该建」与「怎么测」混为一谈,正是本段要防止的错误:已部署引擎不可触碰
是一条关于*污染*的规则,不是扣下一个工具的理由。排除它还会留下一个能到达本机
但到不了 mesh 的只发送宿主,那与发布 send 却不发布 list 是同一种半成品方案。

`--no-preflight` 有意**不**作为工具参数暴露:它是给人工调试引擎用的 escape
hatch,模型不该去够它。

接收在 out of scope:没有 inbox、没有 `xfer_inbox`、没有 `--on-handoff`。投递到
非 pi agent 的 context 是条目 5,已被拒绝。
非 pi agent 的 context 是条目 5,已被拒绝。

### 发现需要一个新的子命令

`xfer-adapterd` 今天有 `up`、`send`、`mesh send`、`inbox take|list`、`install` —— 从 CLI **没有
任何办法列出 peer**。`/xfer list` 是 pi 的命令。所以一个只发送的 gateway
会让它的宿主仍需要 shell 才能找到目标,而这正是该特性要解决的一半问题。

`xfer-adapterd list [--dir D] [--json]` 打印 `~/.pi/xfer/*.sock` 兄弟节点及其
元数据,复用 `targets.ts` 的 `listTargets`(纯 `fs`,不依赖 pi —— 可从 adapter bundle
import)。`--json` 时每个目标一行 JSON,供机器消费。这也改善了 skill 路径,它今天
让宿主手动读目录。

### 身份:`--name` 必需,绝不推导

gateway 必须带 `--name` 启动。没有默认值、没有 cwd 推导 —— 推导出的名字
会冲突,而这里的冲突是不可见的:只发送的 gateway 不 bind 任何东西,所以
`claimEndpoint` 抓不到它,而它现在能抓到重复的 daemon。`xfer-adapterd
install` 生成它今天已经生成的名字,所以正常安装天然正确。

如果用户坚持要一个共享名字,`phase4-design-p2-p5.md` 的盖戳缓解措施适用:
用现有的 `stampDocument` 接缝在文档里标记调用方 agent。

## 无新构建产物

gateway 不从本仓库 import 任何东西 —— 它是已安装 `xfer-adapterd` 的薄封装 —— 所以它
可以是一个提交的单文件,没有打包步骤,与
`broker-conn-module.test.js` / `page-tools-module.test.js` 的先例并列。AGENTS.md 的四个
构建产物不变。`xfer-adapterd list` 加在既有 bundle 内部,所以
`xfer-adapterd.cjs` 及其 `.sha256` 照常重建。

这个选择的代价:纯 `.mjs` 没有类型检查。接受 —— 文件小、无仓库
import、有测试覆盖。

## 改动

```diff
  // adapterd.src/main.ts — discovery for hosts that cannot read a directory
  xfer-adapterd list [--dir D] [--json]

  // mcp-gateway.mjs  (new, stdio MCP server, no repo imports)
    tools: xfer_send       { target, summary, document, kind }
           xfer_mesh_send { target, summary, document, kind }
           xfer_list      { }
    argv:  xfer-adapterd send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>
           xfer-adapterd mesh send <target> <tmpfile> <summary> --kind <kind> --from <name> --dir <dir>
           xfer-adapterd list --json --dir <dir>
    flags: --name <n>  (required)   --dir <d>   --xfer-adapterd <path> (tests)
    stdout: JSON-RPC frames only — every diagnostic goes to stderr

  // adapterd.src/main.ts — accept an inline document on send
  - send <target> <file> <summary> --kind <k>
  + send <target> <file|-> <summary> --kind <k>
```

gateway 自己把 handoff 文档写入临时文件,与 `xfer_to` 在
`index.ts:107` 的做法完全相同,并传入该路径。

## 涉及范围

| 文件 | 改动 |
|---|---|
| `mcp-gateway.mjs`(新增) | stdio MCP server;为测试注入 exec 接缝 |
| `mcp-gateway.test.ts`(新增) | JSON-RPC 握手、工具 schema、argv 构造、stdout 纯净性 |
| `adapterd.src/main.ts` | `list` 子命令;`send` 接受 `-` 表示从 stdin 读文档 |
| `adapterd.src/daemon.ts` | 不变 |
| `adapterd.test.ts` | `list` 和 `send -` 的用例 |
| `xfer-adapterd.cjs`、`.sha256` | 由 `npm run build` 重建 |
| `skills/xfer-agent/SKILL.md` | 提及 gateway 作为 CLI 的替代;指向 `xfer-adapterd list` |
| `CONTRIBUTING.md` | 不变 |

未触碰:`index.ts`、`controller.ts`、`server.ts`、`client.ts`、任何 mesh 相关、
`commands.ts` 中任何内容。

## 风险

1. **stdout 污染会破坏 MCP session。** 一个往 stdout 多打一行的 MCP server
   会破坏协议,而失败看起来像客户端坏了,而不是 server 坏了。这是该文件里最可能的
   bug;测试断言 stdout 只承载 frame,别无其他,包括错误路径。
2. **只发送的宿主在 `/xfer list` 中不可见。** 上面已说明;对习惯了在那里看到宿主的人
   这是行为变化,文档必须说明:只有当某物为它 bind socket(`xfer-adapterd up`)时,
   宿主才会出现。
3. **重名是静默的。** 没有 socket 就没有 `claimEndpoint` 检查。install 生成的名字
   避免了它;手写 `--name` 的冲突由用户自己管理。
4. **没有接收。** 采用 gateway 的宿主仍然只能*发送*。任何期待
   入站投递的东西都会一无所获,skill 不得暗示相反。
5. **gateway 给了模型通往引擎的第二条路径。** `xfer_mesh_send` 很薄,而
   它下面的层已测试,所以这不是正确性风险 —— 而是暴露面风险,由三条规则约束:
   `--no-preflight` 未暴露,所以模型无法关闭 fail-closed 检查;守卫会为测试树 spawn 的任何进程
   拦截已部署引擎,gateway 也不例外;loopback 覆盖意味着这条路径被真实地跑过,
   而不是只在 argv 上断言。
6. **`.mjs` 无类型。** 参数形状没有编译期检查;测试承担那份重量。

## 验证

- `npm test` 全绿 —— 567 个测试,566 通过,1 跳过,0 失败。包括对 `mcp-gateway.mjs` 的真实
  stdio JSON-RPC 握手(`initialize`、`tools/list`、`tools/call`);stdout 纯净性
  (含错误路径);一个通过 `--xfer-adapterd` 注入的 stub `xfer-adapterd`,为**全部三个工具**
  断言确切的 argv,使 CLI flag 的变化无法与工具 schema 静默分叉;以及每个 outcome 都断言
  在 ADR-0020 的四个取值之内,并有测试在出现第五个时失败。
- **密封,而且屏障是结构性的,不是一条要记住的规则。** `node --test`
  设置 `NODE_TEST_CONTEXT`,该环境被每个后代继承,而
  `mesh-guard.ts` 从两个出站面拒绝任何非 loopback 端点。所以规则是
  精确的,值得精确说明:
  - **允许:** `fakeDeps` stub,以及测试自己在 loopback 上启动的 control plane ——
    `{"endpoint": "http://127.0.0.1:6420"}`。所以测试可以针对 loopback 引擎端到端地驱动
    `xfer_mesh_send`,而且应该这么做:只覆盖 argv 会让 join 和预检路径
    未被新文件实际跑过。
  - **禁止:** 真实 `~/.pi/xfer/mesh.config.json` 中点名的端点、隧道或中继,
    以及任何需要其 token 的东西。不是因为它是测试 —— 而是因为它是*某人的部署*,
    而一次误入的 enqueue 会在上面留下痕迹。
- **相对本计划的缺口。** loopback 端到端 mesh 测试已写好,但
  `t.skip`ped,通过 `XFER_ENGINE_BINARY` opt-in。两个阻塞点,只有一个仍然成立:
  - *已解决。* 与本机自己的引擎共存**是**可能的 —— `guard.port` 是它自己的
    key,而不是从 `api_peer.port` 推导,`XDG_DATA_HOME` 能搬走数据库
    (没有配置键可做到)。配方,以及那些看起来像引擎坏了的近似失误,
    在 verify skill 里。
  - *仍成立。* 引擎 2.3.26 拒绝 `ensureRunnerPool` 的
    `{"datacenters":{"default":{"normal":{}}}}`,报 `no variant of enum RunnerConfigKind`,
    所以 loopback 引擎能提供读服务,却无法托管一个可供发送*到*的节点。在上游修好之前,
    真正的 enqueue 无法在 loopback 上驱动。不要把被跳过的测试读成
    通过的覆盖。
  那一层以下的一切(`sendMeshHandoff`、fail-closed 预检、
  `not-delivered | unknown | failed` 分诊)仍由 `mesh.test.ts` 通过 `fakeDeps` 覆盖,
  而本次改动不触碰它。
- 每个测试都把 `--dir` 指向一个新的 `os.tmpdir()`。
- **对真实引擎的冒烟仍然是人的决定**,按 AGENTS.md —— 而且它能带来的、loopback 测试带不来的东西
  很少,所以只有在 loopback 路径全绿之后才值得去请求。
- 人工冒烟,仅本地,2026-10-19:对一个一次性 `xfer-adapterd.cjs` 做真实 stdio 握手 ——
  `initialize` ok,`xfer_list` 返回带元数据的 peer,
  `xfer_send` 返回 `{handoff_id, outcome: "delivered"}`,而 peer 的 inbox 显示了
  正确的 `from` 和正确盖戳的 `kind`。
