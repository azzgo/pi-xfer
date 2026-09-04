// ==UserScript==
// @name         Xfer Web Picker
// @namespace    pi.dotfiles
// @version      1.9.0
// @description  元素拾取 + 备注批注 + broker 连接/send + 页面工具只读采集（v1.9：拾取永不互相覆盖 + cssPath 同 tag 兄弟强制 nth-of-type + send 附带反向查询时机规则）
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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
 * Broker layer (new in v1.1; protocol v0.1 — NO token, localhost-trust model):
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
 *      in pick mode ⇧Enter/⇧click add elements to a group, Enter submits its note.
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
  const GM_FPROPS = 'wp.frameworkProps';   // framework.inspect props/state opt-in (default off)
  const DEFAULT_BROKER_URL = 'ws://127.0.0.1:4719';

  // page-tool capture/result caps + computed-style defaults (v1.6)
  const CAPTURE_MAX = 200;                 // ring buffer size for console/network entries
  const RESULT_MAX_CHARS = 500000;         // page.response text budget (broker frames cap at 1MB)
  const DEFAULT_STYLE_PROPS = ['display', 'position', 'color', 'background-color', 'font-size',
    'font-weight', 'font-family', 'line-height', 'text-align', 'overflow', 'z-index', 'opacity',
    'visibility', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
    'flex-direction', 'gap'];

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

  // Fixed page-tool op table (v1.6) — the only ops page.request{tool} may invoke.
  const PAGE_OPS = {
    INFO: 'page.info',
    DOM_QUERY: 'dom.query',
    DOM_HTML: 'dom.html',
    CONSOLE_LOGS: 'console.logs',
    NETWORK_LOG: 'network.log',
    FRAMEWORK_INSPECT: 'framework.inspect',
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
  // 每次拾取都是独立记录，即使 selector 相同也不覆盖——同一元素重复选、或两个
  // 元素恰好生成同一选择器（历史上出现过）时，各自的 note 都要保留。去重交给了
  // 选择器本身的区分度（cssPath 对同 tag 兄弟强制 nth-of-type）。
  function addPick(rec) {
    const b = loadBatch();
    b.push(rec);
    saveBatch(b);
    toast('已选中 ' + rec.selector);
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
      const sibs = cur.parentElement
        ? Array.from(cur.parentElement.children).filter((s) => s.nodeName === cur.nodeName)
        : [cur];
      // 同 tag 兄弟 >1 时一律补 nth-of-type——class/stable-attr 分支也要，否则
      // 同一 table 里同 class 的不同单元格会生成完全相同的选择器（互相覆盖、
      // agent 反解时也只能命中第一个）。
      const nth = sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : '';
      const stable = ['data-testid', 'data-test', 'data-component', 'data-cy', 'name']
        .find((a) => cur.getAttribute && cur.getAttribute(a));
      if (stable) {
        parts.unshift(sel + '[' + stable + '="' + cssEscape(String(cur.getAttribute(stable))) + '"]' + nth);
      } else {
        const cls = Array.from(cur.classList || []).filter((c) => c.length > 1).slice(0, 2);
        if (cls.length) {
          parts.unshift(sel + '.' + cls.map(cssEscape).join('.') + nth);
        } else {
          parts.unshift(sel + nth);
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
      /* ---- pending group marks (shift-group) ---- */
      #gwrap { position: fixed; inset: 0; pointer-events: none; display: none; }
      .gmark { position: fixed; margin: 0; border: 2px dashed var(--wp-amber);
        background: rgba(245,158,11,.10); border-radius: 3px; pointer-events: none; }
      .gmark .gi { position: absolute; top: -16px; left: -2px; background: var(--wp-amber);
        color: #fff; font: 700 10px/16px var(--wp-mono); padding: 0 5px;
        border-radius: 4px 4px 4px 0; white-space: nowrap; }
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
      #bar #gh.on kbd { background: #451a03; border-color: #b45309; color: #fde68a; }
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
      #card, #panel, #settings {
        background: #fff; border: 1px solid var(--wp-line); border-radius: var(--wp-radius);
        box-shadow: var(--wp-shadow); color: var(--wp-ink);
        font: 13px/1.5 var(--wp-font); z-index: 2147483647; pointer-events: auto;
      }
      #card { position: fixed; width: 300px; padding: 14px; display: none; }
      #card .sel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
        border: 1px solid var(--wp-line); padding: 6px 8px; border-radius: 8px;
        word-break: break-all; white-space: pre-wrap; margin-bottom: 10px; max-height: 70px; overflow: auto; }
      #card .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
      /* ---- shared form controls ---- */
      textarea, input, select {
        width: 100%; border: 1px solid var(--wp-line); border-radius: 8px; padding: 7px 10px;
        font: 12.5px/1.5 var(--wp-font); background: #fff; color: var(--wp-ink);
        outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      }
      textarea { resize: vertical; min-height: 44px; }
      textarea:focus, input:focus {
        border-color: var(--wp-accent); box-shadow: 0 0 0 3px rgba(79,140,255,.14);
      }
      input { font-family: var(--wp-mono); font-size: 12px; }
      input:disabled { background: var(--wp-soft); color: var(--wp-muted); cursor: not-allowed; }
      /* ---- target combobox（可搜索下拉，取代原生 <select>）---- */
      #tcombo { position: relative; flex: 1; min-width: 0; }
      #tdrop { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10;
        background: #fff; border: 1px solid var(--wp-line); border-radius: 10px;
        box-shadow: var(--wp-shadow); padding: 4px; max-height: 224px; overflow-y: auto; display: none; }
      #tdrop.open { display: block; }
      #tdrop::-webkit-scrollbar { width: 8px; }
      #tdrop::-webkit-scrollbar-thumb { background: #dde4ec; border-radius: 4px; }
      #tdrop .titem { padding: 6px 9px; border-radius: 7px; cursor: pointer; }
      #tdrop .titem.hl { background: #eaf1ff; }
      #tdrop .tname { font: 600 12px/1.45 var(--wp-mono); color: var(--wp-ink); word-break: break-all; }
      #tdrop .tname b, #tdrop .tsub b { color: var(--wp-accent-deep); }
      #tdrop .tsub { font: 10.5px/1.45 var(--wp-mono); color: var(--wp-muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #tdrop .tick { color: var(--wp-green); font-weight: 700; }
      #tdrop .tempty { padding: 12px 8px; text-align: center; color: #94a3b8; font-size: 12px; }
      #tdrop .thint { margin-top: 3px; padding: 5px 9px 2px; border-top: 1px solid var(--wp-line);
        color: #94a3b8; font-size: 10px; }
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
      /* 不设 overflow:hidden —— sendbox 里的 target 下拉需要向上溢出面板显示 */
      #panel { position: fixed; top: 60px; right: 16px; width: 348px; max-height: 80vh;
        display: none; flex-direction: column; }
      #panel .ph { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
        background: var(--wp-soft); border-bottom: 1px solid var(--wp-line); user-select: none;
        border-radius: var(--wp-radius) var(--wp-radius) 0 0; }
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
      #plist .item .pgroup { display: inline-block; margin-top: 4px; padding: 1px 7px;
        background: #fffbeb; border: 1px solid #fde68a; border-radius: 999px;
        color: #b45309; font: 600 10px/1.6 var(--wp-mono); }
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
      #settings .chk { margin-top: 12px; font-size: 12px; color: var(--wp-muted); display: flex;
        gap: 7px; align-items: center; cursor: pointer; user-select: none; }
      #settings input[type="checkbox"] { width: auto; margin: 0; }
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
    <div id="gwrap"></div>
    <div id="badge"></div>
    <div id="info"></div>
    <div id="bar"><b>PICK</b>
      <span class="muted"><kbd>[</kbd><kbd>]</kbd>切层</span>
      <span class="muted"><kbd>1</kbd>-<kbd>9</kbd>跳层</span>
      <span class="muted"><kbd>Enter</kbd>选中</span>
      <span class="muted" id="gh"><kbd>⇧Enter</kbd>加组</span>
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
        <div class="lbl">发送到 agent（prompt 指令，可留空）</div>
        <textarea id="prompt" placeholder="要让 agent 做什么？留空 = 回应各标注的 note / 解释元素渲染逻辑"></textarea>
        <div class="trow">
          <span class="lbl">目标</span>
          <div id="tcombo">
            <input id="tinput" placeholder="未连接 broker" autocomplete="off" spellcheck="false" />
            <div id="tdrop"></div>
          </div>
          <button class="ghost icon" id="trefresh" title="刷新 target 列表">⟳</button>
        </div>
        <div class="srow">
          <span id="connstate"><span class="dot"></span><span id="conntext">未连接 · 点击连接</span></span>
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
      <label class="chk"><input type="checkbox" id="sprops" /> framework.inspect 附带组件 props/state（默认关）</label>
      <div class="row">
        <button class="ghost" id="scancel">取消</button>
        <button class="primary" id="ssave">保存并连接</button>
      </div>
    </div>
  `;

  const $ = (id) => root.getElementById(id);
  const elHL = $('hl'), elGWrap = $('gwrap'), elBadge = $('badge'), elInfo = $('info'), elBar = $('bar'), elGH = $('gh'),
        elFab = $('fab'), elCnt = $('cnt'), elDot = $('dot'), elCard = $('card'), elSel = $('sel'),
        elTxt = $('txt'), elOk = $('ok'), elCancel = $('cancel'), elToast = $('toast'),
        elPanel = $('panel'), elPlist = $('plist'), elPcount = $('pcount'), elPclose = $('pclose'),
        elPrompt = $('prompt'), elTCombo = $('tcombo'), elTInput = $('tinput'), elTDrop = $('tdrop'),
        elTRefresh = $('trefresh'),
        elSend = $('sendbtn'), elClear = $('clearbtn'),
        elConn = $('connstate'), elConnText = $('conntext'), elSettings = $('settings'),
        elSUrl = $('sburl'), elSSave = $('ssave'), elSCancel = $('scancel'), elSProps = $('sprops');

  // ---------- state ----------
  let pickMode = false;
  let stack = [];
  let idx = 0;
  let pinned = null;
  let frozen = true;
  // v1.5 shift-group：待处理组合（元素引用，按加入顺序）。仅存内存——DOM 引用无法
  // 进 sessionStorage；提交后随批次落库，退出拾取模式不清空以便误退后能恢复。
  let groupEls = [];
  let groupCard = false;               // note card 当前是否为组备注模式
  let pos = { x: window.innerWidth - 68, y: window.innerHeight - 96 };
  try {
    const saved = sessionStorage.getItem(KEY_POS);
    if (saved) { const p = JSON.parse(saved); if (typeof p.x === 'number' && typeof p.y === 'number') pos = p; }
  } catch (e) { /* fall back to default position */ }
  // 视口缩小（如打开 devtools）后保存的位置可能落在可视区外，统一 clamp 回来
  function clampFabPos() {
    pos.x = Math.max(4, Math.min(window.innerWidth - 50, pos.x));
    pos.y = Math.max(4, Math.min(window.innerHeight - 50, pos.y));
  }
  clampFabPos();
  elFab.style.left = pos.x + 'px';
  elFab.style.top = pos.y + 'px';
  window.addEventListener('resize', () => {
    clampFabPos();
    elFab.style.left = pos.x + 'px';
    elFab.style.top = pos.y + 'px';
    try { sessionStorage.setItem(KEY_POS, JSON.stringify(pos)); } catch (err) { /* position won't persist */ }
  }, true);

  // ---------- trigger 重注入 ----------
  // SPA 路由跳转 / HMR 热更新可能把 documentElement 下的外来节点清掉，host 一旦
  // 被移除 fab 就消失；脚本闭包里的状态都还在，把 host 重新挂回去即可整体恢复。
  function reinjectTrigger() {
    if (host.isConnected) return true;
    document.documentElement.appendChild(host);
    clampFabPos();
    elFab.style.left = pos.x + 'px';
    elFab.style.top = pos.y + 'px';
    return host.isConnected;
  }
  new MutationObserver(() => { if (!host.isConnected) reinjectTrigger(); })
    .observe(document.documentElement, { childList: true });

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
    pickMode = on;
    host.style.pointerEvents = 'none';
    elBar.style.display = on ? 'flex' : 'none';
    elFab.style.display = on ? 'none' : 'block';
    document.body.style.cursor = on ? 'crosshair' : '';
    if (on) { frozen = true; closePanel(); renderGroupMarks(); }
    else {
      pinned = null; frozen = false;
      closeGroupCard();
      elCard.style.display = 'none'; elHL.style.display = 'none'; elBadge.style.display = 'none'; elInfo.style.display = 'none';
      renderGroupMarks();           // pickMode 已为 false → 隐藏 marks（组合本身保留在内存）
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
    if (pinned || groupCard || isOurUI(e)) return;   // 卡片打开期间高亮冻结
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
      if (!btn0 || groupCard) return;             // 组备注卡片打开期间吞掉页面点击
      if (!pinned) { if (e.shiftKey) groupAt(e.clientX, e.clientY); else pinAt(e.clientX, e.clientY); }
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

  // ---------- shift group (v1.5)：⇧Enter/⇧click 聚合 → 组 mark → 整组一条 note ----------
  function toggleGroup(el) {
    if (!el) return;
    const i = groupEls.indexOf(el);
    if (i >= 0) { groupEls.splice(i, 1); toast('已移出组合（剩 ' + groupEls.length + ' 项）'); }
    else { groupEls.push(el); toast('已加入组合（共 ' + groupEls.length + ' 项）'); }
    renderGroupMarks();
    updateGroupUI();
  }
  function groupAt(x, y) {
    const st = stackAt(x, y);
    if (!st.length) return;
    stack = st;
    idx = 0;
    toggleGroup(st[0]);
  }
  function renderGroupMarks() {
    elGWrap.innerHTML = '';
    if (!pickMode || !groupEls.length) { elGWrap.style.display = 'none'; return; }
    elGWrap.style.display = 'block';
    groupEls.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;          // 元素已随页面变化消失
      const m = document.createElement('div');
      m.className = 'gmark';
      Object.assign(m.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      const tag = document.createElement('span');
      tag.className = 'gi';
      tag.textContent = String(i + 1);
      m.appendChild(tag);
      elGWrap.appendChild(m);
    });
  }
  function updateGroupUI() {
    const n = groupEls.length;
    elGH.classList.toggle('on', n > 0);
    elGH.innerHTML = '<kbd>⇧Enter</kbd>加组' +
      (n ? ' · <kbd>Enter</kbd>组备注(' + n + ')' : '');
  }
  function openGroupCard() {
    if (!groupEls.length || pinned) return;
    groupCard = true;
    const r = groupEls[0].getBoundingClientRect();
    let left = r.right + 10;
    if (left + 300 > window.innerWidth) left = Math.max(8, r.left - 310);
    let top = r.top;
    if (top + 240 > window.innerHeight) top = Math.max(8, window.innerHeight - 250);
    elSel.textContent = groupEls.map((el) => cssPath(el)).join('\n');
    elTxt.value = '';
    elTxt.placeholder = '组备注（可选，整组共用这一条）';
    elOk.textContent = '✓ 提交 ' + groupEls.length + ' 项 Enter';
    Object.assign(elCard.style, { display: 'block', left: left + 'px', top: top + 'px' });
    setTimeout(() => elTxt.focus(), 0);
  }
  function closeGroupCard() {
    if (!groupCard) return;
    groupCard = false;
    elCard.style.display = 'none';
    elTxt.placeholder = '备注（可选，留空直接回车提交）';
    elOk.textContent = '✓ 确认 Enter';
  }
  function submitGroup() {
    if (!groupCard || !groupEls.length) return;
    const note = elTxt.value.trim();
    const gid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const b = loadBatch();
    groupEls.forEach((el) => b.push(Object.assign(payloadFor(el, note), { group: gid })));
    saveBatch(b);
    refreshCount();
    const n = groupEls.length;
    groupEls = [];
    renderGroupMarks();
    updateGroupUI();
    closeGroupCard();
    toast('已选中 ' + n + ' 项 · 组 ' + gid);
  }

  // payload schema is the v0 wire format — the broker revision consumes these
  // records verbatim, so field names/shapes here must stay stable. Optional
  // additions so far: `group` (v1.5, shift-group link id) and `id`/`classes`/
  // `attributes` (v1.6, richer element context so the agent rarely needs a
  // follow-up dom.query). Old consumers ignore unknown fields.
  function payloadFor(el, note) {
    const r = el.getBoundingClientRect();
    const attributes = {};
    try {
      for (const a of Array.from(el.attributes).slice(0, 20)) {
        attributes[a.name] = (a.value || '').slice(0, 120);   // values truncated; boolean attrs stay ""
      }
    } catch (e) { /* attribute access is best-effort */ }
    return {
      selector: cssPath(el),
      xpath: xPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.from(el.classList || []),
      attributes,
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
        (r.group ? '<div class="pgroup">⧉ 组 ' + escapeHtml(r.group) + '</div>' : '') +
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
    if (wsState === 'on') refreshTargets(); else renderTargetCombo();
  }
  function closePanel() { panelOpen = false; closeDrop(); elPanel.style.display = 'none'; }
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
    let synced = 0;
    if (b[i].group) {                    // 组共享一条 note：改任一成员即同步整组
      for (let j = 0; j < b.length; j++) {
        if (j === i || b[j].group !== b[i].group) continue;
        b[j].note = b[i].note;
        synced++;
        const ta = elPlist.querySelector('.item[data-i="' + j + '"] textarea');
        if (ta) ta.value = b[i].note;    // DOM 直改，避免整表重渲染抢焦点
      }
    }
    saveBatch(b);
    toast('备注已保存' + (synced ? '（已同步组内 ' + synced + ' 项）' : ''));
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
  let connectSettle = null;            // 在途 connect 的结算回调（welcome→true / close→false）
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
    elConn.title = s === 'on' ? '点击断开 broker' : s === 'connecting' ? '连接中…' : '点击连接 broker（失败会打开连接设置）';
    elConnText.textContent = s === 'on' ? 'broker 已连接'
      : s === 'connecting' ? '连接中…'
      : '未连接 · 点击连接';
    if (s !== 'on') { targets = []; renderTargetCombo(); }
  }

  // 返回 Promise：welcome 兑现 true；构造失败/close（含 onerror 后的必然 close）兑现 false。
  // fire-and-forget 调用方（菜单、settings 保存、API）照旧忽略返回值。
  function connectBroker() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    const url = brokerUrl().replace(/\/+$/, '') + '/ws';
    setWsState('connecting');
    let settle;
    const attempt = new Promise((resolve) => { settle = resolve; });
    connectSettle = settle;
    let sock;
    try { sock = new WebSocket(url); }
    catch (e) {
      connectSettle = null;
      setWsState('off');
      toast('WS 创建失败: ' + e.message);
      settle(false);
      return attempt;
    }
    ws = sock;
    sock.onopen = () => { sendFrame(frameHello()); };
    sock.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (!f || typeof f.type !== 'string') return;
      if (f.type === PROTOCOL.KIND_WELCOME) {
        setWsState('on');
        toast('broker 已连接');
        const settled = connectSettle; connectSettle = null;
        if (settled) settled(true);
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
        debugLog('page.request', f.id, f.tool && f.tool.op);
        handlePageToolRequest(f);
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
      const settled = connectSettle; connectSettle = null;
      if (settled) settled(false);           // 握手未完成即断开 = 配对失败
      if (wsState !== 'off') { setWsState('off'); toast('broker 连接已断开'); }
    };
    sock.onerror = () => {
      if (ws === sock && wsState !== 'off') {
        setWsState('off');
        toast('broker 连不上: ' + url + '（连接设置里可改地址）');
      }
    };
    return attempt;
  }

  function disconnectBroker() {
    setWsState('off');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    toast('已断开');
  }

  // ---------- send flow (annotation.submit → ack/error) ----------
  // prompt 可留空：留空时落 DEFAULT_PROMPT——逐条回应标注 note / 解释元素渲染逻辑。
  // broker 端 v0 校验要求 prompt 非空，所以默认值在这一侧补齐，线上帧始终带具体指令。
  const DEFAULT_PROMPT = '请逐条回应本页标注：note 写了要求的按 note 处理；没写 note 的，请解释该元素的渲染逻辑（组件与样式来源）。';
  // 反向查询规则随每次 send 下发（prompt 尾部追加）：HMR 改代码失败会整页刷新，
  // 刷新即断开 userscript ↔ broker 连接，此后的 page.request 全部无人应答。
  const PAGE_QUERY_RULE = '\n\n[页面查询规则] 反向查询本页（page.request：dom.query / dom.html / framework.inspect 等）只能在开始修改代码之前进行；需要 DOM、样式、组件链信息时请在动第一行代码前一次性查完。一旦开始改代码，HMR 无法热更新时浏览器会整页刷新，userscript 与 broker 的连接会随刷新断开，此后的 page.request 不会再有响应，不要浪费尝试。';
  function submitToAgent(prompt, targetName) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'submit', resolve });
      const promptText = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT) + PAGE_QUERY_RULE;
      if (!sendFrame(frameSubmit(id, promptText, targetName))) {
        pending.delete(id);
        resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout', message: 'broker 无响应' }); }
      }, 10000);
    });
  }

  // ---------- targets (targets.list → targets.result) + searchable combobox ----------
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
    renderTargetCombo();
  }

  // ---------- target combobox — 可搜索下拉（目标一多，原生 <select> 翻起来太麻烦） ----------
  // focus/点击展开、输入即按 name/cwd/status 过滤、↑↓ 高亮、Enter 或点击选中、
  // Esc / 点击外部收起；选中即写回 GM wp.lastTarget，与旧 <select> 的 change 语义一致。
  let comboSel = '';       // 当前选中的 target name（'' = 无）
  let comboFilter = '';    // 下拉展开期间的过滤词
  let comboHl = 0;         // 过滤结果中的高亮下标
  let comboOpen = false;

  function comboList() {
    const q = comboFilter.trim().toLowerCase();
    if (!q) return targets.slice();
    return targets.filter((t) =>
      ((t.name || '') + ' ' + (t.cwd || '') + ' ' + (t.status || '')).toLowerCase().includes(q));
  }
  function markMatch(text, q) {
    const s = String(text == null ? '' : text);
    const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return escapeHtml(s);
    return escapeHtml(s.slice(0, i)) + '<b>' + escapeHtml(s.slice(i, i + q.length)) + '</b>' +
      escapeHtml(s.slice(i + q.length));
  }
  function renderDrop() {
    if (!targets.length) { elTDrop.innerHTML = '<div class="tempty">（无活跃 local session）</div>'; return; }
    const list = comboList();
    if (!list.length) { elTDrop.innerHTML = '<div class="tempty">无匹配目标</div>'; return; }
    if (comboHl >= list.length) comboHl = list.length - 1;
    if (comboHl < 0) comboHl = 0;
    const q = comboFilter.trim();
    elTDrop.innerHTML = list.map((t, i) => {
      const sub = (t.cwd || '?') + (t.status ? ' · ' + t.status : '');
      return '<div class="titem' + (i === comboHl ? ' hl' : '') + '" data-name="' + escapeHtml(t.name) + '">' +
        '<div class="tname">' + (q ? markMatch(t.name, q) : escapeHtml(t.name)) +
          (t.name === comboSel ? ' <span class="tick">✓</span>' : '') + '</div>' +
        '<div class="tsub">' + (q ? markMatch(sub, q) : escapeHtml(sub)) + '</div>' +
      '</div>';
    }).join('') + '<div class="thint">输入过滤 · ↑↓ 选择 · Enter 确认 · Esc 关闭</div>';
    const hl = elTDrop.querySelector('.titem.hl');     // 键盘移动时保持高亮行可见
    if (hl) {
      if (hl.offsetTop < elTDrop.scrollTop) elTDrop.scrollTop = hl.offsetTop;
      else if (hl.offsetTop + hl.offsetHeight > elTDrop.scrollTop + elTDrop.clientHeight)
        elTDrop.scrollTop = hl.offsetTop + hl.offsetHeight - elTDrop.clientHeight;
    }
  }
  function openDrop(selectAll) {
    if (elTInput.disabled || comboOpen) return;
    comboOpen = true;
    comboFilter = '';
    comboHl = Math.max(0, targets.findIndex((t) => t.name === comboSel));
    elTDrop.classList.add('open');
    renderDrop();
    if (selectAll) setTimeout(() => elTInput.select(), 0);  // 全选现有文本：直接输入即开始过滤
  }
  function closeDrop() {
    if (!comboOpen) return;
    comboOpen = false;
    elTDrop.classList.remove('open');
    elTInput.value = comboSel;          // 还原为已选目标的展示
  }
  function pickTarget(name) {
    if (!name) return;
    comboSel = name;
    gm.set(GM_TARGET, name);
    closeDrop();
    elTInput.blur();
    toast('目标已切换：' + name);
  }
  function renderTargetCombo() {
    const last = gm.get(GM_TARGET, '');
    comboSel = '';
    elTInput.disabled = true;
    elTInput.value = '';
    elTInput.placeholder = wsState !== 'on' ? '未连接 broker' : '无活跃 local session';
    closeDrop();
    if (wsState !== 'on' || !targets.length) return;
    elTInput.disabled = false;
    comboSel = targets.some((t) => t.name === last) ? last : targets[0].name;
    if (comboOpen) renderDrop(); else elTInput.value = comboSel;
  }

  elTInput.addEventListener('focus', () => openDrop(true));
  elTInput.addEventListener('input', () => {
    if (!comboOpen) openDrop(false);
    comboFilter = elTInput.value;
    comboHl = 0;
    renderDrop();
  });
  elTInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // IME 组字中：交给输入法
    if (!comboOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') { e.preventDefault(); openDrop(true); }
      return;
    }
    const list = comboList();
    if (e.key === 'ArrowDown') { e.preventDefault(); comboHl = Math.min(list.length - 1, comboHl + 1); renderDrop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); comboHl = Math.max(0, comboHl - 1); renderDrop(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[comboHl]) pickTarget(list[comboHl].name); }
  });
  elTDrop.addEventListener('mousemove', (e) => {
    const it = e.target && e.target.closest ? e.target.closest('.titem') : null;
    if (!it) return;
    const items = elTDrop.querySelectorAll('.titem');
    const i = Array.prototype.indexOf.call(items, it);
    if (i < 0 || i === comboHl) return;
    if (items[comboHl]) items[comboHl].classList.remove('hl');
    it.classList.add('hl');
    comboHl = i;
  });
  elTDrop.addEventListener('click', (e) => {
    const it = e.target && e.target.closest ? e.target.closest('.titem') : null;
    if (it) pickTarget(it.getAttribute('data-name') || '');
  });
  // 点击 combo 之外收起下拉——不走 blur：blur 会在点击选项命中前抢先收起下拉
  window.addEventListener('pointerdown', (e) => {
    if (!comboOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(elTCombo) >= 0) return;
    closeDrop();
  }, true);
  elTRefresh.addEventListener('click', () => {
    if (wsState !== 'on') { openSettings(); return; }
    refreshTargets().then(() =>
      toast(targets.length ? '目标列表已刷新（' + targets.length + '）' : '没有发现活跃 local session'));
  });

  elSend.addEventListener('click', async () => {
    const prompt = elPrompt.value.trim();            // 可留空 → submitToAgent 落到 DEFAULT_PROMPT
    const target = comboSel;
    if (!target) {
      toast(wsState !== 'on' ? '先连接 broker（点击左下状态）' : '没有可用目标：先启动 pi session 的 xfer listen');
      return;
    }
    const hasPicks = loadBatch().length > 0;
    if (!prompt && !hasPicks) { toast('先标注元素或写 prompt'); return; }
    if (!hasPicks && !confirm('没有标注任何元素，只发 prompt？')) return;
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
      closePanel();                              // 发送成功即收起面板；重开显示空态
    } else {
      toast('发送失败: ' + res.code + (res.message ? ' — ' + res.message : ''));
    }
  });
  elClear.addEventListener('click', () => {
    const n = loadBatch().length;
    if (!n) return;
    if (confirm('清空本页全部 ' + n + ' 条标注？')) { clearBatch(); renderPanel(); }
  });
  // 未连接时点击 = 直接按已存/默认地址发起连接（不再先弹设置）；仅配对失败才打开设置
  elConn.addEventListener('click', () => {
    if (wsState === 'on') { disconnectBroker(); return; }
    if (wsState !== 'off') return;                 // connecting 中：等本次尝试出结果
    toast('正在连接 ' + brokerUrl() + ' …');
    connectBroker().then((ok) => { if (!ok) openSettings(); });
  });

  // ---------- settings modal (broker URL + framework props opt-in) ----------
  function openSettings() {
    elSUrl.value = brokerUrl();
    elSProps.checked = gm.get(GM_FPROPS, false) === true;
    elSettings.style.display = 'block';
    setTimeout(() => elSUrl.focus(), 0);
  }
  function closeSettings() { elSettings.style.display = 'none'; }
  elSProps.addEventListener('change', () => {
    gm.set(GM_FPROPS, elSProps.checked);   // immediate persist — no reconnect needed to toggle
    toast('framework.inspect props/state ' + (elSProps.checked ? '已开启' : '已关闭'));
  });
  elSSave.addEventListener('click', () => {
    const url = elSUrl.value.trim() || DEFAULT_BROKER_URL;
    gm.set(GM_BROKER, url);
    closeSettings();
    toast('已保存，连接中…');
    connectBroker();
  });
  elSCancel.addEventListener('click', closeSettings);

  // ---------- page tools — page.request{tool:{op,params}} → fixed read-only op → page.response ----------
  // No human modal, no free-form eval: the op table below is the entire attack
  // surface, all handlers are read-only, and every result passes through
  // jsonSafe (depth/string/array caps) so JSON.stringify can never throw or
  // blow the 1MB broker frame budget on its own.

  // JSON-safe serialization: drops/flat-marks everything a JSON round trip
  // cannot carry (functions, symbols, cycles via depth cap, huge strings).
  const JSON_SAFE_CAPS = { maxDepth: 5, maxStr: 100000, maxArray: 500, maxKeys: 200 };
  function jsonSafe(value) {
    let truncated = false;
    function walk(v, depth) {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
      if (v === undefined) return null;
      if (typeof v === 'bigint' || typeof v === 'symbol') { truncated = true; return String(v); }
      if (typeof v === 'function') { truncated = true; return 'ƒ ' + (v.name || 'anonymous'); }
      if (typeof v === 'string') {
        if (v.length > JSON_SAFE_CAPS.maxStr) { truncated = true; return v.slice(0, JSON_SAFE_CAPS.maxStr) + '…[truncated]'; }
        return v;
      }
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: walk(v.stack == null ? '' : String(v.stack), depth + 1) };
      }
      if (depth >= JSON_SAFE_CAPS.maxDepth) { truncated = true; return '[maxDepth]'; }
      if (Array.isArray(v)) {
        if (v.length > JSON_SAFE_CAPS.maxArray) truncated = true;
        return v.slice(0, JSON_SAFE_CAPS.maxArray).map((x) => walk(x, depth + 1));
      }
      if (typeof v !== 'object') { truncated = true; return String(v); }
      const out = {};
      let keys;
      try { keys = Object.keys(v); } catch (e) { truncated = true; return '[uninspectable]'; }
      if (keys.length > JSON_SAFE_CAPS.maxKeys) truncated = true;
      for (const k of keys.slice(0, JSON_SAFE_CAPS.maxKeys)) {
        try { out[k] = walk(v[k], depth + 1); } catch (e) { truncated = true; out[k] = '[error]'; }
      }
      return out;
    }
    let text;
    try { text = JSON.stringify(walk(value, 0)); }
    catch (e) { truncated = true; text = '"[unserializable]"'; }
    return { text: text === undefined ? 'null' : text, truncated };
  }

  // ---------- always-on capture — console.* + fetch/XHR ring buffers ----------
  // Best-effort patch of the PAGE realm (unsafeWindow when available): sandbox-
  // realm wrappers never see page-realm calls. Firefox Xray may reject function
  // patching — everything is try/catch-wrapped; worst case capture is silent.
  const consoleRing = [];   // {level, text, ts, stack?}
  const netRing = [];       // {method, url, status, durationMs, ts, error?}
  function ringPush(ring, rec) {
    ring.push(rec);
    if (ring.length > CAPTURE_MAX) ring.splice(0, ring.length - CAPTURE_MAX);
  }
  function captureRealm() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; }
    catch (e) { return window; }
  }
  function fmtCaptureArg(v) {
    try {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || String(v);
      const t = jsonSafe(v).text;
      return t.length > 400 ? t.slice(0, 400) + '…' : t;
    } catch (e) { return String(v); }
  }
  (function installCapture() {
    const realm = captureRealm();
    // console.*（跳过我们自己的 [pi.wp] 调试行，避免 debug 模式污染环形缓冲）
    try {
      for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
        const original = realm.console && typeof realm.console[level] === 'function' ? realm.console[level] : null;
        if (!original) continue;
        realm.console[level] = function (...args) {
          try {
            const first = typeof args[0] === 'string' ? args[0] : '';
            if (!first.startsWith('[pi.wp]')) {
              const rec = { level, text: args.map(fmtCaptureArg).join(' '), ts: Date.now() };
              if (level === 'error' && args[0] instanceof Error && args[0].stack) rec.stack = String(args[0].stack).slice(0, 2000);
              ringPush(consoleRing, rec);
            }
          } catch (e) { /* capture must never break the page */ }
          return original.apply(this === undefined ? realm.console : this, args);
        };
      }
    } catch (e) { /* console not patchable */ }
    try {
      realm.addEventListener('error', (ev) => {
        try {
          const err = ev && ev.error;
          ringPush(consoleRing, {
            level: 'error',
            text: (ev && ev.message) || 'window.onerror',
            stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
            ts: Date.now(),
          });
        } catch (e) { /* ignore */ }
      });
      realm.addEventListener('unhandledrejection', (ev) => {
        try {
          const reason = ev && ev.reason;
          ringPush(consoleRing, {
            level: 'error',
            text: 'unhandledrejection: ' + fmtCaptureArg(reason),
            stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : undefined,
            ts: Date.now(),
          });
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* realm listeners unavailable */ }
    try {
      const origFetch = realm.fetch;
      if (typeof origFetch === 'function') {
        realm.fetch = function (...args) {
          const started = Date.now();
          const req = args[0];
          const url = typeof req === 'string' ? req : (req && req.url) || '';
          const method = (args[1] && args[1].method) || (req && req.method) || 'GET';
          const done = (res, error) => {
            try {
              const rec = { method: String(method), url: String(url).slice(0, 500), ts: Date.now() };
              if (error) { rec.status = 0; rec.error = String((error && error.message) || error).slice(0, 200); }
              else rec.status = res && res.status;
              rec.durationMs = Date.now() - started;
              ringPush(netRing, rec);
            } catch (e) { /* ignore */ }
          };
          return origFetch.apply(this, args).then(
            (res) => { done(res); return res; },
            (err) => { done(null, err); throw err; },
          );
        };
      }
    } catch (e) { /* fetch not patchable */ }
    try {
      const XHR = realm.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        if (typeof origOpen === 'function' && typeof origSend === 'function') {
          XHR.prototype.open = function (method, url) {
            try { this.__wpNet = { method: String(method || 'GET'), url: String(url || '').slice(0, 500), started: 0 }; }
            catch (e) { /* Xray may refuse expando writes */ }
            return origOpen.apply(this, arguments);
          };
          XHR.prototype.send = function () {
            let meta = null;
            try { meta = this.__wpNet || null; } catch (e) { /* Xray */ }
            if (!meta) meta = { method: 'GET', url: '', started: Date.now() };
            meta.started = Date.now();
            try {
              this.addEventListener('loadend', () => {
                try {
                  ringPush(netRing, {
                    method: meta.method, url: meta.url, status: this.status,
                    durationMs: Date.now() - (meta.started || Date.now()), ts: Date.now(),
                  });
                } catch (e) { /* ignore */ }
              });
            } catch (e) { /* ignore */ }
            return origSend.apply(this, arguments);
          };
        }
      }
    } catch (e) { /* XHR not patchable */ }
  })();

  // ---------- tool handlers ----------
  function toolPageInfo() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      scroll: { x: window.scrollX, y: window.scrollY },
      ua: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled,
      ts: Date.now(),
    };
  }

  function elToolInfo(el, styleProps) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of styleProps) style[p] = cs.getPropertyValue(p);
    const attributes = {};
    for (const a of el.attributes) attributes[a.name] = a.value;
    return {
      selector: cssPath(el),
      xpath: xPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.from(el.classList || []),
      attributes,
      textPreview: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none',
      style,
    };
  }

  function toolDomQuery(params) {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) throw new Error('dom.query: params.selector (CSS) is required');
    const maxCount = Math.min(50, Math.max(1, Number(params.maxCount) || 10));
    const styleProps = Array.isArray(params.styleProps) && params.styleProps.length
      ? params.styleProps.filter((s) => typeof s === 'string').slice(0, 30)
      : DEFAULT_STYLE_PROPS;
    const all = document.querySelectorAll(selector);   // invalid selector throws → surfaced as the response error
    const nodes = Array.from(all).slice(0, maxCount);
    return {
      selector,
      matched: all.length,
      returned: nodes.length,
      elements: nodes.map((el) => elToolInfo(el, styleProps)),
    };
  }

  // Pruned outerHTML: depth-capped clone so full-page dumps stay bounded.
  function pruneClone(el, depth) {
    const clone = el.cloneNode(false);
    if (depth > 1) {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) {
          const t = (child.textContent || '').trim();
          if (t) clone.appendChild(document.createTextNode(t.slice(0, 80) + ' '));
        } else if (child.nodeType === 1) {
          clone.appendChild(pruneClone(child, depth - 1));
        }
      }
    } else if (el.childNodes && el.childNodes.length) {
      clone.appendChild(document.createTextNode('…'));
    }
    return clone;
  }

  function toolDomHtml(params) {
    const selector = typeof params.selector === 'string' ? params.selector : 'body';
    const maxLength = Math.min(200000, Math.max(200, Number(params.maxLength) || 20000));
    const maxDepth = Math.max(1, Math.min(20, Number(params.maxDepth) || 8));
    const target = document.querySelector(selector);
    if (!target) throw new Error('dom.html: no element matches ' + selector);
    let html = pruneClone(target, maxDepth).outerHTML;
    let truncated = false;
    if (html.length > maxLength) { html = html.slice(0, maxLength); truncated = true; }
    return { selector, maxDepth, length: html.length, truncated, html };
  }

  function toolConsoleLogs(params) {
    const lastN = Math.min(500, Math.max(1, Number(params.lastN) || 50));
    const sinceTs = typeof params.sinceTs === 'number' ? params.sinceTs : 0;
    const level = typeof params.level === 'string' ? params.level : null;
    const all = consoleRing.filter((e) => e.ts >= sinceTs && (!level || e.level === level));
    return { total: all.length, returned: Math.min(lastN, all.length), entries: all.slice(-lastN) };
  }

  function toolNetworkLog(params) {
    const lastN = Math.min(500, Math.max(1, Number(params.lastN) || 50));
    const filter = typeof params.urlFilter === 'string' ? params.urlFilter.toLowerCase() : null;
    const all = netRing.filter((e) => !filter || e.url.toLowerCase().includes(filter));
    return { total: all.length, returned: Math.min(lastN, all.length), entries: all.slice(-lastN) };
  }

  // Component chains live in the page realm — re-resolve through unsafeWindow
  // when the sandbox element hides the expandos (same fallback as sourceInfo).
  function chainTargetEl(el) {
    try {
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
      if (!uw || !uw.document) return el;
      const pageEl = uw.document.querySelector(cssPath(el));
      return pageEl || el;
    } catch (e) { return el; }
  }
  function reactChain(el, maxDepth, withProps) {
    const chain = [];
    try {
      for (const k of Object.getOwnPropertyNames(el)) {
        if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactInternalInstance$')) continue;
        let f = el[k], guard = 0;
        while (f && guard++ < 200 && chain.length < maxDepth) {
          const t = f.type;
          if (t && (t.name || t.displayName)) {
            const src = f._debugSource;
            const level = { component: t.displayName || t.name || '' };
            if (src && src.fileName) { level.file = src.fileName; level.line = src.lineNumber || 0; }
            if (withProps && f.memoizedProps !== undefined) level.props = f.memoizedProps;
            chain.push(level);
          }
          f = f.return;
        }
        if (chain.length) break;
      }
    } catch (e) { /* fiber unwrapping is best-effort */ }
    return chain;
  }
  function vueChain(el, maxDepth, withProps) {
    const chain = [];
    try {
      let vm = el.__vueParentComponent || el.__vue__ || null, guard = 0;
      while (vm && guard++ < 200 && chain.length < maxDepth) {
        const opts = vm.$options || {};
        const name = (vm.type && (vm.type.name || vm.type.__name)) || opts.name || opts.__name || '';
        if (opts.__file || name) {
          const level = { component: name };
          if (opts.__file) level.file = opts.__file;
          if (withProps && vm.$props !== undefined) level.props = vm.$props;
          chain.push(level);
        }
        vm = vm.$parent || null;
      }
    } catch (e) { /* vm walking is best-effort */ }
    return chain;
  }
  function toolFrameworkInspect(params) {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) throw new Error('framework.inspect: params.selector (CSS) is required');
    const el = document.querySelector(selector);
    if (!el) throw new Error('framework.inspect: no element matches ' + selector);
    const maxDepth = Math.max(1, Math.min(10, Number(params.maxDepth) || 5));
    const withProps = params.props !== undefined ? !!params.props : gm.get(GM_FPROPS, false) === true;
    const target = chainTargetEl(el);
    let chain = reactChain(target, maxDepth, withProps);
    let framework = chain.length ? 'react' : null;
    if (!chain.length) {
      chain = vueChain(target, maxDepth, withProps);
      framework = chain.length ? 'vue' : null;
    }
    return { selector, framework, withProps, depth: chain.length, chain };
  }

  const PAGE_TOOLS = {
    [PAGE_OPS.INFO]: toolPageInfo,
    [PAGE_OPS.DOM_QUERY]: toolDomQuery,
    [PAGE_OPS.DOM_HTML]: toolDomHtml,
    [PAGE_OPS.CONSOLE_LOGS]: toolConsoleLogs,
    [PAGE_OPS.NETWORK_LOG]: toolNetworkLog,
    [PAGE_OPS.FRAMEWORK_INSPECT]: toolFrameworkInspect,
  };

  // page.request{tool:{op,params}} → run the fixed op → exactly one page.response.
  function handlePageToolRequest(f) {
    const tool = f.tool && typeof f.tool === 'object' && !Array.isArray(f.tool) ? f.tool : null;
    if (!tool || typeof tool.op !== 'string') {
      sendFrame(framePageResponse(f.id, false, 'invalid_tool: missing tool.op'));
      return;
    }
    const handler = PAGE_TOOLS[tool.op];
    if (!handler) {
      sendFrame(framePageResponse(f.id, false, 'unknown_op: ' + tool.op + ' (available: ' + Object.keys(PAGE_TOOLS).join(', ') + ')'));
      return;
    }
    let text;
    try {
      const params = tool.params && typeof tool.params === 'object' && !Array.isArray(tool.params) ? tool.params : {};
      text = jsonSafe(handler(params)).text;
    } catch (e) {
      sendFrame(framePageResponse(f.id, false, e && e.message ? String(e.message) : String(e)));
      return;
    }
    if (text.length > RESULT_MAX_CHARS) { sendFrame(framePageResponse(f.id, false, 'result_too_large')); return; }
    sendFrame(framePageResponse(f.id, true, text));
  }

  elOk.addEventListener('click', () => { if (groupCard) submitGroup(); else submit(); });
  elCancel.addEventListener('click', () => { if (groupCard) closeGroupCard(); else unpin(); });

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
    // Esc 优先收起 target 下拉（capture 阶段拦截，避免顺带把整个面板也关了）
    if (comboOpen && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation(); closeDrop(); return;
    }
    if (panelOpen && e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); closePanel(); return;
    }
    if (!pickMode) return;
    if (groupCard) {
      if (e.isComposing || e.keyCode === 229) return;
      const firstTarget = (e.composedPath && e.composedPath()[0]) || e.target;
      if (e.key === 'Enter' && firstTarget === elTxt && !e.shiftKey) {
        e.preventDefault(); submitGroup();
      } else if (e.key === 'Escape') {
        closeGroupCard();
      }
      return;
    }
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
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); e.stopPropagation();
      toggleGroup(currentEl());          // ⇧Enter：当前高亮元素加入/移出组合
      return;
    }
    switch (e.key) {
      case ']': case 'ArrowDown': e.preventDefault(); shiftLayer(1); break;
      case '[': case 'ArrowUp': e.preventDefault(); shiftLayer(-1); break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (groupEls.length) openGroupCard(); else pin();   // 有待处理组合时 Enter = 组备注
        break;
      case 'Escape': e.preventDefault(); setActive(false); break;
      default:
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); idx = Math.min(stack.length - 1, +e.key - 1); refresh(); }
    }
  }, true);

  window.addEventListener('scroll', () => { if (pickMode) { refresh(); renderGroupMarks(); } }, true);
  window.addEventListener('resize', () => { if (pickMode) { refresh(); renderGroupMarks(); } }, true);

  refreshCount();
  updateGroupUI();
  renderTargetCombo();
  debugLog('ready — ⇧⌥P 拾取 · ⇧⌥L 面板 · ⇧Enter 加组 · ' + location.host);

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
    refreshTargets: refreshTargets,
    snapshot: loadBatch,
    tools: () => Object.keys(PAGE_TOOLS),
    consoleLog: () => consoleRing.slice(),
    netLog: () => netRing.slice(),
    frameworkProps: () => gm.get(GM_FPROPS, false) === true,
    setFrameworkProps: (on) => { gm.set(GM_FPROPS, !!on); elSProps.checked = !!on; return !!on; },
    setDebug: (on) => { gm.set(GM_DEBUG, !!on); return !!on; },
    reinject: reinjectTrigger,
  };

  // ---------- Tampermonkey menu ----------
  try {
    GM_registerMenuCommand('连接 broker', () => connectBroker());
    GM_registerMenuCommand('断开 broker', () => disconnectBroker());
    GM_registerMenuCommand('连接设置…', openSettings);
    GM_registerMenuCommand('打开标注面板 (⇧⌥L)', togglePanel);
    GM_registerMenuCommand('开始拾取 (⇧⌥P)', () => setActive(true));
    GM_registerMenuCommand('重新注入 trigger', () => {
      toast(reinjectTrigger() ? 'trigger 已重新注入' : 'trigger 仍在页面上');
    });
  } catch (e) { /* menu registration unavailable in this manager */ }
})();
