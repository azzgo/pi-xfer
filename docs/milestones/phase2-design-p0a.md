# Milestone 2 design — P0-A Web Picker site compatibility
[简体中文](phase2-design-p0a.zh.md)

## Root causes (verified 2026-10-13 via chrome-devtools, live sites)

### npmjs.com — CSP `connect-src` blocks the broker WebSocket

- Response header: `connect-src 'self' …` allowlist; `ws://127.0.0.1:*` not allowed.
- Measured behaviour: `new WebSocket()` **constructs without throwing** (readyState 3),
  then `onerror` fires, and **`onclose` never fires**. This breaks broker-conn.js's
  assumption that close always follows error ("onerror 后的必然 close").
- Why the user sees nothing: the `conn.unreachable` toast is suppressed on the
  silent auto-reconnect path; the only persistent signal is the fab state dot.

### youtube.com — Trusted Types enforcement kills init

- YouTube serves `require-trusted-types-for 'script'`.
- `el.innerHTML = …` **throws** (`This document requires 'TrustedHTML' assignment`).
- `main.js` top level calls `buildUI()` → `shadow.js:29 root.innerHTML = …` throws and the
  whole userscript dies before any wiring — no fab, no UI, no error surface.
- WebSocket is fine on YouTube (constructed OK) — CSP is not the issue there.

## Plan

### Fix 1 — Trusted Types shim (web-picker.src)

- New tiny module (e.g. `web-picker.src/tt.js`): if `window.trustedTypes` exists, try
  `trustedTypes.createPolicy('pi-xfer', { createHTML: s => s })` (guarded — the name may be
  taken); export `setHTML(el, html)` that uses the policy's `createHTML` when enforcement
  is active and falls back to plain assignment otherwise.
- Replace every bare `innerHTML` assignment in `web-picker.src/ui/*.js` and `shadow.js`
  (~10 sites: shadow, combo, panel, pick, plus grep-verify) with `setHTML`.
- Init in `main.js` wrapped so a failure still surfaces a toast/fab error state instead of
  dying silently.
- Note: with `@grant` directives Tampermonkey may sandbox differently per browser; keep the
  shim defensive (feature-detect, never assume).

### Fix 2 — CSP-block feedback (web-picker.src/broker-conn.js)

- Listen for `securitypolicyviolation` on `document` (capture) while a WS connect is
  pending; if `violatedDirective === 'connect-src'` and `blockedURL` matches the broker ws
  URL, treat the connect as policy-blocked.
- Policy-blocked connects: stop backoff reconnect (retrying cannot succeed on this page),
  show a distinct toast (new i18n keys, en+zh: "site policy blocked the local broker
  connection") and set the fab to an explicit "blocked" state so silent auto-link failures
  are visible.
- Fix the close-assumption: settle the connect attempt from `onerror` too (not only
  `onclose`), since CSP-blocked sockets never close.
### Fix 3 — offline degrade: copy-prompt without a broker link (ui/send.js + new local composer)

- Rule: whenever the link is not `on` — CSP-blocked, broker down, or the user simply never
  linked — the send flow degrades to **copy-prompt** instead of refusing.
- Today `copyHandoffPrompt()` bails with `send.connectFirst` when state ≠ on, and the
  prompt text is rendered broker-side (`KIND_COMPOSE`). Degraded path:
  - compose **locally** in the picker from data already in GM storage (picks carry the full
    `payloadFor()` schema; record events likewise) — no broker round-trip;
  - skip the targets fetch; target selection falls back to last-used `GM_TARGET` or is
    omitted (receiver opens the handoff file manually anyway);
  - use an **offline prompt template** that does not mention the reverse page-tool channel
    (that link is dead) — picks/records are self-contained in the copied text.
- Primary send (`doSend`) keeps requiring a link (it must deliver to an agent); only the
  copy-prompt flow degrades.
- **UI degrade (user decision 2026-10-13): when the link is not `on`, hide the send
  button entirely** — no disabled grey button, it just isn't shown. `renderConnPill`
  already re-renders on every state change, so hook the toggle there:
  - `on` → send split button (发送 → + ▾) as today; copy-prompt stays in the dropdown;
  - `connecting` → keep the send button visible (transient, avoids flicker on every
    reconnect) but disabled;
  - `off` / `blocked` → send button hidden; **copy-prompt promoted to the primary button**
    (degraded local composer from above). The conn pill/label already explains why.
- The blocked state (fix 2) becomes a third visual state so a CSP-blocked page reads
  differently from "broker simply not running".

### Docs

- `docs/guides/` known-limitations note: sites with `connect-src` CSP without localhost
  allowance cannot link (picker shows a blocked badge, copy-prompt still works offline);
  Trusted Types sites work after fix 1.

## Touched areas

`web-picker.src/tt.js` (new), `ui/shadow.js`, `ui/combo.js`, `ui/panel.js`, `ui/pick.js`,
`ui/send.js`, offline prompt composer (new), `broker-conn.js`, `i18n.js`, `main.js`;
rebuild `web-picker.user.js`; `docs/guides/` note.

## Risks

- Tampermonkey worlds differ (MV3 isolated world vs page world); the TT policy must be
  created in whichever world runs the UI code — verify on YouTube with real Tampermonkey.
- `securitypolicyviolation` may also fire for unrelated page violations — scope handling to
  pending-connect windows and matching blocked URLs.
- userscript verification is manual (out of verify-skill scope, per AGENTS.md).
