# Intro: pi-xfer

The 76-second overview cut, published on YouTube:
<https://youtu.be/0mm2CirJMUo>.

Every frame is produced by code in this directory. No manual screen recording.
All data visible in the video is **real**: real pi sessions, real handoff
deliveries over real sockets, a real broker, a real admin daemon. VHS,
Playwright and HyperFrames are presentation only.

See [`../README.md`](../README.md) for how this directory fits into `promo/`.

## Toolchain

| Tool | Role | Invoke |
|---|---|---|
| [VHS](https://github.com/charmbracelet/vhs) (brew, incl. ttyd) | terminal footage from `.tape` files | `vhs x.tape` |
| Playwright (chromium) | browser footage (web picker, admin console) | installed under `capture/` |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | shot-4 animation, timeline composite, captions, final MP4 | `npx hyperframes@0.8.149` |
| ffmpeg | audio encode, BGM synthesis, final 720p compress | system |

None of these are runtime dependencies of the extension.

## One command

```sh
brew install vhs ffmpeg        # once
node promo/intro/build.mjs      # capture everything, render, compress
node promo/intro/build.mjs --compose   # reuse out/ captures, re-render only
```

Products, both gitignored:

- `pi-xfer-intro.mp4` — 76s, 1280x720, under 2 MB, with a music bed.
- `pi-xfer-intro-poster.png` — a frame of it, for the README.

## Nothing binary is tracked

This repository tracks no binary media, stills included. Everything this
directory produces is a local build output:

- **`pi-xfer-intro.mp4`** — the cut itself. Not tracked; published on YouTube,
  and the top-level README links there.
- **`composition/assets/bgm.m4a`** — the music bed. Not tracked, and nothing is
  downloaded: `capture/lib/bgm.mjs` synthesizes it on demand, so a fresh clone
  runs the build and gets an identical track. It is written by this repository,
  so there is no third-party licence to carry or attribute.

Poster frames are not tracked either — the README links straight to YouTube, so
the poster is purely a local convenience.

HyperFrames render intermediates (`composition/renders/`) and Playwright/VHS
capture output (`out/`) are ignored as well.

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

The raw takes stay in `out/shot1`, so `node capture-shot1.mjs --recut` re-cuts
both clips from the last recording without paying for model calls again.

Both sessions run under an isolated `HOME` that carries only credentials,
models and `quietStartup: "header"`. That keeps the startup package-update
notice and the model-scope list out of frame, and gives the two peers their own
`~/.pi/xfer` instead of registering alpha/beta on the real machine.

## Shot 2's terminal is a replay

`capture/lib/vhs.mjs` builds a stub `pi`/`tail` executable, puts the stub
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
(`out/shot2/timing.json`). The terminal tape is built against those, so the
right pane cannot show a delivery before the left pane submitted.

## Layout

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

Pacing, captions and shot order live in `composition/index.html` — edit one
line, run `node promo/intro/build.mjs --compose`, get a new cut.