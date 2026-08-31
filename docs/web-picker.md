# Web Picker userscript — install, verify, troubleshoot

`web-picker.user.js` is a Tampermonkey userscript that gives the xfer broker a
page side:

- **Pick / note core** — hover-pick elements, batch notes, per-item delete
  (the old CDP-injected flow, rewritten for the broker).
- **Send flow** — a prompt plus the picked annotations, delivered as an xfer
  handoff into a local pi session (`annotation.submit` → `ack`).
- **Reverse channel** — agent questions arrive as `page.request` frames and
  surface as an in-page ask modal; your answer goes back as `page.response`.

Wire protocol: **v0, localhost-trust (no token)**. Every frame carries
`{v, type}`; every request gets exactly one reply. The userscript builds all
frames through a single `PROTOCOL` section — the broker mirrors it (frame
shapes below match `mock-broker.mjs`, `.pi/wayfinder/prototypes/`).

| Direction | Frame | Shape |
|-----------|-------|-------|
| page → broker | `annotation.submit` | `{id, page, picks, prompt, target:{namespace:"local", name}}` |
| page → broker | `targets.list` | `{id}` |
| broker → page | `page.request` | `{id, handoff_id, from, kind:"question", text, timeoutMs}` |
| page → broker | `page.response` | `{id, ok:true, text}` / `{id, ok:false, error}` |

---

## Install (Tampermonkey)

1. Open Tampermonkey → Dashboard → **+** (Create a new script).
2. Replace the editor content with the **entire contents of `web-picker.user.js`**
   and save (Ctrl/Cmd+S).
3. Reload any page — a round fab appears near the bottom-right corner.

| Shortcut | Action |
|----------|--------|
| ⇧⌥P | enter / exit pick mode |
| ⇧⌥L | toggle the note panel (send box inside) |

The fab's top-left dot is the broker status: grey = off, amber = connecting,
green = connected.

> The script only ever talks to `127.0.0.1` (`@connect` header). Nothing is
> sent anywhere until you explicitly connect the broker and click 发送.

## Start the broker

```bash
/xfer broker start     # daemon on ws://127.0.0.1:4719/ws — survives session exit
/xfer broker status    # alive? how many tabs are connected
/xfer broker logs      # recent daemon output
/xfer broker stop      # pid ladder (SIGTERM → ~2s → SIGKILL)
```

State lives in `~/.pi/xfer/broker.{pid,json}` + `broker.log`. Starting when one
is already running (pid alive) reports "already running" and exits 0. If the
configured port is held by a *foreign* program (no live broker pid), the daemon
warns and falls back to an ephemeral port — `/xfer broker start` toasts the
actual port, and it is always recorded in `broker.json`.

Until the `/xfer broker` command group is wired you can run the daemon
directly: `node pi/agent/extensions/xfer/broker-main.ts`. For the reverse
channel round trip, the prototype broker is the working oracle today:
`node .pi/wayfinder/prototypes/mock-broker.mjs` (stdin `ask <question>`).

## Verify

1. **Connect** — grey dot → 连接设置… → confirm `ws://127.0.0.1:4719` →
   保存并连接. The dot turns green ("broker 已连接").
2. **Pick** — ⇧⌥P, hover elements, ⇧⌥L for the panel, edit / delete notes.
3. **Send** — pick a few elements, write a prompt, choose the target session in
   the dropdown (⟳ refreshes), 发送 → the toast shows the `handoff_id` and the
   target session receives a `📨 [Xfer from web-picker]` handoff.
4. **Ask-page round trip** — with the mock broker, type `ask <question>` on its
   stdin → the page shows the ask modal (question + from/handoff meta) → answer
   and press Enter (or 回复) → the broker prints `[page.response …] ok=true`
   (the real broker additionally pushes your answer as a notify into the asking
   session). Dismiss paths: 忽略 button or Esc → `ok=false error:"dismissed"`.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Connect fails, dot stays grey | Broker not running — `/xfer broker start`; or the URL in 连接设置 is wrong. Health check: `curl http://127.0.0.1:<port>/status`（端口以 `/xfer broker status` 为准，fallback 后不是 4719）. |
| Port 4719 occupied by another program | The daemon falls back to an ephemeral port and warns: the start toast / `/xfer broker status` / `broker.json` show the real port — set that URL in 连接设置 (the failure toast links there). For a stable address either free the port or pin a custom one once and for all: `/xfer broker start --port N`（0 = 临时端口）. `pid` alive in broker.pid means it's our own broker → "already running", no fallback — and the pid (not the port) decides, so a live broker is never duplicated no matter what port you pass. |
| Dropdown shows （无活跃 local session） | No listening session: targets come from `~/.pi/xfer/*.sock`. Start a pi session with xfer loaded (its `.sock` appears), then ⟳. Not connected at all → the dropdown shows （未连接 broker） instead. |
| https page won't connect | ws to `127.0.0.1` is loopback-exempt from mixed-content blocking in Chromium, and Tampermonkey's `@connect 127.0.0.1` covers the request — https pages normally work. If a page still refuses, trial on a non-https page or double-check the URL is exactly `ws://127.0.0.1:4719` (not `wss://`, not `http://`). |
| After a broker restart the dot stays grey | **Reconnect is manual only** — the userscript never auto-reconnects. Click the status row / Tampermonkey menu → 连接, or re-save 连接设置. |

> The ask modal and pick mode are mutually exclusive: opening one dismisses the
> other, so an open question is always answered (or `dismissed`) rather than
> left hanging.
