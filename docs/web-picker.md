# Xfer Web Picker userscript — install, verify, troubleshoot

`web-picker.user.js` is a Tampermonkey userscript that gives the xfer broker a
page side:

- **Pick / note core** — hover-pick elements, batch notes, per-item delete
  (the old CDP-injected flow, rewritten for the broker).
- **Shift group (v1.5)** — ⇧Enter / ⇧click aggregates elements into a pending
  group (amber dashed marks); Enter opens one shared note for the whole group.
  Members land in the handoff as linked records (optional `group` id field).
- **Send flow** — a prompt (optional — leaving it empty sends a default that
  responds to each pick's note, or explains the element's rendering) plus the
  picked annotations, delivered as an xfer handoff into a local pi session
  (`annotation.submit` → `ack`). ⌘/Ctrl+Enter in the prompt textarea sends.
- **Copy handoff prompt (v1.10)** — the send button is a split button group
  (发送 → + ▾). The ▾ dropdown's **复制 handoff prompt** asks the broker to
  render the exact handoff document a submit would deliver
  (`annotation.compose` → `ack{prompt}` — render only, nothing is written or
  delivered) and copies it to the clipboard. Non-pi coding agents that have
  bash but no xfer can then receive the same handoff: paste the prompt and
  they can call `node broker-main.ts page-tool <target> <op>` for follow-up
  page queries themselves.
- **Page tools (v1.6)** — agent tool calls arrive as `page.request{tool:{op, params}}`
  frames and run against this page: `page.info` · `dom.query` · `dom.html` ·
  `console.logs` · `network.log` · `framework.inspect` (fixed read-only op
  table — no free-form eval, no human modal). The result goes back as
  `page.response{ok:true, text:<JSON>}`. Console and network captures are
  always-on ring buffers (200 entries), so the agent sees pre-request
  history too. The v1.2 ask modal was removed.

Wire protocol: **v0, localhost-trust (no token)**. Every frame carries
`{v, type}`; every request gets exactly one reply. The userscript builds all
frames through a single `PROTOCOL` section — the broker mirrors it (frame
shapes below match `mock-broker.mjs`, `.pi/wayfinder/prototypes/`).

| Direction | Frame | Shape |
|-----------|-------|-------|
| page → broker | `annotation.submit` | `{id, page, picks, prompt, target:{namespace:"local", name}}` |
| page → broker | `annotation.compose` | `{id, page, picks, prompt, target?}` → `ack{result:{prompt:<handoff doc>}}`（只渲染，不落盘不投递） |
| page → broker | `targets.list` | `{id}` |
| broker → page | `page.request` | `{id, handoff_id, from, tool:{op, params?}, timeoutMs}` |
| page → broker | `page.response` | `{id, ok:true, text}` / `{id, ok:false, error}` |

---

## Install (Tampermonkey)

**Easiest** — open the raw URL in a browser with Tampermonkey enabled; the
`.user.js` suffix triggers the install prompt automatically:

<https://raw.githubusercontent.com/azzgo/dotfiles/main/pi/agent/extensions/xfer/web-picker.user.js>

Manual: open Tampermonkey → Dashboard → **+** (Create a new script), replace
the editor content with the **entire contents of `web-picker.user.js`**, save
(Ctrl/Cmd+S). Then reload any page — a round fab appears near the bottom-right
corner.

> Renamed from "PI Web Picker" (v1.5): name change = new script entry in
> Tampermonkey. Delete the old one after installing; its GM storage (broker
> URL, last target) resets once because storage is scoped per script.

| Shortcut | Action |
|----------|--------|
| ⇧⌥P | enter / exit pick mode |
| ⇧⌥L | toggle the note panel (send box inside) |
| ⇧Enter / ⇧click (pick mode) | add / remove the highlighted element to the pending group |
| Enter (with a pending group) | open the group note card → one shared note for all members |
| Enter (no pending group) | pin the highlighted element for a solo note, as before |
| ⌘/Ctrl+Enter (prompt textarea) | send the batch (same as clicking 发送 →) |

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
directly: `node pi/agent/extensions/xfer/broker-main.ts`. Page-tool calls go
through the same daemon (HTTP `/page-tool` + CLI `page-tool`), so no separate
oracle is needed.

## Verify

1. **Connect** — grey dot → 连接设置… → confirm `ws://127.0.0.1:4719` →
   保存并连接. The dot turns green ("broker 已连接").
2. **Pick** — ⇧⌥P, hover elements, ⇧⌥L for the panel, edit / delete notes.
3. **Send** — pick a few elements, write a prompt (or leave it empty: the agent
   gets a default instruction to respond to each pick's note / explain its
   rendering), choose the target session in the dropdown (⟳ refreshes), 发送 →
   the toast shows the `handoff_id` and the target session receives a
   `📨 [Xfer from web-picker]` handoff.
4. **Page-tool round trip** — with the tab connected, from any shell:
   `node pi/agent/extensions/xfer/broker-main.ts page-tool <session-name> page.info`
   → the broker prints the result JSON (`url`, `title`, `viewport`, …). Try
   `dom.query '{"selector":"a","maxCount":3}'` or `console.logs`. The broker log
   shows `[page.request r… ] → 1 tab(s): …` and `[page.response r…] ok=true`.
   A timeout (default 30s, `--timeout-ms` override) or no connected tabs exits 1
   with the error on stderr.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Connect fails, dot stays grey | Broker not running — `/xfer broker start`; or the URL in 连接设置 is wrong. Health check: `curl http://127.0.0.1:<port>/status`（端口以 `/xfer broker status` 为准，fallback 后不是 4719）. |
| Port 4719 occupied by another program | The daemon falls back to an ephemeral port and warns: the start toast / `/xfer broker status` / `broker.json` show the real port — set that URL in 连接设置 (the failure toast links there). For a stable address either free the port or pin a custom one once and for all: `/xfer broker start --port N`（0 = 临时端口）. `pid` alive in broker.pid means it's our own broker → "already running", no fallback — and the pid (not the port) decides, so a live broker is never duplicated no matter what port you pass. |
| Dropdown shows （无活跃 local session） | No listening session: targets come from `~/.pi/xfer/*.sock`. Start a pi session with xfer loaded (its `.sock` appears), then ⟳. Not connected at all → the dropdown shows （未连接 broker） instead. |
| https page won't connect | ws to `127.0.0.1` is loopback-exempt from mixed-content blocking in Chromium, and Tampermonkey's `@connect 127.0.0.1` covers the request — https pages normally work. If a page still refuses, trial on a non-https page or double-check the URL is exactly `ws://127.0.0.1:4719` (not `wss://`, not `http://`). |
| After a broker restart the dot stays grey | **Reconnect is manual only** — the userscript never auto-reconnects. Click the status row / Tampermonkey menu → 连接, or re-save 连接设置. |
| Fab disappears after SPA navigation / HMR | The page wiped the script's shadow host. v1.8 auto re-attaches it (mutation observer); Tampermonkey menu → **重新注入 trigger** or `__PI_WP_API__.reinject()` forces it back manually. |

> Page-tool handlers are strictly read-only and JSON-safe-capped (depth, string
> and array limits) so a single call can never throw against the 1MB broker
> frame budget. `framework.inspect` only attaches component props/state when
> opted in via 连接设置 checkbox or `__PI_WP_API__.setFrameworkProps(true)`.
