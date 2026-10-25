> 中文版 · 英文原文：[README-shot2.md](README-shot2.md)

# 镜头 2 — web picker 录制

代码驱动的浏览器 → handoff 流程录制。展示的一切都是真实的：

- 一个**真实 broker daemon**（`broker-main.ts`），跑在接收方的隔离 xfer 目录上
- 一个**真实的无头接收方 pi 会话**（`pi --mode rpc --xfer pickerdemo`，隔离 `HOME`，
  扩展经 `-e <repo>/index.ts` 加载）
- **真实的已构建用户脚本**（`web-picker.user.js`），以最小 GM_* shim 注入，并走它自己的
  connect / pick / note / send 代码路径
- 一次真实的 `annotation.submit` → broker → peer 投递，由 peer rpc 日志中的
  `📨 [Xfer from` 证明

## 运行

```sh
cd demo/capture && npm install   # pins playwright@1.59 (matches cached chromium-1217)
node capture-shot2.mjs
```

输出在 `demo/out/shot2/`：

| 文件 | 内容 |
|---|---|
| `page.webm` | 浏览器录制（1280×720）：demo 页面、3 个带备注的 pick、发送 |
| `terminal.mp4` | VHS 终端：真实 broker 日志行 + peer 的 📨 抵达 |
| `logs/` | broker + peer rpc 原始日志（真实投递的证据） |
| `tape-shot2.tape` | 生成的 VHS tape（重放真实日志行，绝不编造） |

`demo/page/index.html` 是 picker 操作的本地静态页（一个假的 "Nimbus Notes" 定价页）。所有
进程（broker、pi 会话、静态服务器、浏览器）都由脚本自行清理。
