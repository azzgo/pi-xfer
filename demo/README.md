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
| 1 | 0–10s | split-screen handoff arrival | `capture/capture-shot1.mjs` → VHS | two real interactive `pi` sessions; alpha runs `/xfer beta …` and the handoff really lands in beta's TUI |
| 2 | 10–26s | web picker | `capture/capture-shot2.mjs` → Playwright + VHS | real broker daemon, real userscript picks, real `annotation.submit` delivered to a real pi session |
| 3 | 26–48s | admin console | `capture/capture-shot3.mjs` → Playwright | real admin daemon; real handoff deliveries, gc and broker control while recording |
| 4 | 48–66s | mesh principle animation | `composition/index.html` (GSAP) | narrative, no screen data |
| 5 | 66–76s | outro | `composition/index.html` | — |

## Shot 1 is a real TUI, and it is cut after the fact

Two genuine `pi` sessions run inside VHS — VHS drives a real terminal, so what
lands on screen is the actual interface: input box, streaming output, tool-call
blocks, spinner, colours, the `📡 alpha` / `📡 beta` status line. Alpha runs
`/xfer beta …`, the model composes a document and delivers it over beta's
socket, and beta's session really receives `📨 [Xfer from **alpha**]`.

The model call takes as long as it takes, so the cut happens afterwards
(`capture/lib/retime.mjs`) against events measured from the sessions' own logs:

- **Where each recording starts.** The tape's first visible frame is its launch
  command, and the first frame carrying any ink is found with `ffmpeg`
  `signalstats`. A `touch` marker hidden in the tape's setup line gives a
  wall-clock reading from inside the recording. Together those pin the recording
  to the wall clock, so a real event can be placed on it without guessing how
  long VHS took to boot.
- **Which moments matter.** Three come straight from the session JSONL: the
  `/xfer` tool result (`handoff_id` — language-independent, unlike the model's
  prose), the assistant line that confirms it, and beta's `xfer-inbound`
  `custom_message`. Sender and receiver are told apart by which session
  received, so a reply can never be mistaken for the original send.
- **The wait.** Alpha waits twice — for the model to compose the doc, then to
  write its confirmation. Both are compressed into short, busy beats
  (`setpts`) rather than cut away, and it is the confirmation that is lined up
  with beta's arrival: both land at 6.2s in the finished clips.

Alpha's own task is deliberately self-contained, and the request says to answer
in-session. Ask either for something and the shot picks up a failed file
lookup, or beta hands the answer back over xfer and a one-way shot becomes a
two-way exchange.

The raw takes stay in `demo/out/shot1`, so `node capture-shot1.mjs --recut`
re-cuts both clips from the last recording without paying for model calls again.

Both sessions run under an isolated `HOME` that carries only credentials,
models and `quietStartup: "header"`. That keeps the startup package-update
notice and the model-scope list out of frame, and gives the two peers their own
`~/.pi/xfer` instead of registering on the real machine.

## Shot 2's terminal is a replay

`capture/lib/vhs.mjs` also builds a stub `pi`/`tail` executable, puts the stub
directory first on `PATH` and has VHS type the real command and press Enter.
Shot 2's terminal shows real broker and peer log lines that the stub prints on a
schedule, so nothing can appear before the event it belongs to.

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
    lib/vhs.mjs          tape builder: real-TUI tapes + stub replay
    lib/retime.mjs       cut a long real-time take into the finished shot
    capture-shot{1,2,3}.mjs
  page/index.html        local demo page the web picker operates on
  composition/           HyperFrames project (timeline, captions, animation)
  out/                   capture artifacts (gitignored)
  pi-xfer-demo.mp4       final product (committed)
```

Pacing, captions and shot order live in `composition/index.html` — edit one
line, run `node demo/build.mjs --compose`, get a new cut.
