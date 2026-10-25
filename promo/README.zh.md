> 中文版 · 英文原文：[README.md](README.md)

# promo — 产品视频

这个目录下的一切都是为了产出关于 pi-xfer 的视频。每个子目录是一个剪辑版本：它的素材录制、
它的合成时间线，以及一个把它们变成 MP4 的 `build.mjs`。

```
promo/
  intro/     "Intro: pi-xfer" — the 76s overview published on YouTube
```

只有源文件入库。每一件媒体产物——MP4、音乐床、封面帧、录制输出——都被 gitignore，并在本地
重建，因此本仓库不携带任何二进制重量。见本目录的 `.gitignore`。

## 每个视频一条命令

```sh
brew install vhs ffmpeg        # once
node promo/intro/build.mjs      # capture everything, render, compress
```

它会打印产物落在哪里；它们被 gitignore，因此只存在于本地。已发布的版本在 YouTube 上——
见顶层 README 的 Demo 一节。

## 添加另一个视频

给它一个按内容命名的同级目录（`web-picker/`、`mesh/`、`admin/`），并给它自己的 `build.mjs`
与合成时间线。

动手之前有两件事值得知道：

- **复制 `intro/capture/lib/`。** 里面有 tape 构建器、重定时器和音乐床合成器。前两个与具体
  镜头无关；合成器接收视频长度并写出相匹配的床。
- **先不要抽公共工具。** 每个剪辑都是镜头特定的——它的时长、字幕和布局都在自己的录制脚本里
  编写。第二个视频多半会想要自己的镜头，而不是第一个的变体。等两个剪辑真的想要同一件东西时
  再抽象，而不是提前。

每个视频自己的目录里都带一份 README，描述它的镜头以及它的数据是怎么产生的。
