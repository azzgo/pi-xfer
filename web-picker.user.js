// ==UserScript==
// @name         PI Web Picker
// @namespace    pi.dotfiles
// @version      1.2.0
// @description  元素拾取 + 备注批注 + broker 连接/send/提问应答（v1.2：协议 v0.1 无 token，目标下拉/发送，page.request 提问卡）
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

/**
 * PI Web Picker — userscript v1.2: pick/note core + broker connection + send flow + ask modal.
 *
 * Pick/note core (unchanged from v1.0.0): Shadow-DOM overlay UI, fab with drag +
 * pick entry, frozen pick mode with layer switching (and 1-9 batch picks), IME-safe
 * note card, note panel, per-item delete, hotkeys ⇧⌥P (pick) / ⇧⌥L (panel), and
 * framework source extraction (React/Vue dev builds → source file:line).
 *
 * Broker layer (new in v1.1; protocol v0.1 — NO token, localhost-trust model):
 *   - manual connect only: ws://127.0.0.1:4719/ws by default; broker URL editable
 *     in the settings modal (GM `wp.brokerUrl`); hello on open → welcome → green
 *     status dot on the fab. Reconnect is NEVER automatic.
 *   - send box at the bottom of the note panel: prompt textarea + target <select>
 *     fed by targets.list → targets.result (label `name — cwd · status`), last-used
 *     target persisted in GM `wp.lastTarget`, ⟳ manual refresh.
 *   - annotation.submit (picks reuse the payloadFor schema verbatim) → ack toasts
 *     the handoff_id and clears the local batch; error frames toast code + message.
 *   - reverse channel (v1.2): inbound page.request → centered ask modal (question
 *     text + from/handoff meta + answer textarea); 回复 → page.response{ok:true,
 *     text}, 忽略 / Esc → page.response{ok:false, error:"dismissed"}; IME-safe
 *     Enter submits; ask modal and pick mode are mutually exclusive (opening one
 *     dismisses the other).
 *   - frames are built only through PROTOCOL constants + frame() builders — the
 *     wire protocol lives in exactly one place, never written inline.
 *
 * Storage contract — existing keys stay `pi.wp.*`; the two GM connection keys keep
 * the round-trial names (no `pi.` prefix) for continuity:
 *   - pi.wp.picks   sessionStorage  per-tab pick batch (array of payloadFor
 *                                   records; schema below must stay stable)
 *   - pi.wp.fabPos  sessionStorage  fab position {x, y}
 *   - pi.wp.debug   GM storage      debug flag (boolean; toggle at runtime via
 *                                   window.__PI_WP_API__.setDebug(true|false))
 *   - wp.brokerUrl  GM storage      broker WS URL override (settings modal)
 *   - wp.lastTarget GM storage      last used local target name (persisted choice)
 *
 * Install (Tampermonkey):
 *   1. Open the Tampermonkey Dashboard → "+" (Create a new script).
 *   2. Replace the editor content with this entire file and save (Ctrl/Cmd+S).
 *   3. Reload any page: the round fab appears near the bottom-right corner.
 *      ⇧⌥P = enter/exit pick mode, ⇧⌥L = toggle the note panel (send box inside).
 */
