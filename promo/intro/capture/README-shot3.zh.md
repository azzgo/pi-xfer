> 中文版 · 英文原文：[README-shot3.md](README-shot3.md)

# 镜头 3 — Admin console 录制

完全代码驱动的 xfer Admin web console 录制：Playwright 录下 dashboard，同时真实事件在一次
连续拍摄中发生。

## 运行

```sh
# one-time: playwright library in /tmp scratch (no repo dependency)
mkdir -p /tmp/pi-xfer-shot3-pw && cd /tmp/pi-xfer-shot3-pw
npm init -y && npm install playwright@1.55.0

cd <repo root>
node demo/capture/capture-shot3.mjs
```

输出落在 `demo/out/shot3/`：

| 文件 | 内容 |
|---|---|
| `admin.webm` | 录制本身（1280x720，一次连续拍摄） |
| `admin.log`  | 真实 admin daemon 的 stdout/stderr |
| `beta.log`   | 接收方 pi 会话（投递时包含 `📨 [Xfer from`） |
| `alpha.log`  | 发送方 pi 会话（真实模型，真实 `xfer_to`） |

## 什么是真实的

- **Admin daemon** — 直接 spawn `admin-main.ts`（与 `admin-manager.ts` 使用的同一次调用，
  `--port 0` 临时端口；端口从 `admin.json` 读取）。
- **Handoff** — 一个无头接收方（`pi --mode rpc --xfer demo-beta`，位于 fifo 之后）注册
  `demo-beta.sock`；一个一次性发送方
  （`pi --xfer demo-alpha -p 'Send a one-way handoff to demo-beta …'`）做一次真实模型调用，
  并通过真实 `xfer_to` 投递。
- **控制按钮** — 对 `/control` 的真实 Playwright 点击：`run gc`、broker `stop`、broker
  `start`（`admin-server` 里的 POST 路由）。
- **Board** — 拍摄中途把一个真实卡片 `.md` 写入 `~/.pi/xfer/board`，于是 board watcher
  触发，board 统计在刷新时变化。
- **实时流** — SSE（`/sse`）；peer 上线/下线、gc、broker 与 board 事件都会实时出现在
  dashboard 的流里。

## 清理

脚本是幂等且自清理的：入口处杀掉残留的 demo 进程；退出时向 admin daemon 发 SIGTERM
（解除链接 `admin.pid` / `admin.json`），杀掉接收方 pi + `tail -f`，删除 fifo，并把 broker
恢复成录制前的状态（如果之前没在运行，就再次停掉）。若有残留，手工扫一遍：

```sh
pkill -f "xfer demo-beta"; pkill -f "xfer demo-alpha"; pkill -f "admin-main.ts --port 0"
```

## 注意事项

- 使用真实的 `~/.pi/xfer`（真实 socket，真实模型调用 → 花一次请求；发送方可能耗时 30–90 s，
  因此拍摄约 40–120 s）。
- `run gc` 会真正回收 `~/.pi/xfer` 里已死的 peer socket——与手动点按钮一样。
- 写入 board 的那张卡会留在那里（board 只追加）；如不需要，删除 `demo/out` 同级的
  `shot3-*` 卡片文件。
