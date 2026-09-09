// Record mode — the temporal half of the marker pair (Pick = where, Record =
// when). The user enters record mode (⇧⌥R / fab menu / API) and operates the
// page freely; passive capture listeners record core actions (click,
// field-level input, SPA route change, commits) into one sequence. Stop
// freezes the timeline, slices the console/net rings over the same window,
// and parks the record for the next submit's `record` field.
//
// State lives in sessionStorage (KEY_REC) and is re-synced after every event,
// so a full page reload (HMR, login redirect) restores the recording with its
// events intact; the URL change becomes a nav event in the same record.
// Cross-origin navigation deliberately breaks a record — sessionStorage is
// per-origin and we do not bridge origins (ADR 0007).

import { KEY_REC, REC_MAX_EVENTS, REC_SLICE_MAX, HOST_FLAG } from './constants.js';
import { cssPath, escapeHtml } from './dom-utils.js';

const INPUT_DEBOUNCE_MS = 1000;

export function initRecord(ctx) {
  const { els, toast } = ctx;
  const { elRecBar, elRecCount, elRecStop, elRecDiscard, elRecBadge } = els;

  // status: null | 'rec' | 'done'; when set, rec carries the payload below.
  let status = null;
  let rec = null;
  let inputTimer = null;      // per-keystroke debounce handle
  let inputEl = null;         // element the pending input event belongs to
  let urlTimer = null;

  ctx.recState = {
    get active() { return status === 'rec'; },
    get eventCount() { return status === 'rec' && rec ? rec.events.length : 0; },
  };

  // ---------- persistence ----------
  function save() {
    try { sessionStorage.setItem(KEY_REC, JSON.stringify({ status, rec })); }
    catch (e) { /* quota / privacy mode — recording stays in memory */ }
  }
  function load() {
    try {
      const s = sessionStorage.getItem(KEY_REC);
      if (!s) return;
      const v = JSON.parse(s);
      if (v && (v.status === 'rec' || v.status === 'done') && v.rec && Array.isArray(v.rec.events)) {
        status = v.status;
        rec = v.rec;
      }
    } catch (e) { /* corrupt state — start clean */ }
  }

  // ---------- event capture ----------
  function now() { return Date.now(); }
  function t0() { return rec ? rec.start : 0; }
  function isOurUiEl(el) {
    try { return !!(el && el.closest && el.closest('[' + HOST_FLAG + ']')); } catch (e) { return false; }
  }

  function describe(el) {
    try {
      return {
        sel: cssPath(el),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || undefined,
      };
    } catch (e) { return { sel: el && el.nodeName ? el.nodeName.toLowerCase() : 'unknown' }; }
  }

  function push(kind, extra) {
    if (status !== 'rec' || !rec) return;
    if (rec.events.length >= REC_MAX_EVENTS) return;    // hard cap — a record is 3-5 ops, not a session log
    rec.events.push(Object.assign({ seq: rec.events.length + 1, t: now() - t0(), kind }, extra || {}));
    save();
    renderRecBar();
  }

  function swallowByPickMode() {
    // pick 模式在 window capture 吞掉页面事件（页面收不到），录进去就是假动作
    return !!(ctx.pickState && ctx.pickState.pickMode);
  }

  function onCaptureClick(e) {
    if (status !== 'rec' || swallowByPickMode()) return;
    if (isOurUiEl(e.target)) return;                    // our own banner buttons are not page actions
    const d = describe(e.target);
    push('click', d);
  }

  function rawValue(el) {
    try {
      if (el.type === 'password') return '***';
      const v = String(el.value ?? '');
      return v.slice(0, 120);
    } catch (e) { return ''; }
  }

  // input：每个字段只记一条最终值——keydown 流去抖到 1s 静默或 change（失焦）。
  function onCaptureInput(e) {
    if (status !== 'rec') return;
    const el = e.target;
    const tag = el && el.tagName;
    if (isOurUiEl(el) || (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT')) return;
    inputEl = el;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { commitInput(el); }, INPUT_DEBOUNCE_MS);
  }
  function commitInput(el) {
    clearTimeout(inputTimer);
    inputTimer = null;
    inputEl = null;
    if (status !== 'rec' || !el || isOurUiEl(el)) return;
    const d = describe(el);
    // 同一元素已有 input 事件则覆盖（最终值才是证据），否则新增
    const prev = rec.events.find((ev) => ev.kind === 'input' && ev.sel === d.sel);
    const value = rawValue(el);
    if (prev) { prev.value = value; prev.t = now() - t0(); }
    else push('input', { sel: d.sel, value });
    save();
  }
  function onCaptureChange(e) {
    if (status !== 'rec') return;
    const el = e.target;
    if (isOurUiEl(el)) return;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) commitInput(el);
  }

  function onCaptureKey(e) {
    if (status !== 'rec' || swallowByPickMode()) return;
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (isOurUiEl(e.target)) return;
    const el = e.target;
    if (el && el.tagName === 'TEXTAREA') return;        // textarea 里的 Enter 是换行，不是提交
    push('key', { sel: describe(el).sel, key: 'Enter' });
  }

  function onCaptureSubmit(e) {
    if (status !== 'rec') return;
    if (isOurUiEl(e.target)) return;
    push('submit', { sel: describe(e.target).sel });
  }

  // SPA 路由 watch：pushState/replaceState 不触发 popstate，轮询 href 是唯一
  // 对所有路由方案都成立的检测；500ms 粒度对「第几步发生了跳转」足够。
  function startUrlWatch() {
    stopUrlWatch();
    let last = location.href;
    urlTimer = setInterval(() => {
      if (status !== 'rec') return;
      if (location.href !== last) {
        const from = last; last = location.href;
        push('nav', { from: from.slice(0, 200), to: location.href.slice(0, 200) });
      }
    }, 500);
  }
  function stopUrlWatch() { if (urlTimer) { clearInterval(urlTimer); urlTimer = null; } }

  // ---------- banner ----------
  function renderRecBar() {
    if (status !== 'rec') { elRecBar.style.display = 'none'; return; }
    elRecBar.style.display = 'flex';
    elRecCount.textContent = rec.events.length + ' events';
  }

  // ---------- lifecycle ----------
  function start() {
    if (status === 'rec') return;
    if (status === 'done') { rec = null; }              // 新录制覆盖未发送的旧记录
    status = 'rec';
    rec = {
      id: 'r' + now().toString(36) + Math.random().toString(36).slice(2, 5),
      start: now(),
      end: undefined,
      url0: location.href,
      url1: undefined,
      events: [],
      console: undefined,
      net: undefined,
    };
    save();
    renderRecBar();
    startUrlWatch();
    toast('录制开始 · 操作页面，⇧⌥R 停止');
  }

  function stop(discard) {
    if (status !== 'rec' || !rec) return;
    stopUrlWatch();
    clearTimeout(inputTimer); inputTimer = null; inputEl = null;
    rec.end = now();
    rec.url1 = location.href;
    rec.events = rec.events.slice(0, REC_MAX_EVENTS);
    // ref：时间线事件命中已选 pick 时带上 pick 序号（1-based），供 agent 交叉索引
    try {
      const sels = (JSON.parse(sessionStorage.getItem('pi.wp.picks') || '[]') || [])
        .map((p) => p && p.selector);
      for (const ev of rec.events) {
        if (ev.sel) {
          const i = sels.indexOf(ev.sel);
          if (i >= 0) ev.ref = i + 1;
        }
      }
    } catch (e) { /* ref 是可选增强，失败不影响主体 */ }
    if (discard) {
      status = null; rec = null;
      try { sessionStorage.removeItem(KEY_REC); } catch (e) { /* nothing to clean */ }
      toast('录制已丢弃');
    } else {
      status = 'done';
      rec.console = ctx.consoleRing.filter((c) => c.ts >= rec.start).slice(-REC_SLICE_MAX);
      rec.net = ctx.netRing.filter((n) => n.ts >= rec.start).slice(-REC_SLICE_MAX);
      toast('录制完成 · ' + rec.events.length + ' 事件 · 打开面板发送');
    }
    save();
    renderRecBar();
    if (ctx.refreshCount) ctx.refreshCount();
  }
  ctx.startRecord = start;
  ctx.stopRecord = stop;
  ctx.toggleRecord = () => { if (status === 'rec') stop(false); else start(); };
  ctx.getRecord = () => (status === 'done' ? rec : null);
  ctx.clearRecord = () => {
    if (status !== 'done') return;
    status = null; rec = null;
    try { sessionStorage.removeItem(KEY_REC); } catch (e) { /* nothing to clean */ }
    if (ctx.refreshCount) ctx.refreshCount();
  };
  // 面板里显示一条 record 摘要（panel.js 调用），删除按钮走 data-rec-del
  ctx.renderRecordSummary = () => {
    if (status !== 'done' || !rec) return '';
    const ev = rec.events.map((e) =>
      '<div class="rsev"><span class="rst">+' + e.t + 'ms</span> <b>' + escapeHtml(e.kind) + '</b> ' +
      escapeHtml(e.sel || e.to || '') +
      (e.value !== undefined ? ' = ' + escapeHtml(e.value) : '') + '</div>'
    ).join('');
    return '<div class="item recitem" data-rec="1">' +
      '<div class="psel">⏺ 记录 ' + escapeHtml(rec.id) + ' · ' + rec.events.length + ' 事件</div>' +
      '<div class="rsevs">' + ev + '</div>' +
      '<div class="prow"><span class="pts">' + new Date(rec.start).toLocaleTimeString() + ' → ' + new Date(rec.end).toLocaleTimeString() + '</span>' +
      '<button class="del" data-rec-del="1">删除</button></div></div>';
  };

  elRecStop.addEventListener('click', (e) => { e.stopPropagation(); stop(false); });
  elRecDiscard.addEventListener('click', (e) => { e.stopPropagation(); stop(true); });
  elRecBadge.addEventListener('click', () => { if (ctx.togglePanel) ctx.togglePanel(); });

  // ---------- install ----------
  load();
  renderRecBar();                                       // reload 后恢复录制横幅 / 待发摘要提示
  if (status === 'rec') startUrlWatch();
  window.addEventListener('click', onCaptureClick, true);
  window.addEventListener('input', onCaptureInput, true);
  window.addEventListener('change', onCaptureChange, true);
  window.addEventListener('keydown', onCaptureKey, true);
  window.addEventListener('submit', onCaptureSubmit, true);
}
