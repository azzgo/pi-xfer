// 浮层拖动（pick 工具栏 / 备注卡片 / 标注面板）。
// 统一拖动实现：按住 handle 移动 el（fixed + left/top，拖动时清掉 right/
// transform 这类锚定样式），位移超过 4px 才算拖动，否则 pointerup 时触发
// onTap（工具栏上的可点提示块靠它工作）。刻意不用 setPointerCapture：capture
// 会把 pointerup/click 重定向到 handle，handle 内部的可点块就收不到 click 了；
// 改挂 window 级 move/up，事件对页面侧已有 isOurUI / host 吞事件兜底。

export function makeDraggable(el, handle, opts) {
  const o = opts || {};
  let drag = null;
  function clampPos(x, y) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(4, Math.min(window.innerWidth - Math.max(48, r.width) - 4, x)),
      y: Math.max(4, Math.min(window.innerHeight - Math.max(28, r.height) - 4, y)),
    };
  }
  function apply(x, y) {
    const p = clampPos(x, y);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.right = 'auto';
    el.style.transform = 'none';
  }
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, textarea, input, select')) return;
    const r = el.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, target: e.target, moved: false };
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) <= 4) return;
    drag.moved = true;
    apply(drag.ox + e.clientX - drag.sx, drag.oy + e.clientY - drag.sy);
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) { if (o.onTap) o.onTap(d.target, e); return; }
    if (!o.key) return;
    try {
      const r = el.getBoundingClientRect();
      sessionStorage.setItem(o.key, JSON.stringify({ x: r.left, y: r.top }));
    } catch (err) { /* position won't persist */ }
  }, true);
  window.addEventListener('pointercancel', () => { drag = null; }, true);
  if (o.key) {
    try {
      const s = sessionStorage.getItem(o.key);
      if (s) { const p = JSON.parse(s); if (typeof p.x === 'number' && typeof p.y === 'number') apply(p.x, p.y); }
    } catch (err) { /* fall back to the CSS default position */ }
  }
  return {
    // 视口变小（打开 devtools 等）后把浮层拉回可视区；隐藏中的浮层跳过，
    // 由 setActive/openPanel 显示时补 clamp
    clamp() {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const p = clampPos(r.left, r.top);
      if (p.x !== r.left || p.y !== r.top) apply(p.x, p.y);
    },
  };
}
