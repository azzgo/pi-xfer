# Demo — fully automated production pipeline

Every frame of `pi-xfer-demo.mp4` is produced by code in this directory. No
manual screen recording. All data visible in the video is **real**: real headless
pi sessions, real handoff deliveries through real sockets, a real broker, a real
admin daemon. VHS/Playwright/HyperFrames are presentation only.

## Toolchain

| Tool | Role | Invoke |
|---|---|---|
| [VHS](https://github.com/charmbracelet/vhs) (brew, incl. ttyd) | terminal footage from `.tape` files | `vhs x.tape` |
| Playwright (chromium) | browser footage (web picker, admin console) | `npx playwright@1.55` (installed under `demo/capture/`) |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | shot-4 animation, timeline composite, captions, final MP4 | `npx hyperframes@0.8.149` |
| ffmpeg | final <10MB 720p compress | system |

None of these are runtime dependencies of the extension.

## One command

```sh
brew install vhs ffmpeg        # once
node demo/build.mjs            # capture everything, render, compress
node demo/build.mjs --compose  # reuse demo/out captures, re-render only
```

Output: `demo/pi-xfer-demo.mp4` (~76s, silent, 1280x720, GitHub-friendly).

## Shots

| # | Time | Content | Produced by | Real data source |
|---|---|---|---|---|
| 1 | 0–10s | split-screen handoff arrival | `capture/capture-shot1.mjs` → VHS | `pi --xfer alpha -p` sends a real handoff; `pi --mode rpc --xfer beta` receives it; the exact output lines are replayed into VHS terminals |
| 2 | 10–26s | web picker | `capture/capture-shot2.mjs` → Playwright + VHS | real broker daemon, real userscript picks, real `annotation.submit` delivered to a real pi session |
| 3 | 26–48s | admin console | `capture/capture-shot3.mjs` → Playwright | real admin daemon; real handoff deliveries, gc and broker control while recording |
| 4 | 48–66s | mesh principle animation | `composition/index.html` (GSAP) | narrative, no screen data |
| 5 | 66–76s | outro | `composition/index.html` | — |

## Layout

```
demo/
  build.mjs              orchestrator: capture → collect assets → render → compress
  capture/               per-shot capture scripts + notes (see README-shot*.md)
  page/index.html        local demo page the web picker operates on
  composition/           HyperFrames project (timeline, captions, animation)
  out/                   capture artifacts (gitignored)
  pi-xfer-demo.mp4       final product (committed)
```

Pacing, captions and shot order live in `composition/index.html` — edit one
line, run `node demo/build.mjs --compose`, get a new cut.