(() => {
  'use strict';

  if (window.__PI_WEBPICKER__) return;
  window.__PI_WEBPICKER__ = true;

  // ---------- constants ----------
  const KEY_PICKS = 'pi.wp.picks';          // per-tab batch (sessionStorage)
  const KEY_POS = 'pi.wp.fabPos';           // fab position (sessionStorage)
  const GM_DEBUG = 'pi.wp.debug';           // debug flag (GM storage)
  const HOST_FLAG = 'data-pi-wp-host';
  const MAX_DEPTH = 8;
  const HOTKEY = { code: 'KeyP', alt: true, shift: true };
  const GM_BROKER = 'wp.brokerUrl';        // broker WS URL override (settings modal)
  const GM_TARGET = 'wp.lastTarget';       // last used local target name
  const DEFAULT_BROKER_URL = 'ws://127.0.0.1:4719';

  // ---------- wire protocol v0.1 (Ticket 007 + trial amends: no token, targets frames) ----------
  // Every frame carries { v, type }; each request gets exactly one reply (ack | error).
  // All protocol constants and frame builders live here — never write a frame inline.
  const PROTOCOL = {
    V: 0,                                          // envelope version on every frame
    KIND_HELLO: 'hello',
    KIND_WELCOME: 'welcome',
    KIND_SUBMIT: 'annotation.submit',
    KIND_ACK: 'ack',
    KIND_ERROR: 'error',
    KIND_TARGETS_LIST: 'targets.list',
    KIND_TARGETS_RESULT: 'targets.result',
    KIND_PAGE_REQUEST: 'page.request',
    KIND_PAGE_RESPONSE: 'page.response',
    NS_LOCAL: 'local',
  };
  function frame(type, extra) { return Object.assign({ v: PROTOCOL.V, type }, extra); }
  function frameHello() {
    return frame(PROTOCOL.KIND_HELLO, {
      client: { ua: 'tampermonkey', tab: { id: String(Date.now()), url: location.href, title: document.title } },
    });
  }
  function frameSubmit(id, prompt, targetName) {
    return frame(PROTOCOL.KIND_SUBMIT, {
      id,
      page: { url: location.href, title: document.title },
      picks: loadBatch(),
      prompt,
      target: { namespace: PROTOCOL.NS_LOCAL, name: targetName },
    });
  }
  function frameTargetsList(id) {
    return frame(PROTOCOL.KIND_TARGETS_LIST, { id });
  }
  function framePageResponse(id, ok, payload) {
    return frame(PROTOCOL.KIND_PAGE_RESPONSE, {
      id,
      ok,
      ...(ok ? { text: payload } : { error: payload }),
    });
  }

  // ---------- storage — all keys under pi.wp.*, all access guarded ----------
  // GM storage survives across tabs and sessions (debug flag today; connection
  // prefs in the broker revision). sessionStorage keeps the per-tab batch.
  const gm = {
    get(k, d) {
      try { const v = GM_getValue(k); return v === undefined ? d : v; }
      catch (e) { return d; }
    },
    set(k, v) {
      try { GM_setValue(k, v); }
      catch (e) { /* GM storage unavailable — value simply won't persist */ }
    },
  };
  function debugLog(...args) {
    if (gm.get(GM_DEBUG, false) !== true) return;
    console.log('[pi.wp]', ...args);
  }

  function loadBatch() {
    try {
      const s = sessionStorage.getItem(KEY_PICKS);
      const b = s ? JSON.parse(s) : [];
      return Array.isArray(b) ? b : [];
    } catch (e) { return []; }
  }
  function saveBatch(b) {
    try { sessionStorage.setItem(KEY_PICKS, JSON.stringify(b)); }
    catch (e) { /* quota / privacy mode — batch stays in memory for this page */ }
  }
  function addPick(rec) {
    const b = loadBatch();
    const i = b.findIndex((x) => x.selector === rec.selector);
    if (i >= 0) { b[i] = rec; toast('已更新 ' + rec.selector); }
    else { b.push(rec); toast('已选中 ' + rec.selector); }
    saveBatch(b);
    refreshCount();
  }
  function clearBatch() { saveBatch([]); refreshCount(); }

  // ---------- DOM utils ----------
  const cssEscape = (s) => (window.CSS && CSS.escape)
    ? CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

  function cssPath(el) {
    if (el.id) return '#' + cssEscape(el.id);
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < MAX_DEPTH) {
      let sel = cur.nodeName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
      const stable = ['data-testid', 'data-test', 'data-component', 'data-cy', 'name']
        .find((a) => cur.getAttribute && cur.getAttribute(a));
      if (stable) {
        parts.unshift(sel + '[' + stable + '="' + cssEscape(String(cur.getAttribute(stable))) + '"]');
      } else {
        const cls = Array.from(cur.classList || []).filter((c) => c.length > 1).slice(0, 2);
        if (cls.length) {
          parts.unshift(sel + '.' + cls.map(cssEscape).join('.'));
        } else {
          const sibs = cur.parentElement
            ? Array.from(cur.parentElement.children).filter((s) => s.nodeName === cur.nodeName)
            : [cur];
          if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
          parts.unshift(sel);
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ') || el.nodeName.toLowerCase();
  }

  function xPath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let i = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) { if (sib.nodeName === cur.nodeName) i++; }
      parts.unshift(cur.nodeName.toLowerCase() + '[' + i + ']');
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }
  function nearestScrollable(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll|overlay)/.test(cs.overflowY)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  function selectorPreview(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return s;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- framework source (dev builds) — sandbox first, unsafeWindow fallback ----------
  function reactSource(el) {
    const keys = Object.getOwnPropertyNames(el);
    for (const k of keys) {
      if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactInternalInstance$')) continue;
      let f = el[k], guard = 0;
      while (f && guard++ < 200) {
        const t = f.type;
        const src = f._debugSource;
        if (t && (t.name || t.displayName) && src && src.fileName) {
          return { framework: 'react', component: t.displayName || t.name || '', file: src.fileName, line: src.lineNumber || 0, column: src.columnNumber || 0 };
        }
        f = f.return;
      }
    }
    return null;
  }
  function vueSource(el) {
    let vm = el.__vueParentComponent || el.__vue__ || null;
    let guard = 0;
    while (vm && guard++ < 200) {
      const opts = vm.$options || {};
      if (opts.__file) {
        const name = (vm.type && (vm.type.name || vm.type.__name)) || opts.name || opts.__name || '';
        return { framework: 'vue', component: name, file: opts.__file, line: 0, column: 0 };
      }
      vm = vm.$parent || null;
    }
    return null;
  }
  // Page-realm expandos are invisible from the userscript sandbox (isolated world).
  // Fallback: re-resolve the element through unsafeWindow's document, then walk there.
  function sourceInfo(el) {
    const direct = reactSource(el) || vueSource(el);
    if (direct) return direct;
    try {
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
      if (!uw || !uw.document) return null;
      const sel = cssPath(el);
      const pageEl = uw.document.querySelector(sel);
      if (!pageEl || pageEl === el) return null; // same object → same realm, no point
      return reactSource(pageEl) || vueSource(pageEl);
    } catch (e) { return null; }
  }

  // ---------- UI (Shadow DOM) ----------
  const host = document.createElement('div');
  host.setAttribute(HOST_FLAG, '');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host {
        --wp-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
        --wp-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        --wp-ink: #0f172a;
        --wp-muted: #64748b;
        --wp-line: #e2e8f0;
        --wp-soft: #f8fafc;
        --wp-accent: #4f8cff;
        --wp-accent-deep: #3b76e8;
        --wp-green: #22c55e;
        --wp-amber: #f59e0b;
        --wp-dark: #0f1522;
        --wp-radius: 12px;
        --wp-shadow: 0 1px 2px rgba(15,23,42,.05), 0 16px 40px -12px rgba(15,23,42,.25);
      }
      * { box-sizing: border-box; }
      /* ---- pick-mode chrome ---- */
      #hl { position: fixed; margin: 0; padding: 0; border: 2px solid var(--wp-accent); background: rgba(79,140,255,.12);
        border-radius: 3px; pointer-events: none; transition: all .04s linear; display: none; }
      #hl.pin { border-color: #ff5a5a; background: rgba(255,90,90,.14); }
      #badge { position: fixed; top: 0; left: 0; transform: translate(-50%, -150%);
        background: var(--wp-dark); color: #fff; font: 600 11px/1.4 var(--wp-font);
        padding: 4px 9px; border-radius: 6px; white-space: nowrap; pointer-events: none; display: none;
        box-shadow: 0 4px 12px rgba(15,23,42,.35); }
      #badge small { opacity: .6; font-weight: 400; }
      #info { position: fixed; top: 0; left: 0; transform: translate(0, 100%);
        background: rgba(15,21,34,.92); color: #e2e8f0; font: 11px/1.4 var(--wp-mono);
        padding: 5px 9px; border-radius: 6px; max-width: 80vw; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; pointer-events: none; display: none;
        box-shadow: 0 4px 12px rgba(15,23,42,.3); backdrop-filter: blur(6px); }
      #info .pv { color: #7dabff; } #info .dim { color: #94a3b8; }
      #bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        background: rgba(15,21,34,.96); color: #cbd5e1; font: 12px/1 var(--wp-font);
        padding: 9px 16px; border-radius: 999px; display: none; gap: 14px; align-items: center;
        box-shadow: 0 8px 24px rgba(15,23,42,.35); user-select: none; pointer-events: none;
        backdrop-filter: blur(6px); }
      #bar b { color: #fff; letter-spacing: .08em; font-size: 11px; }
      #bar kbd { background: #1e293b; border: 1px solid #334155; border-bottom-width: 2px;
        border-radius: 4px; padding: 1px 5px; font: 10.5px var(--wp-mono); color: #e2e8f0; }
      #bar .muted { color: #94a3b8; display: inline-flex; gap: 3px; align-items: center; }
      #bar #fz.on kbd { background: #0c4a6e; border-color: #0369a1; color: #e0f2fe; }
      /* ---- fab ---- */
      #fab { position: fixed; width: 46px; height: 46px; border-radius: 14px;
        border: 1px solid rgba(255,255,255,.12); background: linear-gradient(160deg, #1b2230, #12161f);
        color: #fff; padding: 0; outline: none; cursor: grab;
        box-shadow: 0 10px 26px rgba(10,14,25,.45), inset 0 1px 0 rgba(255,255,255,.09);
        user-select: none; pointer-events: auto; z-index: 2147483647; transition: transform .15s ease, box-shadow .15s ease; }
      #fab:hover { transform: translateY(-2px);
        box-shadow: 0 14px 30px rgba(10,14,25,.55), 0 0 0 3px rgba(79,140,255,.30), inset 0 1px 0 rgba(255,255,255,.1); }
      #fab:active { cursor: grabbing; transform: scale(.96); }
      #fab svg { width: 20px; height: 20px; position: absolute; inset: 50% auto auto 50%;
        transform: translate(-50%, -50%); transition: transform .2s ease; pointer-events: none; }
      #fab:hover svg { transform: translate(-50%, -50%) rotate(45deg) scale(1.08); }
      #cnt { position: absolute; bottom: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
        background: #ef4444; color: #fff; font: 700 11px/20px var(--wp-font); text-align: center; padding: 0 5px;
        display: none; box-shadow: 0 0 0 2px #161a21; cursor: pointer; }
      #dot { position: absolute; top: -4px; left: -4px; width: 12px; height: 12px; border-radius: 6px;
        background: #94a3b8; box-shadow: 0 0 0 2px #161a21; transition: background .2s; }
      #dot.connecting { background: var(--wp-amber); }
      #dot.on { background: var(--wp-green); box-shadow: 0 0 0 2px #161a21, 0 0 8px rgba(34,197,94,.8); }
      /* ---- floating cards ---- */
      #card, #panel, #settings, #ask {
        background: #fff; border: 1px solid var(--wp-line); border-radius: var(--wp-radius);
        box-shadow: var(--wp-shadow); color: var(--wp-ink);
        font: 13px/1.5 var(--wp-font); z-index: 2147483647; pointer-events: auto;
      }
      #card { position: fixed; width: 300px; padding: 14px; display: none; }
      #card .sel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
        border: 1px solid var(--wp-line); padding: 6px 8px; border-radius: 8px;
        word-break: break-all; margin-bottom: 10px; max-height: 70px; overflow: auto; }
      #card .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
      /* ---- shared form controls ---- */
      textarea, input, select {
        width: 100%; border: 1px solid var(--wp-line); border-radius: 8px; padding: 7px 10px;
        font: 12.5px/1.5 var(--wp-font); background: #fff; color: var(--wp-ink);
        outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      }
      textarea { resize: vertical; min-height: 44px; }
      textarea:focus, input:focus, select:focus {
        border-color: var(--wp-accent); box-shadow: 0 0 0 3px rgba(79,140,255,.14);
      }
      input, select { font-family: var(--wp-mono); font-size: 12px; }
      select {
        appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 28px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 9px center; background-size: 12px;
      }
      select:disabled { background-color: var(--wp-soft); color: var(--wp-muted); cursor: not-allowed; }
      button { font: 600 12px var(--wp-font); border: none; border-radius: 8px; cursor: pointer;
        padding: 7px 14px; transition: background .15s ease, box-shadow .15s ease, transform .05s ease; }
      button:active { transform: translateY(1px); }
      button.primary { background: var(--wp-accent); color: #fff; box-shadow: 0 1px 3px rgba(79,140,255,.45); }
      button.primary:hover { background: var(--wp-accent-deep); }
      button.primary:disabled { background: #c4d5f7; box-shadow: none; cursor: not-allowed; transform: none; }
      button.ghost { background: #f1f5f9; color: var(--wp-muted); }
      button.ghost:hover { background: #e2e8f0; color: #475569; }
      button.icon { padding: 7px 9px; font-size: 13px; line-height: 1; }
      button.icon:disabled { opacity: .45; cursor: not-allowed; transform: none; }
      /* ---- panel ---- */
      #panel { position: fixed; top: 60px; right: 16px; width: 348px; max-height: 80vh;
        display: none; flex-direction: column; overflow: hidden; }
      #panel .ph { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
        background: var(--wp-soft); border-bottom: 1px solid var(--wp-line); user-select: none; }
      #panel .ph b { flex: 1; font-size: 13px; font-weight: 600; }
      #panel .ph .cnt2 { color: var(--wp-muted); font-size: 11px; }
      #panel .ph button { background: transparent; color: var(--wp-muted); padding: 3px 8px; border-radius: 6px; }
      #panel .ph button:hover { background: #e8edf3; color: #334155; }
      #plist { overflow-y: auto; padding: 10px; flex: 1; }
      #plist::-webkit-scrollbar { width: 8px; }
      #plist::-webkit-scrollbar-thumb { background: #dde4ec; border-radius: 4px; }
      #plist::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      #plist .empty { color: #94a3b8; text-align: center; padding: 28px 0; font-size: 12px; }
      #plist .item { border: 1px solid var(--wp-line); border-radius: 10px; padding: 9px; margin-bottom: 8px;
        background: #fff; transition: border-color .15s ease, box-shadow .15s ease; }
      #plist .item:hover { border-color: #c9d6ea; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
      #plist .item .psel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
        border: 1px solid var(--wp-line); padding: 4px 7px; border-radius: 6px;
        word-break: break-all; max-height: 44px; overflow: auto; }
      #plist .item .psrc { color: #059669; font: 10px/1.5 var(--wp-mono); margin-top: 4px; word-break: break-all; }
      #plist .item .pprev { color: #94a3b8; font-size: 11px; margin: 4px 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      #plist .item textarea { min-height: 34px; font-size: 12px; padding: 5px 8px; }
      #plist .item .prow { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
      #plist .item .pts { color: #94a3b8; font-size: 10px; font-family: var(--wp-mono); }
      #plist .item .del { background: none; color: #ef4444; font-size: 11px; padding: 2px 8px; border-radius: 6px; }
      #plist .item .del:hover { background: #fef2f2; }
      /* ---- send box ---- */
      #sendbox { border-top: 1px solid var(--wp-line); padding: 12px 14px; display: flex;
        flex-direction: column; gap: 7px; background: var(--wp-soft); border-radius: 0 0 var(--wp-radius) var(--wp-radius); }
      #sendbox .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); letter-spacing: .02em; }
      #sendbox textarea { background: #fff; }
      #sendbox .trow { display: flex; gap: 6px; align-items: center; }
      #sendbox .trow select { flex: 1; }
      #sendbox .srow { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
      #connstate { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 500;
        color: var(--wp-muted); flex: 1; cursor: pointer; user-select: none; white-space: nowrap; }
      #connstate .dot { flex: none; width: 9px; height: 9px; border-radius: 50%;
        background: #94a3b8; transition: background .2s ease, box-shadow .2s ease; }
      #connstate.connecting .dot { background: var(--wp-amber); }
      #connstate.on { color: #15803d; }
      #connstate.on .dot { background: var(--wp-green); box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
      #connstate:hover { text-decoration: underline; text-underline-offset: 3px; }
      /* ---- settings modal ---- */
      #settings { position: fixed; width: 312px; padding: 16px; display: none; top: 20vh; right: 20px; }
      #settings b { font-size: 13px; display: block; margin-bottom: 2px; }
      #settings .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); margin: 12px 0 4px;
        letter-spacing: .02em; }
      #settings .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
      /* ---- ask modal (reverse channel) ---- */
      #ask { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 420px; max-width: calc(100vw - 32px); padding: 16px; display: none; }
      #ask b { font-size: 13px; display: block; }
      #ask .q { font: 13px/1.6 var(--wp-font); background: var(--wp-soft);
        border: 1px solid var(--wp-line); border-radius: 8px; padding: 10px 12px;
        margin-top: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap;
        word-break: break-word; }
      #ask .meta { font: 10.5px/1.5 var(--wp-mono); color: var(--wp-muted); margin-top: 8px;
        word-break: break-all; }
      #ask .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); margin: 12px 0 4px;
        letter-spacing: .02em; }
      #ask textarea { min-height: 76px; }
      #ask .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
      /* ---- toast ---- */
      #toast { position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%);
        background: rgba(15,21,34,.95); color: #f1f5f9; font: 12.5px var(--wp-font);
        padding: 9px 18px; border-radius: 999px; opacity: 0; transition: opacity .2s ease, transform .2s ease;
        transform: translateX(-50%) translateY(6px); pointer-events: none; max-width: 80vw; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; z-index: 2147483647;
        box-shadow: 0 8px 24px rgba(15,23,42,.35); backdrop-filter: blur(6px); }
      #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    </style>
    <div id="hl"></div>
    <div id="badge"></div>
    <div id="info"></div>
    <div id="bar"><b>PICK</b>
      <span class="muted"><kbd>[</kbd><kbd>]</kbd>切层</span>
      <span class="muted"><kbd>1</kbd>-<kbd>9</kbd>跳层</span>
      <span class="muted"><kbd>Enter</kbd>选中</span>
      <span class="muted" id="fz"><kbd>F</kbd>冻结</span>
      <span class="muted"><kbd>Esc</kbd>退出</span>
    </div>
    <div id="card">
      <div class="sel" id="sel"></div>
      <textarea id="txt" placeholder="备注（可选，留空直接回车提交）"></textarea>
      <div class="row">
        <button class="ghost" id="cancel">取消 Esc</button>
        <button class="primary" id="ok">✓ 确认 Enter</button>
      </div>
    </div>
    <div id="panel">
      <div class="ph"><b>已选备注</b><span class="cnt2" id="pcount"></span><button id="pclose" title="关闭 Esc">✕</button></div>
      <div id="plist"></div>
      <div id="sendbox">
        <div class="lbl">发送到 agent（prompt 指令）</div>
        <textarea id="prompt" placeholder="要让 agent 做什么？如：把这两个按钮合并成一个"></textarea>
        <div class="trow">
          <span class="lbl">目标</span>
          <select id="target"></select>
          <button class="ghost icon" id="trefresh" title="刷新 target 列表">⟳</button>
        </div>
        <div class="srow">
          <span id="connstate"><span class="dot"></span><span id="conntext">未连接 · 点击设置</span></span>
          <button class="ghost" id="clearbtn">清空</button>
          <button class="primary" id="sendbtn">发送 →</button>
        </div>
      </div>
    </div>
    <button id="fab" title="元素拾取 · 点击进入（或按 ⇧⌥P）· 点红色数字角标开备注面板 · 绿点=broker 已连接">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round">
        <circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
      </svg>
      <span id="dot"></span>
      <span id="cnt">0</span>
    </button>
    <div id="toast"></div>
    <div id="settings">
      <b>连接设置</b>
      <div class="lbl">BROKER 地址（WS）</div>
      <input id="sburl" placeholder="ws://127.0.0.1:4719" />
      <div class="row">
        <button class="ghost" id="scancel">取消</button>
        <button class="primary" id="ssave">保存并连接</button>
      </div>
    </div>
    <div id="ask">
      <b>agent 提问</b>
      <div class="q" id="aqtext"></div>
      <div class="meta" id="aqmeta"></div>
      <div class="lbl">回答</div>
      <textarea id="aqtxt" placeholder="输入回答，Enter 提交（输入法选字按 Enter 不会误发）"></textarea>
      <div class="row">
        <button class="ghost" id="aqignore">忽略 Esc</button>
        <button class="primary" id="aqsend">回复 Enter</button>
      </div>
    </div>
  `;

  const $ = (id) => root.getElementById(id);
  const elHL = $('hl'), elBadge = $('badge'), elInfo = $('info'), elBar = $('bar'),
        elFab = $('fab'), elCnt = $('cnt'), elDot = $('dot'), elCard = $('card'), elSel = $('sel'),
        elTxt = $('txt'), elOk = $('ok'), elCancel = $('cancel'), elToast = $('toast'),
        elPanel = $('panel'), elPlist = $('plist'), elPcount = $('pcount'), elPclose = $('pclose'),
        elPrompt = $('prompt'), elTarget = $('target'), elTRefresh = $('trefresh'),
        elSend = $('sendbtn'), elClear = $('clearbtn'),
        elConn = $('connstate'), elConnText = $('conntext'), elSettings = $('settings'),
        elSUrl = $('sburl'), elSSave = $('ssave'), elSCancel = $('scancel'),
        elAsk = $('ask'), elAskQ = $('aqtext'), elAskMeta = $('aqmeta'),
        elAskTxt = $('aqtxt'), elAskSend = $('aqsend'), elAskIgnore = $('aqignore');

  // ---------- state ----------
  let pickMode = false;
  let stack = [];
  let idx = 0;
  let pinned = null;
  let frozen = true;
  let pos = { x: window.innerWidth - 68, y: window.innerHeight - 96 };
  try {
    const saved = sessionStorage.getItem(KEY_POS);
    if (saved) { const p = JSON.parse(saved); if (typeof p.x === 'number' && typeof p.y === 'number') pos = p; }
  } catch (e) { /* fall back to default position */ }
  elFab.style.left = pos.x + 'px';
  elFab.style.top = pos.y + 'px';

  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => elToast.classList.remove('show'), 2200);
  }
  function refreshCount() {
    const n = loadBatch().length;
    elCnt.textContent = n;
    elCnt.style.display = n > 0 ? 'block' : 'none';
    if (panelOpen) renderPanel();
  }

  function stackAt(clientX, clientY) {
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = 'none';
    const all = document.elementsFromPoint(clientX, clientY) || [];
    host.style.pointerEvents = prev;
    return all.filter((el) => {
      if (!el || el.nodeType !== 1) return false;
      if (el.getAttribute && el.getAttribute(HOST_FLAG) !== null) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      return true;
    });
  }
  function currentEl() { return stack[idx] || null; }

  function applyHighlight(el, pin) {
    if (!el) { elHL.style.display = 'none'; elBadge.style.display = 'none'; elInfo.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(elHL.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
    elHL.classList.toggle('pin', !!pin);
    elBadge.style.display = 'block';
    elBadge.style.left = (r.left + r.width / 2) + 'px';
    elBadge.style.top = r.top + 'px';
    elBadge.innerHTML = (idx + 1) + '<small>/' + stack.length + '层 · ' + Math.round(r.width) + '×' + Math.round(r.height) + '</small>';
    elInfo.style.display = 'block';
    elInfo.style.left = r.left + 'px';
    elInfo.style.top = r.top + 'px';
    elInfo.innerHTML = '<span class="pv">' + escapeHtml(selectorPreview(el)) + '</span> <span class="dim">' +
      Math.round(r.width) + '×' + Math.round(r.height) + ' · ' + escapeHtml(cssPath(el)) + '</span>';
  }
  function refresh() { applyHighlight(currentEl(), !!pinned); }

  // ---------- pick mode ----------
  function setActive(on) {
    if (on) dismissAsk();           // ask modal and pick mode are mutually exclusive
    pickMode = on;
    host.style.pointerEvents = 'none';
    elBar.style.display = on ? 'flex' : 'none';
    elFab.style.display = on ? 'none' : 'block';
    document.body.style.cursor = on ? 'crosshair' : '';
    if (on) { frozen = true; closePanel(); }
    else {
      pinned = null; frozen = false;
      elCard.style.display = 'none'; elHL.style.display = 'none'; elBadge.style.display = 'none'; elInfo.style.display = 'none';
    }
    updateFreezeUI();
    refreshCount();
  }

  function isOurUI(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(root) >= 0;
  }
  function isFabTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(elFab) >= 0;
  }
  let drag = null;
  function fabPointerDown(e) {
    if (!isFabTarget(e)) return;
    e.stopPropagation(); e.preventDefault();
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    try { elFab.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported — drag still works via move handler */ }
  }
  function fabPointerMove(e) {
    if (!isFabTarget(e) && !drag) return;
    e.stopPropagation(); e.preventDefault();
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    pos.x = Math.max(4, Math.min(window.innerWidth - 50, drag.ox + dx));
    pos.y = Math.max(4, Math.min(window.innerHeight - 50, drag.oy + dy));
    elFab.style.left = pos.x + 'px';
    elFab.style.top = pos.y + 'px';
  }
  // 角标点击开面板：不能依赖 composedPath 判定——fabPointerDown 里的 setPointerCapture
  // 会把 pointerup 重定向到 fab，事件路径里永远不会出现 #cnt。
  // 改用坐标命中测试，兼容指针捕获；命中区外扩 3px 好点中。
  function overBadge(x, y) {
    if (elCnt.style.display !== 'block') return false;
    const r = elCnt.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3;
  }
  function fabPointerUp(e) {
    if (!drag) return;
    e.stopPropagation(); e.preventDefault();
    const wasMoved = drag.moved;
    const hitBadge = overBadge(e.clientX, e.clientY);
    drag = null;
    try { sessionStorage.setItem(KEY_POS, JSON.stringify(pos)); } catch (err) { /* position won't persist */ }
    if (!wasMoved) { if (hitBadge) togglePanel(); else setActive(true); }
  }
  window.addEventListener('pointerdown', fabPointerDown, true);
  window.addEventListener('pointermove', fabPointerMove, true);
  window.addEventListener('pointerup', fabPointerUp, true);

  function moveCapture(e) {
    if (!pickMode) return;
    if (frozen) { e.stopPropagation(); e.preventDefault(); }
    if (pinned || isOurUI(e)) return;
    stack = stackAt(e.clientX, e.clientY);
    idx = 0;
    refresh();
  }
  function hoverCapture(e) {
    if (!pickMode || !frozen) return;
    e.stopPropagation(); e.preventDefault();
  }
  function clickCapture(e) {
    if (isOurUI(e)) return;
    if (!pickMode) return;
    const btn0 = e.button === undefined || e.button === 0;
    if (e.type === 'pointerdown' || e.type === 'mousedown') {
      e.stopPropagation(); e.preventDefault();
      if (btn0 && !pinned) pinAt(e.clientX, e.clientY);
      return;
    }
    e.stopPropagation(); e.preventDefault();
  }
  function wheelCapture(e) {
    if (!pickMode || pinned || isOurUI(e)) return;
    const sc = nearestScrollable(e.target);
    if (sc && sc.scrollHeight > sc.clientHeight) return;
    e.preventDefault();
    window.scrollBy(0, e.deltaY);
  }
  window.addEventListener('mousemove', moveCapture, true);
  window.addEventListener('mouseover', hoverCapture, true);
  window.addEventListener('mouseout', hoverCapture, true);
  window.addEventListener('mouseenter', hoverCapture, true);
  window.addEventListener('mouseleave', hoverCapture, true);
  window.addEventListener('pointermove', hoverCapture, true);
  window.addEventListener('pointerover', hoverCapture, true);
  window.addEventListener('pointerout', hoverCapture, true);
  window.addEventListener('pointerenter', hoverCapture, true);
  window.addEventListener('pointerleave', hoverCapture, true);
  window.addEventListener('pointerdown', clickCapture, true);
  window.addEventListener('mousedown', clickCapture, true);
  window.addEventListener('mouseup', clickCapture, true);
  window.addEventListener('click', clickCapture, true);
  window.addEventListener('contextmenu', clickCapture, true);
  window.addEventListener('wheel', wheelCapture, { capture: true, passive: false });
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu']) {
    host.addEventListener(t, (e) => e.stopPropagation(), false);
  }

  function shiftLayer(delta) {
    if (!stack.length) return;
    idx = Math.max(0, Math.min(stack.length - 1, idx + delta));
    refresh();
  }

  // ---------- pin → note ----------
  function pin() {
    const el = currentEl();
    if (!el) return;
    pinned = el;
    applyHighlight(el, true);
    const sel = cssPath(el);
    const r = el.getBoundingClientRect();
    let left = r.right + 10;
    if (left + 300 > window.innerWidth) left = Math.max(8, r.left - 310);
    let top = r.top;
    if (top + 240 > window.innerHeight) top = Math.max(8, window.innerHeight - 250);
    Object.assign(elCard.style, { display: 'block', left: left + 'px', top: top + 'px' });
    elSel.textContent = sel;
    elTxt.value = '';
    setTimeout(() => elTxt.focus(), 0);
  }
  function unpin() { pinned = null; elCard.style.display = 'none'; refresh(); }
  function pinAt(x, y) {
    const st = stackAt(x, y);
    if (!st.length) return;
    stack = st;
    idx = 0;
    pin();
  }

  // payload schema is the v0 wire format — the broker revision consumes these
  // records verbatim, so field names/shapes here must stay stable.
  function payloadFor(el, note) {
    const r = el.getBoundingClientRect();
    return {
      selector: cssPath(el),
      xpath: xPath(el),
      tagName: el.tagName.toLowerCase(),
      textPreview: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      note: note || '',
      ts: Date.now(),
      url: location.href,
      source: sourceInfo(el),
    };
  }
  function submit() {
    if (!pinned) return;
    addPick(payloadFor(pinned, elTxt.value.trim()));
    unpin();
  }

  // ---------- note panel ----------
  let panelOpen = false;
  function renderPanel() {
    const b = loadBatch();
    elPcount.textContent = b.length ? b.length + ' 条' : '';
    if (!b.length) { elPlist.innerHTML = '<div class="empty">还没有选中任何元素</div>'; return; }
    elPlist.innerHTML = b.map((r, i) =>
      '<div class="item" data-i="' + i + '">' +
        '<div class="psel">' + escapeHtml(r.selector) + '</div>' +
        (r.source && r.source.file ? '<div class="psrc">⌘ ' + escapeHtml(r.source.component + ' · ' + r.source.file + ':' + r.source.line) + '</div>' : '') +
        (r.textPreview ? '<div class="pprev">' + escapeHtml(r.textPreview) + '</div>' : '') +
        '<textarea placeholder="备注…（失焦自动保存）">' + escapeHtml(r.note || '') + '</textarea>' +
        '<div class="prow"><span class="pts">' + new Date(r.ts).toLocaleTimeString() + '</span>' +
        '<button class="del">删除</button></div>' +
      '</div>'
    ).join('');
  }
  function openPanel() {
    panelOpen = true;
    renderPanel();
    elPanel.style.display = 'flex';
    if (wsState === 'on') refreshTargets(); else renderTargetSelect();
  }
  function closePanel() { panelOpen = false; elPanel.style.display = 'none'; }
  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }
  elPclose.addEventListener('click', closePanel);
  elPlist.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'TEXTAREA') return;
    const item = t.closest('.item');
    if (!item) return;
    const b = loadBatch();
    const i = +item.getAttribute('data-i');
    if (!b[i]) return;
    b[i].note = t.value.trim();
    saveBatch(b);
    toast('备注已保存');
  });
  elPlist.addEventListener('click', (e) => {
    const del = e.target && e.target.closest ? e.target.closest('.del') : null;
    if (!del) return;
    const item = del.closest('.item');
    if (!item) return;
    const b = loadBatch();
    const i = +item.getAttribute('data-i');
    if (!b[i]) return;
    const sel = b[i].selector;
    b.splice(i, 1);
    saveBatch(b);
    refreshCount();
    renderPanel();
    toast('已删除 ' + sel);
  });

  // ---------- broker connection (protocol v0.1, no token — manual connect only) ----------
  let ws = null;
  let wsState = 'off';                 // off | connecting | on
  const pending = new Map();           // request id → { kind:'submit'|'targets', resolve }
  let targets = [];                    // [{name, sessionName, cwd, status}] from targets.list

  function brokerUrl() { return gm.get(GM_BROKER, DEFAULT_BROKER_URL); }

  function sendFrame(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function setWsState(s) {
    wsState = s;
    elDot.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : '';
    elConn.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : '';
    elConn.title = s === 'on' ? '点击断开 broker' : s === 'connecting' ? '连接中…' : '点击打开连接设置';
    elConnText.textContent = s === 'on' ? 'broker 已连接'
      : s === 'connecting' ? '连接中…'
      : '未连接 · 点击设置';
    if (s !== 'on') { targets = []; renderTargetSelect(); }
  }

  function connectBroker() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    const url = brokerUrl().replace(/\/+$/, '') + '/ws';
    setWsState('connecting');
    let sock;
    try { sock = new WebSocket(url); }
    catch (e) { setWsState('off'); toast('WS 创建失败: ' + e.message); return; }
    ws = sock;
    sock.onopen = () => { sendFrame(frameHello()); };
    sock.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (!f || typeof f.type !== 'string') return;
      if (f.type === PROTOCOL.KIND_WELCOME) {
        setWsState('on');
        toast('broker 已连接');
        refreshTargets();
        return;
      }
      if (f.type === PROTOCOL.KIND_ACK) {
        const p = pending.get(f.id);
        if (p && p.kind === 'submit') { pending.delete(f.id); p.resolve({ ok: true, result: f.result }); }
        return;
      }
      if (f.type === PROTOCOL.KIND_ERROR) {
        const p = pending.get(f.id);
        if (p) {
          pending.delete(f.id);
          p.resolve(p.kind === 'submit' ? { ok: false, code: f.code, message: f.message } : []);
        } else {
          toast('broker 错误: ' + (f.code || '?'));
        }
        return;
      }
      if (f.type === PROTOCOL.KIND_TARGETS_RESULT) {
        const p = pending.get(f.id);
        if (p && p.kind === 'targets') { pending.delete(f.id); p.resolve(Array.isArray(f.targets) ? f.targets : []); }
        return;
      }
      if (f.type === PROTOCOL.KIND_PAGE_REQUEST) {
        debugLog('page.request', f.id, f.text);
        openAsk(f);
        return;
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;               // superseded by a newer connect
      ws = null;
      for (const p of pending.values()) p.resolve(p.kind === 'submit'
        ? { ok: false, code: 'closed', message: 'broker 连接已断开' }
        : []);
      pending.clear();
      if (wsState !== 'off') { setWsState('off'); toast('broker 连接已断开'); }
    };
    sock.onerror = () => {
      if (ws === sock && wsState !== 'off') { setWsState('off'); toast('broker 连不上: ' + url); }
    };
  }

  function disconnectBroker() {
    setWsState('off');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    toast('已断开');
  }

  // ---------- send flow (annotation.submit → ack/error) ----------
  function submitToAgent(prompt, targetName) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'submit', resolve });
      if (!sendFrame(frameSubmit(id, prompt, targetName))) {
        pending.delete(id);
        resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout', message: 'broker 无响应' }); }
      }, 10000);
    });
  }

  // ---------- targets dropdown (targets.list → targets.result) ----------
  function requestTargets() {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve([]); return; }
      const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'targets', resolve });
      if (!sendFrame(frameTargetsList(id))) { pending.delete(id); resolve([]); return; }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve([]); }
      }, 5000);
    });
  }
  async function refreshTargets() {
    targets = await requestTargets();
    renderTargetSelect();
  }
  function renderTargetSelect() {
    const last = gm.get(GM_TARGET, '');
    elTarget.innerHTML = '';
    if (wsState !== 'on') {
      elTarget.appendChild(new Option('（未连接 broker）', ''));
      elTarget.disabled = true;
      return;
    }
    if (!targets.length) {
      elTarget.appendChild(new Option('（无活跃 local session）', ''));
      elTarget.disabled = true;
      return;
    }
    elTarget.disabled = false;
    for (const t of targets) {
      const label = t.name + ' — ' + (t.cwd || '?') + (t.status ? ' · ' + t.status : '');
      const o = new Option(label, t.name);
      if (t.name === last) o.selected = true;
      elTarget.appendChild(o);
    }
  }

  elTarget.addEventListener('change', () => {
    const v = elTarget.value.trim();
    if (v) gm.set(GM_TARGET, v);
  });
  elTRefresh.addEventListener('click', () => {
    if (wsState !== 'on') { openSettings(); return; }
    refreshTargets().then(() =>
      toast(targets.length ? '目标列表已刷新（' + targets.length + '）' : '没有发现活跃 local session'));
  });

  elSend.addEventListener('click', async () => {
    const prompt = elPrompt.value.trim();
    const target = elTarget.value.trim();
    if (!prompt) { toast('先写 prompt 指令'); elPrompt.focus(); return; }
    if (!target) {
      toast(wsState !== 'on' ? '先连接 broker（点击左下状态）' : '没有可用目标：先启动 pi session 的 xfer listen');
      return;
    }
    if (!loadBatch().length && !confirm('没有标注任何元素，只发 prompt？')) return;
    elSend.disabled = true;
    elSend.textContent = '发送中…';
    const res = await submitToAgent(prompt, target);
    elSend.disabled = false;
    elSend.textContent = '发送 →';
    if (res.ok) {
      gm.set(GM_TARGET, target);
      toast('已送达 agent（handoff ' + (res.result && res.result.handoff_id ? res.result.handoff_id : '?') + '）');
      elPrompt.value = '';
      clearBatch();
      renderPanel();
    } else {
      toast('发送失败: ' + res.code + (res.message ? ' — ' + res.message : ''));
    }
  });
  elClear.addEventListener('click', () => {
    const n = loadBatch().length;
    if (!n) return;
    if (confirm('清空本页全部 ' + n + ' 条标注？')) { clearBatch(); renderPanel(); }
  });
  elConn.addEventListener('click', () => {
    if (wsState === 'on') disconnectBroker();
    else if (wsState === 'off') openSettings();
  });

  // ---------- settings modal (broker URL only) ----------
  function openSettings() {
    elSUrl.value = brokerUrl();
    elSettings.style.display = 'block';
    setTimeout(() => elSUrl.focus(), 0);
  }
  function closeSettings() { elSettings.style.display = 'none'; }
  elSSave.addEventListener('click', () => {
    const url = elSUrl.value.trim() || DEFAULT_BROKER_URL;
    gm.set(GM_BROKER, url);
    closeSettings();
    toast('已保存，连接中…');
    connectBroker();
  });
  elSCancel.addEventListener('click', closeSettings);

  // ---------- reverse channel — page.request → ask modal → page.response ----------
  // One ask modal at a time; every inbound page.request gets exactly one reply:
  // 回复 → {ok:true, text}, 忽略/Esc → {ok:false, error:"dismissed"}. Entering
  // pick mode also dismisses (mutual exclusivity) so no request is left hanging.
  let askReq = null;               // active inbound request {id, handoff_id, from, text}
  function openAsk(f) {
    if (askReq) dismissAsk();      // a newer question supersedes an unanswered one
    if (pickMode) setActive(false);
    askReq = { id: f.id, handoff_id: f.handoff_id, from: f.from, text: f.text };
    elAskQ.textContent = f.text || '(空问题)';
    elAskMeta.textContent = 'from: ' + (f.from || '?') +
      (f.handoff_id ? ' · handoff: ' + f.handoff_id : '');
    elAskTxt.value = '';
    elAsk.style.display = 'block';
    setTimeout(() => elAskTxt.focus(), 0);
    toast('收到 agent 提问');
  }
  function replyAsk() {
    if (!askReq) return;
    const text = elAskTxt.value.trim();
    if (!text) { toast('先写回答'); elAskTxt.focus(); return; }
    const req = askReq;
    askReq = null;
    elAsk.style.display = 'none';
    if (sendFrame(framePageResponse(req.id, true, text))) toast('已回复 agent');
    else toast('发送失败: broker 未连接');
  }
  function dismissAsk() {
    if (!askReq) return;
    const req = askReq;
    askReq = null;
    elAsk.style.display = 'none';
    sendFrame(framePageResponse(req.id, false, 'dismissed'));
  }
  elAskSend.addEventListener('click', replyAsk);
  elAskIgnore.addEventListener('click', dismissAsk);

  elOk.addEventListener('click', submit);
  elCancel.addEventListener('click', unpin);

  // ---------- freeze UI / hotkeys ----------
  function updateFreezeUI() {
    const fz = $('fz');
    if (!fz) return;
    fz.classList.toggle('on', frozen);
    fz.title = frozen ? '冻结：页面交互已屏蔽，浮层不会因点击/hover 关闭' : '实时：hover 可触发页面（展开子菜单等）';
  }
  window.addEventListener('keydown', (e) => {
    const isHot = e.code === HOTKEY.code && e.altKey === HOTKEY.alt && e.shiftKey === HOTKEY.shift && !e.ctrlKey && !e.metaKey;
    const isList = e.code === 'KeyL' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (isList) { e.preventDefault(); e.stopPropagation(); togglePanel(); return; }
    if (isHot) {
      e.preventDefault(); e.stopPropagation();
      if (pickMode) { if (pinned) unpin(); else setActive(false); }
      else setActive(true);
      return;
    }
    if (pickMode && !pinned && e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      frozen = !frozen;
      updateFreezeUI();
      toast(frozen ? '冻结：页面交互已屏蔽' : '实时：hover 可触发页面');
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (panelOpen && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); closePanel(); return;
    }
    if (askReq && !e.isComposing && e.keyCode !== 229) {
      const firstTarget = (e.composedPath && e.composedPath()[0]) || e.target;
      if (e.key === 'Enter' && !e.shiftKey && firstTarget === elAskTxt) {
        e.preventDefault(); e.stopPropagation(); replyAsk(); return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); dismissAsk(); return;
      }
    }
    if (!pickMode) return;
    if (pinned) {
      if (e.isComposing || e.keyCode === 229) return;
      const firstTarget = (e.composedPath && e.composedPath()[0]) || e.target;
      if (e.key === 'Enter' && firstTarget === elTxt && !e.shiftKey) {
        e.preventDefault(); submit();
      } else if (e.key === 'Escape') {
        unpin();
      }
      return;
    }
    switch (e.key) {
      case ']': case 'ArrowDown': e.preventDefault(); shiftLayer(1); break;
      case '[': case 'ArrowUp': e.preventDefault(); shiftLayer(-1); break;
      case 'Enter': case ' ': e.preventDefault(); pin(); break;
      case 'Escape': e.preventDefault(); setActive(false); break;
      default:
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); idx = Math.min(stack.length - 1, +e.key - 1); refresh(); }
    }
  }, true);

  window.addEventListener('scroll', () => { if (pickMode) refresh(); }, true);
  window.addEventListener('resize', () => { if (pickMode) refresh(); }, true);

  refreshCount();
  renderTargetSelect();
  debugLog('ready — ⇧⌥P 拾取 · ⇧⌥L 面板 · ' + location.host);

  // ---------- programmatic API (DevTools console) ----------
  window.__PI_WP_API__ = {
    start: () => { setActive(true); return true; },
    stop: () => { setActive(false); return true; },
    panel: togglePanel,
    connect: connectBroker,
    disconnect: disconnectBroker,
    settings: openSettings,
    send: (prompt, target) => submitToAgent(prompt, target),
    targets: () => targets.slice(),
    ask: () => (askReq ? Object.assign({}, askReq) : null),
    refreshTargets: refreshTargets,
    snapshot: loadBatch,
    setDebug: (on) => { gm.set(GM_DEBUG, !!on); return !!on; },
  };

  // ---------- Tampermonkey menu ----------
  try {
    GM_registerMenuCommand('连接 broker', () => connectBroker());
    GM_registerMenuCommand('断开 broker', () => disconnectBroker());
    GM_registerMenuCommand('连接设置…', openSettings);
    GM_registerMenuCommand('打开标注面板 (⇧⌥L)', togglePanel);
    GM_registerMenuCommand('开始拾取 (⇧⌥P)', () => setActive(true));
  } catch (e) { /* menu registration unavailable in this manager */ }
})();
