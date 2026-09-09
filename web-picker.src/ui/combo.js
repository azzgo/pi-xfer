// Target combobox — searchable dropdown over targets.list results.
// focus/click opens, type-to-filter by name/cwd/status, ↑↓ highlight,
// Enter or click selects, Esc / outside click closes; selection persists to
// GM wp.lastTarget.

import { GM_TARGET } from '../constants.js';
import { gm } from '../storage.js';
import { escapeHtml } from '../dom-utils.js';

export function initCombo(ctx) {
  const { els, toast } = ctx;
  const { elTCombo, elTInput, elTDrop, elTRefresh } = els;
  const conn = ctx.conn;

  let targets = [];        // [{name, sessionName, cwd, status}] from targets.list
  let comboSel = '';       // 当前选中的 target name（'' = 无）
  let comboFilter = '';    // 下拉展开期间的过滤词
  let comboHl = 0;         // 过滤结果中的高亮下标
  let comboOpen = false;

  ctx.getComboSel = () => comboSel;
  ctx.getTargets = () => targets.slice();

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
  ctx.closeDrop = closeDrop;
  ctx.comboOpen = () => comboOpen;
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
    elTInput.placeholder = conn.getState() !== 'on' ? '未连接 broker' : '无活跃 local session';
    closeDrop();
    if (conn.getState() !== 'on' || !targets.length) return;
    elTInput.disabled = false;
    comboSel = targets.some((t) => t.name === last) ? last : targets[0].name;
    if (comboOpen) renderDrop(); else elTInput.value = comboSel;
  }
  ctx.renderTargetCombo = renderTargetCombo;

  async function refreshTargets() {
    targets = await conn.requestTargets();
    renderTargetCombo();
  }
  ctx.refreshTargets = refreshTargets;

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
    if (conn.getState() !== 'on') { ctx.openSettings(); return; }
    refreshTargets().then(() =>
      toast(targets.length ? '目标列表已刷新（' + targets.length + '）' : '没有发现活跃 local session'));
  });
}
