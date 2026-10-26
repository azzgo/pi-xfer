# Shot 2 — web picker capture
[简体中文](README-shot2.zh.md)

Code-driven capture of the browser → handoff flow. Everything shown is real:

- a **real broker daemon** (`broker-main.ts`) on the receiver's isolated xfer dir
- a **real headless receiver pi session** (`pi --mode rpc --xfer pickerdemo`,
  isolated `HOME`, extension loaded via `-e <repo>/index.ts`)
- the **real built userscript** (`web-picker.user.js`) injected with minimal GM_*
  shims, driven through its own connect / pick / note / send code paths
- a real `annotation.submit` → broker → peer delivery, verified by the peer rpc
  log containing `📨 [Xfer from`

## Run

```sh
cd demo/capture && npm install   # pins playwright@1.59 (matches cached chromium-1217)
node capture-shot2.mjs
```

Outputs in `demo/out/shot2/`:

| File | What |
|---|---|
| `page.webm` | browser recording (1280×720): demo page, 3 picks with notes, send |
| `terminal.mp4` | VHS terminal: the real broker log lines + the peer's 📨 arrival |
| `logs/` | broker + peer rpc raw logs (evidence of the real delivery) |
| `tape-shot2.tape` | generated VHS tape (replays real log lines, never invented ones) |

`demo/page/index.html` is the local static page the picker operates on
(a fake "Nimbus Notes" pricing page). All processes (broker, pi session, static
server, browser) are cleaned up by the script itself.
