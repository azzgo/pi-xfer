// Bag drawer — the cross-page staging inbox (variant B of the prototype):
// opens beside the note panel, lists the broker-side Bag grouped by page
// (url+title accordion), and sends the whole bag with its own prompt +
// target combo. The drawer is reachable only while the broker link is up —
// the bag lives in the broker, so an offline entry button is a lie (the
// prototype decision: the entry toggles with the connection, it does not
// gray out).

import { GM_TARGET } from '../constants.js';
import { gm } from '../storage.js';
import { escapeHtml } from '../dom-utils.js';
import { makeDraggable } from './draggable.js';
import { t } from '../i18n.js';
import { setHTML, clearHTML } from '../tt.js';

const PAGE_GROUP_MAX_OPEN = 50;

export function initBag(ctx) {
  const { root, els, toast } = ctx;
  const conn = ctx.conn;

  // drawer DOM — created here (not in shadow.js) to keep the note panel's
  // template untouched; host is position:fixed inset:0 pointer-events:none,
  // so the drawer itself re-enables pointer events like #panel does.
  const drawer = document.createElement('div');
  drawer.id = 'bagdrawer';
  // Build the drawer without an innerHTML sink (TT guard requires all markup
  // writes through tt.js). buildDrawer() assembles nodes directly — the
  // template needs element refs anyway, so build-and-grab beats parse-and-query.
  buildDrawer(drawer);
  // root is the shadow root itself — it has no parentElement; children of it
  // (panel, fab, settings) are all direct nodes, so the drawer joins them there.
  root.appendChild(drawer);

  function buildDrawer(el) {
    const bh = document.createElement('div'); bh.className = 'bh';
    const title = document.createElement('b'); title.textContent = t('bag.title');
    const count = document.createElement('span'); count.className = 'cnt2'; count.id = 'bagcount';
    const close = document.createElement('button'); close.id = 'bagclose'; close.textContent = '✕'; close.title = t('panel.pclose.title');
    bh.append(title, count, close);
    const list = document.createElement('div'); list.id = 'baglist';
    const box = document.createElement('div'); box.className = 'bsendbox';
    const lbl1 = document.createElement('div'); lbl1.className = 'lbl'; lbl1.textContent = t('bag.sendLabel');
    const prompt = document.createElement('textarea'); prompt.id = 'bagprompt'; prompt.placeholder = t('bag.promptPlaceholder');
    const row1 = document.createElement('div'); row1.className = 'brow';
    const lbl2 = document.createElement('span'); lbl2.className = 'lbl'; lbl2.textContent = t('bag.targetLabel');
    const combo = document.createElement('div'); combo.id = 'bagcombo';
    const input = document.createElement('input'); input.id = 'bagtinput'; input.placeholder = t('tinput.placeholder');
    input.autocomplete = 'off'; input.spellcheck = false;
    const drop = document.createElement('div'); drop.id = 'bagtdrop';
    combo.append(input, drop);
    row1.append(lbl2, combo);
    const row2 = document.createElement('div'); row2.className = 'brow2';
    const send = document.createElement('button'); send.className = 'primary'; send.id = 'bagsend'; send.textContent = t('bag.send');
    const copy = document.createElement('button'); copy.className = 'ghost'; copy.id = 'bagcopy'; copy.textContent = t('copyprompt');
    row2.append(send, copy);
    box.append(lbl1, prompt, row1, row2);
    el.append(bh, list, box);
  }

  const elBagPrompt = drawer.querySelector('#bagprompt');
  const elBagSend = drawer.querySelector('#bagsend');
  const elBagCopy = drawer.querySelector('#bagcopy');
  const elBagCount = drawer.querySelector('#bagcount');
  const elBagList = drawer.querySelector('#baglist');
  const elBagInput = drawer.querySelector('#bagtinput');
  const elBagDrop = drawer.querySelector('#bagtdrop');

  const style = document.createElement('style');
  style.textContent = `
    #bagdrawer { position: fixed; top: 60px; right: 380px; width: 330px; max-height: 80vh;
      display: none; flex-direction: column; background: #fff; border-radius: 12px;
      box-shadow: 0 8px 24px rgba(15,23,42,.35); color: var(--wp-ink); font: 13px/1.5 var(--wp-font);
      z-index: 2147483647; pointer-events: auto; }
    #bagdrawer .bh { display: flex; align-items: center; gap: 8px; padding: 11px 14px;
      background: var(--wp-soft); border-bottom: 1px solid var(--wp-line); cursor: move; user-select: none;
      border-radius: 12px 12px 0 0; }
    #bagdrawer .bh b { flex: 1; font-size: 13px; font-weight: 600; }
    #bagdrawer .cnt2 { color: var(--wp-muted); font-size: 11px; }
    #bagdrawer .bh button { background: transparent; color: var(--wp-muted); border: none; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
    #bagdrawer .bh button:hover { background: #e8edf3; color: #334155; }
    #baglist { overflow-y: auto; padding: 10px; flex: 1; }
    #baglist .bempty { color: #94a3b8; text-align: center; padding: 28px 0; font-size: 12px; }
    #baglist .bpage { border: 1px solid var(--wp-line); border-radius: 10px; margin-bottom: 8px; overflow: hidden; background: #fff; }
    #baglist .bphead { display: flex; align-items: center; gap: 8px; padding: 8px 9px; background: var(--wp-soft); cursor: pointer; }
    #baglist .bphead .pt { flex: 1; min-width: 0; }
    #baglist .bphead .pu { font: 600 11px/1.4 var(--wp-mono); color: var(--wp-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #baglist .bphead .ph2 { font: 10px/1.4 var(--wp-mono); color: var(--wp-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #baglist .bphead .n { font: 600 10px var(--wp-mono); background: #eaf1ff; color: var(--wp-accent-deep); border-radius: 999px; padding: 1px 8px; }
    #baglist .bphead .arr { color: var(--wp-muted); font-size: 11px; }
    #baglist .bitems { padding: 8px; }
    #baglist .item { border: 1px solid var(--wp-line); border-radius: 8px; padding: 7px; margin-bottom: 7px; background: #fff; }
    #baglist .item .psel { font: 11px/1.5 var(--wp-mono); color: #475569; background: var(--wp-soft);
      border: 1px solid var(--wp-line); padding: 4px 7px; border-radius: 6px; word-break: break-all; max-height: 44px; overflow: auto; }
    #baglist .item .pprev { color: #94a3b8; font-size: 11px; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #baglist .item textarea { width: 100%; border: 1px solid var(--wp-line); border-radius: 6px; padding: 5px 8px;
      font: 12px/1.5 var(--wp-font); min-height: 30px; resize: vertical; outline: none; }
    #baglist .item textarea:focus { border-color: var(--wp-accent); }
    #baglist .item .prow { display: flex; justify-content: space-between; align-items: center; margin-top: 5px; }
    #baglist .item .pts { color: #94a3b8; font-size: 10px; font-family: var(--wp-mono); }
    #baglist .item .del { background: none; color: #ef4444; font-size: 11px; padding: 2px 8px; border-radius: 6px; border: none; cursor: pointer; }
    #baglist .item .del:hover { background: #fef2f2; }
    #bagdrawer .bsendbox { border-top: 1px solid var(--wp-line); padding: 11px 14px; display: flex;
      flex-direction: column; gap: 7px; background: var(--wp-soft); border-radius: 0 0 12px 12px; }
    #bagdrawer .lbl { font-size: 11px; font-weight: 600; color: var(--wp-muted); letter-spacing: .02em; }
    #bagdrawer textarea, #bagdrawer input { width: 100%; border: 1px solid var(--wp-line); border-radius: 8px; padding: 7px 10px;
      font: 12.5px/1.5 var(--wp-font); background: #fff; color: var(--wp-ink); outline: none; box-sizing: border-box; }
    #bagdrawer textarea { resize: vertical; min-height: 40px; }
    #bagdrawer textarea:focus, #bagdrawer input:focus { border-color: var(--wp-accent); box-shadow: 0 0 0 3px rgba(79,140,255,.14); }
    #bagdrawer .brow { display: flex; gap: 6px; align-items: center; }
    #bagdrawer .brow2 { display: flex; gap: 8px; justify-content: flex-end; }
    /* 与右侧面板的「清空 / 发送」同一规格：固定内边距、不拉伸、不换行 */
    #bagdrawer button.ghost { flex: 0 0 auto; background: #f1f5f9; color: var(--wp-muted); border: none; border-radius: 8px;
      padding: 7px 14px; font: 600 12px var(--wp-font); cursor: pointer; white-space: nowrap; }
    #bagdrawer button.ghost:hover { background: #e2e8f0; color: #475569; }
    #bagdrawer button.primary { flex: 0 0 auto; background: var(--wp-accent); color: #fff; border: none; border-radius: 8px;
      padding: 7px 14px; font: 600 12px var(--wp-font); cursor: pointer; white-space: nowrap;
      box-shadow: 0 1px 3px rgba(79,140,255,.45); }
    #bagdrawer button.primary:hover { background: var(--wp-accent-deep); }
    #bagdrawer button.primary:disabled { background: #c4d5f7; box-shadow: none; cursor: not-allowed; }
    #bagcombo { position: relative; flex: 1; min-width: 0; }
    #bagtdrop { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10;
      background: #fff; border: 1px solid var(--wp-line); border-radius: 10px;
      box-shadow: var(--wp-shadow); padding: 4px; max-height: 224px; overflow-y: auto; display: none; }
    #bagtdrop.open { display: block; }
    #bagtdrop .titem { padding: 6px 9px; border-radius: 7px; cursor: pointer; }
    #bagtdrop .titem.hl { background: #eaf1ff; }
    #bagtdrop .tname { font: 600 12px/1.45 var(--wp-mono); color: var(--wp-ink); word-break: break-all; }
    #bagtdrop .tsub { font: 10.5px/1.45 var(--wp-mono); color: var(--wp-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #bagtdrop .tempty { padding: 12px 8px; text-align: center; color: #94a3b8; font-size: 12px; }
  `;
  root.appendChild(style);

  let bagOpen = false;
  let items = [];                 // last bag.list snapshot — the only truth
  const openPages = new Set();    // accordion state: url|title keys
  let bagTargetSel = '';          // bag's own target (defaults to the panel's)
  let bagComboSel = '';
  let bagComboFilter = '';
  let bagComboHl = 0;
  let comboTargets = [];

  ctx.getBagOpen = () => bagOpen;

  function hostOf(url) { try { return new URL(url).host; } catch (e) { return url; } }
  function pageKey(m) { return (m.url || '') + '|' + (m.title || ''); }

  function groupByPage(list) {
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(pageKey(m))) groups.set(pageKey(m), []);
      groups.get(pageKey(m)).push(m);
    }
    return groups;
  }

  // ---------- rendering ----------
  function render() {
    if (!bagOpen) return;
    const groups = groupByPage(items);
    elBagCount.textContent = bagTruncated
      ? t('bag.countTruncated', { n: items.length, total: bagTotal })
      : t('bag.count', { pages: groups.size, n: items.length });
    if (!items.length) {
      setHTML(elBagList, `<div class="bempty">${t('bag.empty')}</div>`);
      return;
    }
    setHTML(elBagList, [...groups.entries()].map(([key, ms]) => {
      const isOpen = openPages.has(key);
      const first = ms[0];
      return '<div class="bpage" data-pgkey="' + escapeHtml(key) + '">' +
        '<div class="bphead" data-toggle>' +
          '<div class="pt"><div class="pu">' + escapeHtml(first.title || first.url) + '</div>' +
          '<div class="ph2">' + escapeHtml(hostOf(first.url)) + ' · tab ' + escapeHtml(first.tabId) + '</div></div>' +
          '<span class="n">' + ms.length + '</span><span class="arr">' + (isOpen ? '▾' : '▸') + '</span></div>' +
        (isOpen ? '<div class="bitems">' + ms.map(itemHtml).join('') + '</div>' : '') +
        '</div>';
    }).join(''));
  }

  function itemHtml(m) {
    const p = m.pick || {};
    return '<div class="item" data-id="' + escapeHtml(m.id) + '">' +
      '<div class="psel">' + escapeHtml(p.selector || '') + '</div>' +
      (p.textPreview ? '<div class="pprev">' + escapeHtml(p.textPreview) + '</div>' : '') +
      '<textarea data-note placeholder="' + t('note.placeholder') + '">' + escapeHtml(p.note || '') + '</textarea>' +
      '<div class="prow"><span class="pts">' + (p.ts ? new Date(p.ts).toLocaleTimeString() : '') + '</span>' +
      '<button class="del">' + t('btn.delete') + '</button></div></div>';
  }

  // Broker id → accordion entry id: re-rendered rows keep their identity via
  // data-id, so note edits survive the list refresh that follows.
  let bagTruncated = false;
  let bagTotal = 0;
  async function refresh() {
    const res = await conn.requestBagList();
    if (res.ok) {
      const r = res.result || {};
      items = Array.isArray(r.items) ? r.items.slice() : [];
      bagTruncated = r.truncated === true;
      bagTotal = typeof r.total === 'number' ? r.total : items.length;
      // remember open pages that still exist
      const keys = new Set(items.map(pageKey));
      for (const k of [...openPages]) if (!keys.has(k)) openPages.delete(k);
    }
    render();
    return res;
  }
  ctx.refreshBag = refresh;

  // ---------- open/close ----------
  function openDrawer() {
    if (bagOpen) return;
    bagOpen = true;
    drawer.style.display = 'flex';
    if (ctx.els.elPanel && !ctx.getPanelOpen()) ctx.togglePanel();  // drawer opens beside the panel
    render();
    void refresh();
    if (conn.getState() === 'on' && ctx.refreshTargets) void ctx.refreshTargets();
    renderBagCombo();
  }
  function closeDrawer() { bagOpen = false; drawer.style.display = 'none'; closeBagDrop(); }
  ctx.closeBag = closeDrawer;
  function toggleBag() { if (bagOpen) closeDrawer(); else openDrawer(); }
  ctx.toggleBag = toggleBag;

  // Connection down → the entry disappears and the drawer closes with it
  // (the bag is unreachable; showing stale rows would be a lie).
  ctx.renderBagAffordance = (s) => {
    if (elBagEntry) elBagEntry.style.display = s === 'on' ? '' : 'none';
    if (s !== 'on' && bagOpen) closeDrawer();
    if (s === 'on' && bagOpen) void refresh();
  };

  // entry button lives in the panel header, added by send.js's menu work;
  // resolved lazily because shadow.js builds the header before this module runs
  let elBagEntry = null;
  ctx.setBagEntry = (el) => { elBagEntry = el; elBagEntry.addEventListener('click', toggleBag); };

  drawer.querySelector('#bagclose').addEventListener('click', closeDrawer);

  // 抽屉可拖（handle = 标题栏）；位置不持久 —— 每次打开贴回面板左侧的默认位，
  // 与面板的联动布局（right: 380px）由 CSS 默认值给出，拖走后面板移动不追随（v1 取舍）。
  makeDraggable(drawer, drawer.querySelector('.bh'), {});

  // ---------- accordion + note edit + delete ----------
  elBagList.addEventListener('click', (e) => {
    const del = e.target && e.target.closest ? e.target.closest('.del') : null;
    if (del) {
      const item = del.closest('.item');
      const id = item && item.getAttribute('data-id');
      if (!id) return;
      del.disabled = true;
      void conn.unstageMarker(id).then((res) => {
        del.disabled = false;
        if (!res.ok) { toast(t('bag.unstageFailed', { detail: res.code + (res.message ? ' — ' + res.message : '') })); refresh(); return; }
        items = items.filter((m) => m.id !== id);
        render();
        toast(t('bag.unstaged'));
      });
      return;
    }
    const toggle = e.target && e.target.closest ? e.target.closest('[data-toggle]') : null;
    if (toggle) {
      const key = toggle.closest('.bpage').getAttribute('data-pgkey');
      if (openPages.has(key)) openPages.delete(key); else { openPages.add(key); if (openPages.size > PAGE_GROUP_MAX_OPEN) openPages.delete(openPages.values().next().value); }
      render();
    }
  });
  elBagList.addEventListener('change', (e) => {
    // note edits live in the picker's GM copy of the pick… they don't: bag
    // entries are broker-owned; a note edit here updates the bag through a
    // stage-replace is overkill for v1 — surface that clearly instead.
    if (e.target && e.target.matches && e.target.matches('[data-note]')) {
      e.target.disabled = true;
      toast(t('bag.noteReadonly'));
      setTimeout(() => { e.target.disabled = false; }, 800);
    }
  });

  // ---------- bag send ----------
  elBagSend.addEventListener('click', async () => {
    const target = bagComboSel || ctx.getComboSel() || gm.get(GM_TARGET, '');
    if (!target) { toast(t('send.noTarget')); return; }
    if (!items.length) { toast(t('bag.emptyCannotSend')); return; }
    elBagSend.disabled = true;
    elBagSend.textContent = t('send.sending');
    const res = await conn.submitBag(elBagPrompt.value, target);
    elBagSend.disabled = false;
    elBagSend.textContent = t('bag.send');
    if (res.ok) {
      gm.set(GM_TARGET, target);
      elBagPrompt.value = '';
      toast(t('bag.delivered', { id: res.result && res.result.handoff_id ? res.result.handoff_id : '?' }));
      items = [];
      openPages.clear();
      render();
    } else {
      toast(t('send.failed', { detail: res.code + (res.message ? ' — ' + res.message : '') }));
    }
  });

  elBagCopy.addEventListener('click', () => {
    // The bag's document lives on the broker; the local copy-prompt flow only
    // knows this tab's picks. Point the user at the real path instead of
    // composing a different document that would pretend to be the bag.
    toast(t('bag.copyHint'));
  });

  // ---------- target combobox (mirror of combo.js, scoped to the drawer) ----------
  function bagComboList() {
    const q = bagComboFilter.trim().toLowerCase();
    if (!q) return comboTargets.slice();
    return comboTargets.filter((tg) =>
      ((tg.name || '') + ' ' + (tg.cwd || '') + ' ' + (tg.status || '')).toLowerCase().includes(q));
  }
  function renderBagDrop() {
    const list = bagComboList();
    if (bagComboHl >= list.length) bagComboHl = list.length - 1;
    if (bagComboHl < 0) bagComboHl = 0;
    if (!list.length) { setHTML(elBagDrop, `<div class="tempty">${t('combo.noSessions')}</div>`); return; }
    setHTML(elBagDrop, list.map((tg, i) => {
      const sub = (tg.cwd || '?') + (tg.status ? ' · ' + tg.status : '');
      return '<div class="titem' + (i === bagComboHl ? ' hl' : '') + '" data-name="' + escapeHtml(tg.name) + '">' +
        '<div class="tname">' + escapeHtml(tg.name) + (tg.name === bagComboSel ? ' <span style="color:var(--wp-green)">✓</span>' : '') + '</div>' +
        '<div class="tsub">' + escapeHtml(sub) + '</div></div>';
    }).join(''));
  }
  function closeBagDrop() { elBagDrop.classList.remove('open'); }
  function renderBagCombo() {
    comboTargets = ctx.getTargets ? ctx.getTargets() : [];
    bagComboSel = bagComboSel || ctx.getComboSel() || gm.get(GM_TARGET, '') || '';
    elBagInput.value = bagComboSel;
    renderBagDrop();
  }
  ctx.renderBagCombo = renderBagCombo;
  elBagInput.addEventListener('focus', () => { bagComboFilter = ''; renderBagDrop(); elBagDrop.classList.add('open'); });
  elBagInput.addEventListener('input', () => { bagComboSel = ''; bagComboFilter = elBagInput.value; bagComboHl = 0; renderBagDrop(); elBagDrop.classList.add('open'); });
  elBagInput.addEventListener('keydown', (e) => {
    const list = bagComboList();
    if (e.key === 'ArrowDown') { e.preventDefault(); bagComboHl = Math.min(bagComboHl + 1, list.length - 1); renderBagDrop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bagComboHl = Math.max(bagComboHl - 1, 0); renderBagDrop(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[bagComboHl]) { bagComboSel = list[bagComboHl].name; elBagInput.value = bagComboSel; closeBagDrop(); } }
    else if (e.key === 'Escape') { closeBagDrop(); }
  });
  elBagDrop.addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.titem') : null;
    if (!item) return;
    bagComboSel = item.getAttribute('data-name');
    elBagInput.value = bagComboSel;
    closeBagDrop();
  });
  window.addEventListener('pointerdown', (e) => {
    if (!elBagDrop.classList.contains('open')) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(drawer) >= 0) return;
    closeBagDrop();
  }, true);
}
