# Shot 3 — Admin console capture
[简体中文](README-shot3.zh.md)

Fully code-driven capture of the xfer Admin web console: Playwright records the
dashboard while real events fire in one continuous take.

## Run

```sh
# one-time: playwright library in /tmp scratch (no repo dependency)
mkdir -p /tmp/pi-xfer-shot3-pw && cd /tmp/pi-xfer-shot3-pw
npm init -y && npm install playwright@1.55.0

cd <repo root>
node demo/capture/capture-shot3.mjs
```

Output lands in `demo/out/shot3/`:

| File | What |
|---|---|
| `admin.webm` | the recording (1280x720, one continuous take) |
| `admin.log`  | real admin daemon stdout/stderr |
| `beta.log`   | receiver pi session (contains `📨 [Xfer from` on delivery) |
| `alpha.log`  | sender pi session (real model, real `xfer_to`) |

## What is real

- **Admin daemon** — `admin-main.ts` spawned directly (same invocation
  `admin-manager.ts` uses, `--port 0` ephemeral; port read from `admin.json`).
- **Handoff** — a headless receiver (`pi --mode rpc --xfer demo-beta` behind a
  fifo) registers `demo-beta.sock`; a one-shot sender
  (`pi --xfer demo-alpha -p 'Send a one-way handoff to demo-beta …'`) makes a
  real model call and delivers via real `xfer_to`.
- **Control buttons** — real Playwright clicks on `/control`: `run gc`,
  broker `stop`, broker `start` (POST routes in `admin-server`).
- **Board** — a real card `.md` written into `~/.pi/xfer/board` mid-take, so
  the board watcher fires and the board stat changes on reload.
- **Live feed** — SSE (`/sse`); peer online/offline, gc, broker, and board
  events all appear live in the dashboard feed.

## Cleanup

The script is idempotent and self-cleaning: leftover demo processes are killed
on entry; on exit the admin daemon is SIGTERM'd (unlinks `admin.pid` /
`admin.json`), the receiver pi + `tail -f` are killed, the fifo is removed, and
the broker is restored to its pre-capture state (stopped again if it was not
running before). Manual sweep if anything is left over:

```sh
pkill -f "xfer demo-beta"; pkill -f "xfer demo-alpha"; pkill -f "admin-main.ts --port 0"
```

## Caveats

- Uses the real `~/.pi/xfer` (real sockets, real model call → costs one
  request; sender can take 30–90 s, so the take runs ~40–120 s).
- `run gc` reclaims genuinely dead peer sockets in `~/.pi/xfer` — same as
  clicking the button by hand.
- The card written to the board stays there (board is append-only); delete
  `demo/out`'s sibling `shot3-*` card file if unwanted.
