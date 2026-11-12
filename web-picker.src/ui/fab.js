// Fab + draggable chrome wiring — fab drag with badge hit-testing, and the
// three makeDraggable instances (pick toolbar / note card / note panel).

import { KEY_POS, KEY_BAR_POS, KEY_PANEL_POS } from '../constants.js';
import { gm, fabHiddenKey } from '../storage.js';
import { t } from '../i18n.js';
import { makeDraggable } from './draggable.js';

export function initFab(ctx) {
  const { ui, toast } = ctx;
  const { host, els } = ui;
  const { elFab, elFabStack, elFabRowPanel, elFabRowRecord, elBar, elCard, elPanel, elPH } = els;

  const fabKey = fabHiddenKey(location.origin);
  let fabHidden = gm.get(fabKey, false) === true;
  function applyFabHidden() { elFabStack.classList.toggle('hidden', fabHidden); }
  function snapHidden() { if (fabHidden) ui.snapFabToEdge(); }
  function toggleFab() {
    fabHidden = !fabHidden;
    gm.set(fabKey, fabHidden);
    if (fabHidden) snapHidden();
    else if (ctx.lastPointer) ui.placeFabAtPointer(ctx.lastPointer.x, ctx.lastPointer.y);
    applyFabHidden();
    toast(fabHidden ? t('toast.fabHidden') : t('toast.fabShown'));
    if (ctx.refreshFabMenu) ctx.refreshFabMenu();
  }
  ctx.toggleFab = toggleFab;
  ctx.isFabHidden = () => fabHidden;
  snapHidden();
  applyFabHidden();
  let drag = null;
  function fabPointerDown(e) {
    if (!ctx.isFabTarget(e)) return;
    e.stopPropagation(); e.preventDefault();
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: ui.pos.x, oy: ui.pos.y, moved: false };
    try { elFab.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported — drag still works via move handler */ }
  }
  function fabPointerMove(e) {
    ctx.lastPointer = { x: e.clientX, y: e.clientY };
    if (!ctx.isFabTarget(e) && !drag) return;
    e.stopPropagation(); e.preventDefault();
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    ui.pos.x = Math.max(4, Math.min(window.innerWidth - 50, drag.ox + dx));
    ui.pos.y = Math.max(4, Math.min(window.innerHeight - 50, drag.oy + dy));
    elFabStack.style.left = ui.pos.x + 'px';
    elFabStack.style.top = ui.pos.y + 'px';
  }
  // 核心按钮只有一个动作：开始拾取。面板 / 录制在悬停扇出的两行里，
  // 角标只报数——之前角标与图标是两个热区却共用一个视觉主体。
  function fabPointerUp(e) {
    if (!drag) return;
    e.stopPropagation(); e.preventDefault();
    const wasMoved = drag.moved;
    drag = null;
    try { sessionStorage.setItem(KEY_POS, JSON.stringify(ui.pos)); } catch (err) { /* position won't persist */ }
    if (!wasMoved) ctx.setActive(true);
  }
  elFabRowPanel.addEventListener('click', (e) => { e.stopPropagation(); ctx.togglePanel(); });
  elFabRowRecord.addEventListener('click', (e) => { e.stopPropagation(); ctx.toggleRecord(); });
  // 右键 = 直接开/收面板：不用先悬停等扇出、再点那一行。页面自己的右键菜单在
  // fab 上让位给这条捷径（capture 阶段拦掉，页面脚本收不到）。
  window.addEventListener('contextmenu', (e) => {
    if (!ctx.isFabTarget(e)) return;
    e.stopPropagation();
    e.preventDefault();
    drag = null;
    ctx.togglePanel();
  }, true);
  window.addEventListener('pointerdown', fabPointerDown, true);
  window.addEventListener('pointermove', fabPointerMove, true);
  window.addEventListener('pointerup', fabPointerUp, true);

  // 悬停展开的浮层统一「离开后延迟收起」：鼠标从中轴移向可点块的中途一旦
  // 出界，立即收起就点不到了。fab（trigger + 它扇出的两行菜单）在屏幕角落、
  // 目标明确，3s 够用；拾取工具栏在屏幕正中、提示块多，留 10s 才来得及点。
  const FAB_HOLD_MS = 3000;
  const BAR_HOLD_MS = 10000;
  function hoverHold(el, openClass, holdMs) {
    let timer = 0;
    const keep = () => { clearTimeout(timer); el.classList.add(openClass); };
    const release = () => {
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove(openClass), holdMs);
    };
    const close = () => { clearTimeout(timer); el.classList.remove(openClass); };
    el.addEventListener('pointerenter', keep);
    el.addEventListener('pointerleave', release);
    return { keep, release, close };
  }
  const barHold = hoverHold(elBar, 'open', BAR_HOLD_MS);
  hoverHold(elFabStack, 'open', FAB_HOLD_MS);
  ctx.collapseBar = barHold.close;

  function runBarAction(target) {
    const hit = target && target.closest ? target.closest('[data-act]') : null;
    if (!hit) return false;
    const [act, arg] = String(hit.getAttribute('data-act')).split(':');
    if (act === 'cleargroup') ctx.clearPendingGroup();
    else if (act === 'step') ctx.shiftLayer(Number(arg));
    else if (act === 'jump') ctx.jumpLayer(Number(arg));
    else if (act === 'pin') ctx.pin();
    else if (act === 'group') ctx.toggleGroup(ctx.currentEl());
    else if (act === 'freeze') ctx.toggleFreeze();
    else if (act === 'exit') ctx.setActive(false);
    else return false;
    return true;
  }
  const barDrag = makeDraggable(elBar, elBar, {
    key: KEY_BAR_POS,
    onTap(target) { runBarAction(target); },
  });
  const cardDrag = makeDraggable(elCard, elCard, {});
  const panelDrag = makeDraggable(elPanel, elPH, { key: KEY_PANEL_POS });
  ctx.barDrag = barDrag;
  ctx.cardDrag = cardDrag;
  ctx.panelDrag = panelDrag;
  window.addEventListener('resize', () => {
    barDrag.clamp(); panelDrag.clamp(); cardDrag.clamp();
  }, true);
  void host; void toast;
}
