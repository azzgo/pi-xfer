> 中文版 · 英文原文：[README.md](README.md)

# Intro: pi-xfer

76 秒的总览剪辑，发布在 YouTube 上：
<https://youtu.be/0mm2CirJMUo>。

每一帧都由本目录里的代码产出。没有手工录屏。视频中可见的所有数据都是**真实的**：真实的 pi
会话、经真实 socket 的真实 handoff 投递、真实的 broker、真实的 admin daemon。VHS、
Playwright 和 HyperFrames 只负责呈现。

关于本目录如何嵌在 `promo/` 里，见 [`../README.zh.md`](../README.zh.md)。

## 工具链

| 工具 | 作用 | 调用 |
|---|---|---|
| [VHS](https://github.com/charmbracelet/vhs)（brew，含 ttyd） | 从 `.tape` 文件产出终端画面 | `vhs x.tape` |
| Playwright（chromium） | 浏览器画面（web picker、admin console） | 装在 `capture/` 下 |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | 镜头 4 动画、时间线合成、字幕、最终 MP4 | `npx hyperframes@0.8.149` |
| ffmpeg | 音频编码、BGM 合成、最终 720p 压缩 | 系统自带 |

这些都不是扩展的运行时依赖。

## 一条命令

```sh
brew install vhs ffmpeg        # once
node promo/intro/build.mjs      # capture everything, render, compress
node promo/intro/build.mjs --compose   # reuse out/ captures, re-render only
```

产物，两者都被 gitignore：

- `pi-xfer-intro.mp4` — 76s，1280x720，小于 2 MB，带音乐床。
- `pi-xfer-intro-poster.png` — 它的一帧，给 README 用。

## 不跟踪任何二进制文件

本仓库不跟踪任何二进制媒体，静态图也算在内。本目录产出的一切都是本地构建输出：

- **`pi-xfer-intro.mp4`** — 剪辑本身。不跟踪；发布在 YouTube 上，顶层 README 链接到那里。
- **`composition/assets/bgm.m4a`** — 音乐床。不跟踪，也不下载任何东西：
  `capture/lib/bgm.mjs` 按需合成它，因此一个全新的克隆跑一遍构建就得到完全相同的音轨。它由
  本仓库写出，因此没有需要携带或署名的第三方许可。

封面帧同样不跟踪——README 直接链接到 YouTube，所以封面纯粹是本地便利。

HyperFrames 的渲染中间产物（`composition/renders/`）与 Playwright/VHS 录制输出（`out/`）
也被忽略。

## 镜头

| # | 时间 | 内容 | 由谁产出 | 真实数据来源 |
|---|---|---|---|---|
| 1 | 0–10s | 分屏 handoff 抵达 | `capture/capture-shot1.mjs` → VHS | 两个真实的交互式 `pi` 会话；alpha 运行 `/xfer beta …`，handoff 真的落在 beta 的 TUI 里 |
| 2 | 10–26s | web picker | `capture/capture-shot2.mjs` → Playwright + VHS | 真实 broker daemon、真实用户脚本拾取、真实 `annotation.submit` 投递到真实 pi 会话 |
| 3 | 26–48s | admin console | `capture/capture-shot3.mjs` → Playwright | 真实 admin daemon；录制期间真实的 handoff 投递、gc 与 broker 控制 |
| 4 | 48–66s | mesh 原理动画 | `composition/index.html`（GSAP） | 叙事，无屏幕数据 |
| 5 | 66–76s | 片尾 | `composition/index.html` | — |

## 镜头 1 是真实 TUI，而且是事后剪出来的

两个真正的 `pi` 会话跑在 VHS 里——VHS 驱动真实终端，所以落在屏幕上的是真实界面：输入框、
流式输出、工具调用块、spinner、颜色、`📡 alpha` / `📡 beta` 状态行。Alpha 运行
`/xfer beta …`，模型写出一份文档并通过 beta 的 socket 投递，beta 的会话真的收到
`📨 [Xfer from **alpha**]`。

模型调用要花多久就花多久，所以剪辑发生在之后（`capture/lib/retime.mjs`），依据是从会话
自己的日志里测量出来的事件：

- **每段录制从哪里开始。** tape 的第一帧可见画面是它的启动命令，第一帧带任何墨迹的画面用
  `ffmpeg` 的 `signalstats` 找到。隐藏在 tape 设置行里的一个 `touch` 标记从录制内部给出
  一个墙钟读数。两者一起把录制钉到墙钟上，于是一个真实事件可以被放到它上面，而无需猜测
  VHS 启动花了多久。
- **哪些时刻要紧。** 三个直接来自会话 JSONL：`/xfer` 工具结果（`handoff_id`——与语言无关，
  不像模型的散文）、确认它的那条 assistant 行，以及 beta 的 `xfer-inbound`
  `custom_message`。发送方与接收方靠哪个会话收到来区分，因此回信绝不会被误认成原始发送。
- **等待。** Alpha 等两次——等模型写出文档，等它写出确认。两者都被压缩成短促而忙碌的节拍
  （`setpts`），而不是剪掉，且与 beta 的抵达对齐的正是那条确认：两者都落在成片里的 6.2s。

Alpha 自己的任务刻意是自足的，而且请求里说明要在会话内作答。向任何一方索取东西，镜头就会
拍到一次失败的文件查找，或者 beta 通过 xfer 把答案递回来，单向镜头就变成双向交换。

原始素材留在 `out/shot1`，因此 `node capture-shot1.mjs --recut` 可以从上一次录制重新剪出
两段，而不用再为模型调用付钱。

两个会话都跑在一个隔离的 `HOME` 下，其中只带凭据、模型和 `quietStartup: "header"`。这让
启动时的包更新提示和 model-scope 列表不出现在画面里，并让两个 peer 拥有自己的
`~/.pi/xfer`，而不是在真实机器上注册 alpha/beta。

## 镜头 2 的终端是一次重放

`capture/lib/vhs.mjs` 构建一个桩 `pi`/`tail` 可执行文件，把桩目录放到 `PATH` 最前面，并让
VHS 输入真实命令然后按 Enter。镜头 2 的终端显示的是桩按时间表打印的真实 broker 与 peer
日志行，因此任何东西都不会出现在它所属事件之前。

## 两层，一条规则

`composition/index.html` 里的屏幕槽位携带每个素材的真实宽高比，并以 `object-fit: contain`
填充。因此一段录制永远不会被裁切——如果某个素材的形状变了，唯一的后果是背景，绝不是被切掉
的边。槽位背景与画面自身的背景匹配，因此任何空隙都看不出来。

`build.mjs` 还会在某个录制的长度短于合成把它播放的槽位时拒绝渲染，因为冻住的最后一帧读起来
就像剪辑里的 bug。

## 镜头 2 按浏览器视频的时钟剪

浏览器录制在 Playwright 开始录制时开始，这与录制脚本开始推进的时刻不是同一瞬间。视频写出
之后，`capture-shot2.mjs` 从文件的真实时长重新推导它的原点，并用视频时间重新表达
submit / broker-ack / peer-receipt 的时间戳（`out/shot2/timing.json`）。终端 tape 对着这些
构建，因此右窗格不可能在左窗格提交之前显示投递。

## 布局

```
promo/intro/
  build.mjs              orchestrator: capture → collect → verify → render → compress
  capture/
    lib/vhs.mjs          tape builder: real-TUI tapes + stub replay
    lib/retime.mjs       cut a long real-time take into the finished shot
    lib/bgm.mjs          synthesize the music bed (no third-party audio)
    capture-shot{1,2,3}.mjs
  page/index.html        local demo page the web picker operates on
  composition/           HyperFrames project (timeline, captions, animation)
  out/                   capture artifacts (gitignored)
```

节奏、字幕与镜头顺序都在 `composition/index.html` 里——改一行，跑
`node promo/intro/build.mjs --compose`，得到一个新版剪辑。
