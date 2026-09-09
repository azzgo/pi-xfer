// Note panel — batch list rendering, per-item note edit/delete, group note
// sync, batch add/clear, count badge refresh.

import { loadBatch, saveBatch } from '../storage.js';
import { escapeHtml } from '../dom-utils.js';

export function initPanel(ctx) {
  const { els, toast } = ctx;
  const { elCnt, elPanel, elPlist, elPcount, elPclose } = els;

  let panelOpen = false;

  function refreshCount() {
    const n = loadBatch().length;
    elCnt.textContent = n;
    elCnt.style.display = n > 0 ? 'block' : 'none';
    if (panelOpen) renderPanel();
  }
  ctx.refreshCount = refreshCount;
  ctx.getPanelOpen = () => panelOpen;

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
  ctx.addPick = addPick;
  function clearBatch() { saveBatch([]); refreshCount(); }
  ctx.clearBatch = clearBatch;

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
  ctx.renderPanel = renderPanel;

  function openPanel() {
    panelOpen = true;
    renderPanel();
    elPanel.style.display = 'flex';
    ctx.panelDrag.clamp();
    if (ctx.conn.getState() === 'on') ctx.refreshTargets(); else ctx.renderTargetCombo();
  }
  function closePanel() { panelOpen = false; ctx.closeDrop(); ctx.closeSendMenu(); elPanel.style.display = 'none'; }
  ctx.closePanel = closePanel;
  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }
  ctx.togglePanel = togglePanel;
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
}
