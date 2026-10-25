> 中文版 · 英文原文：[phase2-design-p1d.md](phase2-design-p1d.md)

# Milestone 2 design — P1-D handoff 的 cwd 锚定

## 决定(2026-10-13)

发送方机械式写入 + 信封指示;接收方不强制。消费方的答复(refine)已纳入:
跨机时降级为项目/机器锚点;指示放在信封文本里,锚点写在 doc 里。

## 当前机制(已验证)

- `index.ts` 的 `xfer_to` execute 把 doc 写到 `os.tmpdir()/pi-xfer-<mid>.md` 并发送
  一条 `xfer-notify`;`xfer_mesh_to` 则通过 mesh 内联发送文档。
- 两条入站传输(本地 socket、mesh)都汇入 `controller.ts
  `deliverInbound()``,由它构建 `📨 [Xfer from …]` 信封。web-picker 发送方
  在那里已被特殊处理。
- 发送进程知道自己的 cwd(`process.cwd()`)和机器(`os.hostname()`)。

## 计划

### 1. Doc 锚点(发送方,`index.ts` 两个工具)

- 在写入/发送之前,向 doc 顶部插入一行:
  `<!-- xfer:sender-cwd cwd=<abs-path> project=<basename> machine=<host> branch=<git-branch?> -->`
- `branch` 从 `<cwd>/.git/HEAD` 读取(读文件,不起子进程);不存在时省略
  (非 git 或跨机无法解析)。`machine`/`project` 始终存在 —— 当 `cwd` 在本地不存在时
  (同一 repo 的 worktree 位于不同路径),它们就是跨机锚点。
- 源自 web-picker 的 doc(`handoff-doc.ts`)不加锚点 —— 那里的「发送方」是浏览器,
  而不是工作目录;信封对这些内容本来就有不同的引导方式。

### 2. 信封指示(`controller.ts deliverInbound`)

- 对 agent 发送方,在 Doc 行之后加上:
  `**Sender cwd**: \`/path\` (project X on machine Y) — make all file edits here unless the
  doc says otherwise.`
- 若发送方不是本机(mesh,未知主机),同一行追加:"if that path does
  not exist on this machine, locate the project (and worktree/branch if given) before
  editing — ask the user only if ambiguous."

### 3. Mesh 内联路径

`xfer_mesh_to` 以同样方式给内联文档加锚点,这样解析原始 doc 的 mesh 接收方
即使读的是无文件的内联正文,也能看到锚点。

## 涉及范围

`index.ts`(两个工具的 execute:锚点辅助函数)、`controller.ts`(信封)、一个小的纯
辅助函数(锚点格式化 + 读 `.git/HEAD`)及其单元测试;文档:若存在
`docs/dev` 的 handoff 工作流说明,则补一行。

## 风险
## 风险

- 测试夹具必须使用合成路径(例如 `/tmp/proj`、假主机名)—— 锚点
  本身只是运行时数据,永不进入仓库,所以推送前的个人路径守卫在此不是问题;
  密封测试本来就是既定规则。
- 接收方可能把这个注释当作不可见(选 HTML 注释是为了渲染干净;
  信封里的那一行才是权威指示)。
- 按设计不做强制 —— 仍然可能出现错误 cwd 的编辑;接受这一点(发现和回滚
  都便宜;若上线后反复出现再重新考虑)。
