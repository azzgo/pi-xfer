// Fab + draggable chrome wiring — fab drag with badge hit-testing, and the
// three makeDraggable instances (pick toolbar / note card / note panel).

import { KEY_POS, KEY_BAR_POS, KEY_PANEL_POS } from '../constants.js';
import { makeDraggable } from './draggable.js';

export function initFab(ctx) {
  const { ui, toast } = ctx;
  const { host, els } = ui;
  const { elFab, elFabStack, elFabRowPanel, elFabRowRecord, elBar, elCard, elPanel, elPH } = els;

  let drag = null;
  function fabPointerDown(e) {
    if (!ctx.isFabTarget(e)) return;
    e.stopPropagation(); e.preventDefault();
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: ui.pos.x, oy: ui.pos.y, moved: false };
    try { elFab.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported — drag still works via move handler */ }
  }
  function fabPointerMove(e) {
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
  window.addEventListener('pointerdown', fabPointerDown, true);
  window.addEventListener('pointermove', fabPointerMove, true);
  window.addEventListener('pointerup', fabPointerUp, true);

  const barDrag = makeDraggable(elBar, elBar, {
    key: KEY_BAR_POS,
    onTap(target) {
      const t = target && target.closest ? target : null;
      if (!t) return;
      if (t.closest('#gclear')) ctx.clearPendingGroup();
      else if (t.closest('#fz')) ctx.toggleFreeze();
      else if (t.closest('#escx')) ctx.setActive(false);
    },
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
