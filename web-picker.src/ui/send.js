// Send box — split send button (发送 → + ▾ dropdown), doSend flow, conn pill,
// clear button, copy-handoff-prompt flow.

import { GM_TARGET } from '../constants.js';
import { gm, loadBatch } from '../storage.js';

function copyText(text) {
  try { GM_setClipboard(text, 'text'); return true; } catch (e) { /* fall through to web clipboard */ }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
  } catch (e) { /* clipboard API unavailable */ }
  return false;
}

export function initSend(ctx) {
  const { els, toast } = ctx;
  const { elPrompt, elSend, elClear, elSendGroup, elSendMore, elSendMenu, elCopyPrompt, elConn, elConnText } = els;
  const conn = ctx.conn;

  async function copyHandoffPrompt() {
    ctx.closeSendMenu();
    if (conn.getState() !== 'on') { toast('先连接 broker（点击左下状态）'); return; }
    const prompt = elPrompt.value.trim();
    const target = ctx.getComboSel();
    const hasPicks = loadBatch().length > 0;
    const record = ctx.getRecord ? ctx.getRecord() : null;
    if (!prompt && !hasPicks && !record) { toast('先标注元素、录制操作、或写 prompt'); return; }
    toast('正在向 broker 请求完整 handoff prompt…');
    const res = await conn.requestCompose(prompt, target, record);
    if (!res.ok) { toast('拼 prompt 失败: ' + res.code + (res.message ? ' — ' + res.message : '')); return; }
    if (!copyText(res.text)) { toast('剪贴板不可用（需 GM_setClipboard 或 https/localhost）'); return; }
    toast('handoff prompt 已复制（' + res.text.length + ' 字符 · 可粘贴给任意 agent）');
  }

  async function doSend() {
    const prompt = elPrompt.value.trim();            // 可留空 → submitToAgent 落到 DEFAULT_PROMPT
    const target = ctx.getComboSel();
    if (!target) {
      toast(conn.getState() !== 'on' ? '先连接 broker（点击左下状态）' : '没有可用目标：先启动 pi session 的 xfer listen');
      return;
    }
    const hasPicks = loadBatch().length > 0;
    const record = ctx.getRecord ? ctx.getRecord() : null;   // v1.13：完成的 Record 随批发送
    if (!prompt && !hasPicks && !record) { toast('先标注元素、录制操作、或写 prompt'); return; }
    if (!hasPicks && !record && !confirm('没有标注任何元素，只发 prompt？')) return;
    elSend.disabled = true;
    elSend.textContent = '发送中…';
    const res = await conn.submitToAgent(prompt, target, record);
    elSend.disabled = false;
    elSend.textContent = '发送 →';
    if (res.ok) {
      gm.set(GM_TARGET, target);
      toast('已送达 agent（handoff ' + (res.result && res.result.handoff_id ? res.result.handoff_id : '?') + '）');
      elPrompt.value = '';
      ctx.clearBatch();
      if (record && ctx.clearRecord) ctx.clearRecord();      // record 一次性：发送成功即清
      ctx.closePanel();                              // 发送成功即收起面板；重开显示空态
    } else {
      toast('发送失败: ' + res.code + (res.message ? ' — ' + res.message : ''));
    }
  }
  elSend.addEventListener('click', doSend);
  // ⌘/Ctrl+Enter 发送——写完 prompt 不必再伸手点鼠标
  elPrompt.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doSend(); }
  });

  // ---------- 更多下拉（split button 的 ▾）----------
  let sendMenuOpen = false;
  function closeSendMenu() {
    if (!sendMenuOpen) return;
    sendMenuOpen = false;
    elSendMenu.classList.remove('open');
  }
  ctx.closeSendMenu = closeSendMenu;
  ctx.sendMenuOpen = () => sendMenuOpen;
  elSendMore.addEventListener('click', () => {
    sendMenuOpen = !sendMenuOpen;
    elSendMenu.classList.toggle('open', sendMenuOpen);
  });
  elCopyPrompt.addEventListener('click', copyHandoffPrompt);
  ctx.copyHandoffPrompt = copyHandoffPrompt;
  window.addEventListener('pointerdown', (e) => {
    if (!sendMenuOpen) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(elSendGroup) >= 0) return;
    closeSendMenu();
  }, true);
  elClear.addEventListener('click', () => {
    const n = loadBatch().length;
    if (!n) return;
    ctx.clearBatch();                          // 标注是轻量草稿，清空不做二次确认
    ctx.renderPanel();
    toast('已清空 ' + n + ' 条标注');
  });
  // 未连接时点击 = 直接按已存/默认地址发起连接（不再先弹设置）；仅配对失败才打开设置
  elConn.addEventListener('click', () => {
    if (conn.getState() === 'on') { conn.disconnect(); return; }
    if (conn.getState() !== 'off') return;                 // connecting 中：等本次尝试出结果
    toast('正在连接 ' + conn.brokerUrl() + ' …');
    conn.connect().then((ok) => { if (!ok) ctx.openSettings(); });
  });

  // broker 状态 → 面板 conn pill（fab 圆点在 main 的 onState 里一并处理）
  ctx.renderConnPill = (s) => {
    elConn.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : '';
    elConn.title = s === 'on' ? '点击断开 broker' : s === 'connecting' ? '连接中…' : '点击连接 broker（失败会打开连接设置）';
    elConnText.textContent = s === 'on' ? 'broker 已连接'
      : s === 'connecting' ? '连接中…'
      : '未连接 · 点击连接';
  };
}
