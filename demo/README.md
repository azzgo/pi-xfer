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
## Shots

| # | Time | Content | Produced by | Real data source |
|---|---|---|---|---|
| 1 | 0–10s | split-screen handoff arrival | `capture/capture-shot1.mjs` → VHS | `pi --xfer alpha -p` sends a real handoff; `pi --mode rpc --xfer beta` receives it; the exact output lines are replayed into VHS terminals |
| 2 | 10–26s | web picker | `capture/capture-shot2.mjs` → Playwright + VHS | real broker daemon, real userscript picks, real `annotation.submit` delivered to a real pi session |
| 3 | 26–48s | admin console | `capture/capture-shot3.mjs` → Playwright | real admin daemon; real handoff deliveries, gc and broker control while recording |
| 4 | 48–66s | mesh principle animation | `composition/index.html` (GSAP) | narrative, no screen data |
| 5 | 66–76s | outro | `composition/index.html` | — |

## Terminal shots are replays, not recordings

`capture/lib/vhs.mjs` builds every terminal tape the same way. The capture run
first produces the real output, then writes a stub `pi`/`tail` executable that
replays those exact lines on a schedule, puts the stub directory first on `PATH`
and has VHS type the real command line and press Enter.

That gives three properties the demo depends on:

- the command line is genuinely typed and is the first thing on screen — no pi
  startup banner, no model list, no interactive TUI swallowing the replay;
- output cannot appear before the event it belongs to, because the stub decides
  when each chunk prints;
- terminal geometry is known (880x700 for shot 1, 800x840 for shot 2), so the
  composition can frame it without cropping.

## Two layers, one rule

Screen slots in `composition/index.html` carry each asset's true aspect ratio and
fill with `object-fit: contain`. A recording is therefore never cropped — if an
asset ever changes shape the only consequence is background, never a cut edge.
Slot background matches the footage's own background so any gap is invisible.

`build.mjs` also refuses to render when a capture is shorter than the slot the
composition plays it for, since a frozen last frame reads as a bug in the cut.

## Shot 2 is cut on the browser video's clock

The browser recording starts when Playwright starts recording, which is not the
same instant the capture script begins pacing. After the video is written,
`capture-shot2.mjs` re-derives its origin from the file's real duration and
re-expresses the submit / broker-ack / peer-receipt timestamps in video time
(`demo/out/shot2/timing.json`). The terminal tape is built against those, so the
right pane cannot show a delivery before the left pane submitted.

## Layout

```
demo/
  build.mjs              orchestrator: capture → collect → verify → render → compress
  capture/
    lib/vhs.mjs          shared tape builder: stub replay, theme, timing
    capture-shot{1,2,3}.mjs
  page/index.html        local demo page the web picker operates on
  composition/           HyperFrames project (timeline, captions, animation)
  out/                   capture artifacts (gitignored)
  pi-xfer-demo.mp4       final product (committed)
```

Pacing, captions and shot order live in `composition/index.html` — edit one
line, run `node demo/build.mjs --compose`, get a new cut.
