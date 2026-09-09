// Pick mode core — highlight stack, pin → note card, shift-group, payload
// schema, capture handlers (mousemove/click/wheel interception).
//
// Cross-module calls go through ctx (refreshCount/closePanel/updateFreezeUI/
// toggleFreeze/barDrag live in other modules); they are only invoked at event
// time, never at registration time.

import { HOST_FLAG } from '../constants.js';
import { loadBatch, saveBatch } from '../storage.js';
import { cssPath, xPath, nearestScrollable, selectorPreview, escapeHtml } from '../dom-utils.js';
import { sourceInfo } from '../framework.js';

export function initPick(ctx) {
  const { host, root, els, toast } = ctx;
  const { elHL, elGWrap, elBadge, elInfo, elBar, elGH, elGCLEAR, elCard, elSel, elTxt, elOk } = els;

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

  ctx.pickState = {
    get pickMode() { return pickMode; },
    get pinned() { return pinned; },
    get groupCard() { return groupCard; },
    get groupCount() { return groupEls.length; },
    get frozen() { return frozen; },
    set frozen(v) { frozen = !!v; },
    get stack() { return stack; },
    set idx(v) { idx = v; },
    get idx() { return idx; },
    currentEl,
  };

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
  ctx.currentEl = currentEl;

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
  ctx.refresh = refresh;

  // ---------- pick mode ----------
  function setActive(on) {
    pickMode = on;
    host.style.pointerEvents = 'none';
    elBar.style.display = on ? 'flex' : 'none';
    if (on) ctx.barDrag.clamp();          // 隐藏期间视口可能缩小过，先拉回可视区
    els.elFab.style.display = on ? 'none' : 'block';
    document.body.style.cursor = on ? 'crosshair' : '';
    if (on) { frozen = true; ctx.closePanel(); renderGroupMarks(); }
    else {
      pinned = null; frozen = false;
      closeGroupCard();
      elCard.style.display = 'none'; elHL.style.display = 'none'; elBadge.style.display = 'none'; elInfo.style.display = 'none';
      renderGroupMarks();           // pickMode 已为 false → 隐藏 marks（组合本身保留在内存）
    }
    ctx.updateFreezeUI();
    ctx.refreshCount();
  }
  ctx.setActive = setActive;

  function isOurUI(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(root) >= 0;
  }
  ctx.isOurUI = isOurUI;
  function isFabTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(els.elFab) >= 0;
  }
  ctx.isFabTarget = isFabTarget;

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
  ctx.shiftLayer = shiftLayer;

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
  ctx.pin = pin;
  function unpin() { pinned = null; elCard.style.display = 'none'; refresh(); }
  ctx.unpin = unpin;
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
  // 一次性清空待处理组合（⌫ / 工具栏 chip）。组合只存内存，之前唯一的移出方式是
  // 重新 hover 回原元素再按 ⇧Enter，实际用起来等于"无法取消"。
  function clearPendingGroup() {
    if (!groupEls.length) return;
    const n = groupEls.length;
    groupEls = [];
    if (groupCard) closeGroupCard();       // 组都没了，组备注卡片一并收起
    renderGroupMarks();
    updateGroupUI();
    toast('已清空待处理组合（' + n + ' 项）');
  }
  ctx.clearPendingGroup = clearPendingGroup;
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
      tag.setAttribute('data-gi', String(i));     // 点徽标按它移出对应元素
      tag.title = '点击移出组合';
      m.appendChild(tag);
      elGWrap.appendChild(m);
    });
  }
  ctx.renderGroupMarks = renderGroupMarks;
  // 点琥珀色 mark 的序号徽标 = 把该元素移出组合（不必再 hover 回原元素按 ⇧Enter）
  elGWrap.addEventListener('click', (e) => {
    const tag = e.target && e.target.closest ? e.target.closest('.gi') : null;
    if (!tag) return;
    const i = +tag.getAttribute('data-gi');
    if (!(i >= 0) || !groupEls[i]) return;
    groupEls.splice(i, 1);
    renderGroupMarks();
    updateGroupUI();
    toast('已移出组合（剩 ' + groupEls.length + ' 项）');
  });
  ctx.toggleGroup = toggleGroup;
  function updateGroupUI() {
    const n = groupEls.length;
    elGH.classList.toggle('on', n > 0);
    elGH.innerHTML = '<kbd>⇧Enter</kbd>加组/移出' +
      (n ? ' · <kbd>Enter</kbd>组备注(' + n + ')' : '');
    elGCLEAR.style.display = n ? 'inline-flex' : 'none';
  }
  ctx.updateGroupUI = updateGroupUI;
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
  ctx.openGroupCard = openGroupCard;
  function closeGroupCard() {
    if (!groupCard) return;
    groupCard = false;
    elCard.style.display = 'none';
    elTxt.placeholder = '备注（可选，留空直接回车提交）';
    elOk.textContent = '✓ 确认 Enter';
  }
  ctx.closeGroupCard = closeGroupCard;
  function submitGroup() {
    if (!groupCard || !groupEls.length) return;
    const note = elTxt.value.trim();
    const gid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const b = loadBatch();
    groupEls.forEach((el) => b.push(Object.assign(payloadFor(el, note), { group: gid })));
    saveBatch(b);
    ctx.refreshCount();
    const n = groupEls.length;
    groupEls = [];
    renderGroupMarks();
    updateGroupUI();
    closeGroupCard();
    toast('已选中 ' + n + ' 项 · 组 ' + gid);
  }
  ctx.submitGroup = submitGroup;

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
  ctx.payloadFor = payloadFor;
  function submit() {
    if (!pinned) return;
    ctx.addPick(payloadFor(pinned, elTxt.value.trim()));
    unpin();
  }
  ctx.submit = submit;

  elOk.addEventListener('click', () => { if (groupCard) submitGroup(); else submit(); });
  els.elCancel.addEventListener('click', () => { if (groupCard) closeGroupCard(); else unpin(); });

  window.addEventListener('scroll', () => { if (pickMode) { refresh(); renderGroupMarks(); } }, true);
  window.addEventListener('resize', () => { if (pickMode) { refresh(); renderGroupMarks(); } }, true);
}
