// ==UserScript==
// @name         Xfer Web Picker
// @namespace    pi.dotfiles
// @version      1.12.0
// @description  元素拾取 + 备注批注 + broker 连接/send + 复制 handoff prompt + 页面工具只读采集（v1.12.0：broker 自动重连——手动连上过一次的域名在页面刷新/HMR 整页刷新后静默重连（指数退避），设置弹窗/GM 菜单可按域名撤销；PAGE_QUERY_RULE 改为允许 agent 修改后反向验证）
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/**
 * Xfer Web Picker — userscript: pick/note core + broker connection + send flow + page tools.
 *
 * Pick/note core (unchanged from v1.0.0): Shadow-DOM overlay UI, fab with drag +
 * pick entry, frozen pick mode with layer switching (and 1-9 batch picks), IME-safe
 * note card, note panel, per-item delete, hotkeys ⇧⌥P (pick) / ⇧⌥L (panel), and
 * framework source extraction (React/Vue dev builds → source file:line).
 *
 * Shift group (new in v1.5): ⇧Enter / ⇧click toggles the highlighted element into
 * a pending group (amber dashed marks, in-memory only — DOM refs can't persist);
 * Enter with a pending group opens the group note card → one shared note → every
 * member submits as a regular payloadFor record plus an optional `group` id string
 * linking members (solo picks never carry `group`, so the wire schema stays
 * backward compatible). Panel note edits sync across members of the same group.
 *
 * Draggable chrome + group reset (new in v1.11): the pick toolbar, note card
 * and note panel are drag-repositionable anywhere in the viewport (panel via
 * its header; positions persist per-tab in sessionStorage `pi.wp.barPos` /
 * `pi.wp.panelPos`). The toolbar now takes pointer events: tap 冻结 toggles
 * freeze, tap 退出 leaves pick mode, and a ⌫清空组合 chip appears while a
 * shift-group is pending (the Backspace key works too). Each amber group
 * mark's number badge is clickable and removes that one element from the
 * pending group. The panel's 清空 no longer asks for confirmation —
 * annotations are lightweight by design.
 *
 * Broker layer (new in v1.1; protocol v0.1 — NO token, localhost-trust model):
 *   - v1.10: the send button becomes a split button group (发送 → + ▾ more
 *     dropdown). The dropdown's 复制 handoff prompt asks the broker to render
 *     the EXACT handoff doc a submit would deliver (annotation.compose —
 *     broker-only info like the page-tool CLI path and follow-up channel
 *     instructions are baked in) and copies it to the clipboard, so a non-pi
 *     coding agent with bash access can receive the same handoff: paste it,
 *     and it can call `node broker-main.ts page-tool <target> <op>` itself.
 *     The prompt textarea sends with ⌘/Ctrl+Enter.
 *   - v1.9: picks are never deduped/overwritten (each pick is an independent
 *     record); cssPath forces nth-of-type whenever same-tag siblings exist so
 *     same-class table cells no longer collapse into one selector; every send
 *     appends PAGE_QUERY_RULE telling the agent to do all reverse page.request
 *     BEFORE touching code (HMR full reload breaks the userscript↔broker link).
 *   - manual connect only: ws://127.0.0.1:4719/ws by default; broker URL (incl.
 *     the port — relevant since the broker falls back to an ephemeral port when
 *     4719 is squatted by another program, see /xfer broker status) editable in
 *     the settings modal (GM `wp.brokerUrl`); hello on open → welcome → green
 *     status dot on the fab. Reconnect is NEVER automatic. Clicking the panel's
 *     conn pill while off dials the saved/default URL first; only a failed
 *     attempt opens the settings modal.
 *   - send box at the bottom of the note panel: prompt textarea (optional —
 *     empty sends DEFAULT_PROMPT: respond to each pick's note, or explain the
 *     element's rendering) + searchable
 *     target combobox fed by targets.list → targets.result (row = name +
 *     `cwd · status`; type-to-filter, ↑↓/Enter 或点击选择), last-used
 *     target persisted in GM `wp.lastTarget`, ⟳ manual refresh.
 *   - annotation.submit (picks reuse the payloadFor schema verbatim) → ack toasts
 *     the handoff_id, closes the note panel and clears the local batch; error
 *     frames toast code + message and keep the panel open.
 *   - page tools (v1.6): inbound page.request{tool:{op, params}} runs ONE of the
 *     fixed read-only ops (page.info / dom.query / dom.html / console.logs /
 *     network.log / framework.inspect) against this page and replies
 *     page.response{ok:true, text:JSON}. No free-form eval, no human modal.
 *     console.* + fetch/XHR captures are always-on ring buffers (200 entries
 *     each, page-realm best-effort patch) so pre-request history is visible
 *     to the agent. The v1.2 ask modal is REMOVED — agents confirm with the
 *     user in their own session, not on the page.
 *   - frames are built only through PROTOCOL constants + frame() builders — the
 *     wire protocol lives in exactly one place, never written inline.
 *
 * Storage contract — existing keys stay `pi.wp.*`; the two GM connection keys keep
 * the round-trial names (no `pi.` prefix) for continuity:
 *   - pi.wp.picks   sessionStorage  per-tab pick batch (array of payloadFor
 *                                   records; schema below must stay stable)
 *   - pi.wp.fabPos  sessionStorage  fab position {x, y}
 *   - pi.wp.barPos  sessionStorage  pick toolbar position {x, y} (after first drag)
 *   - pi.wp.panelPos sessionStorage  note panel position {x, y} (after first drag)
 *   - pi.wp.debug   GM storage      debug flag (boolean; toggle at runtime via
 *                                   window.__PI_WP_API__.setDebug(true|false))
 *   - wp.brokerUrl  GM storage      broker WS URL override (settings modal)
 *   - wp.lastTarget GM storage      last used local target name (persisted choice)
 *   - wp.frameworkProps GM storage  framework.inspect props/state opt-in (default off;
 *                                   settings modal checkbox / __PI_WP_API__)
 *
 * Install (Tampermonkey):
 *   1. Open the Tampermonkey Dashboard → "+" (Create a new script).
 *   2. Replace the editor content with this entire file and save (Ctrl/Cmd+S).
 *   3. Reload any page: the round fab appears near the bottom-right corner.
 *      ⇧⌥P = enter/exit pick mode, ⇧⌥L = toggle the note panel (send box inside);
 *      in pick mode ⇧Enter/⇧click add elements to a group, Enter submits its note,
 *      ⌫ (or the toolbar chip / a group mark's number badge) clears pending group
 *      members; toolbar / note card / panel are all draggable.
 */
