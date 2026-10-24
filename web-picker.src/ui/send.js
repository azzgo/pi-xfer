// Send box — split send button (发送 → + ▾ dropdown), doSend flow, conn pill,
// clear button, copy-handoff-prompt flow.

import { GM_TARGET } from '../constants.js';
import { DEFAULT_PROMPT } from '../broker-conn.js';
import { renderOfflineHandoffDoc } from '../offline-doc.js';
import { gm, loadBatch } from '../storage.js';
import { t } from '../i18n.js';

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
  const { elPrompt, elSend, elClear, elSendGroup, elSendMore, elSendMenu, elCopyPrompt, elStage, elConn, elConnText, elSendOffline } = els;
  const conn = ctx.conn;

  // No broker? Compose the same document here in the tab from data we already
  // hold (picks in sessionStorage, the finished record, this tab's url/title).
  // No targets fetch, no follow-up channel — the receiver opens the file.
  function composeOffline() {
    const prompt = elPrompt.value.trim() || DEFAULT_PROMPT;
    const target = ctx.getComboSel() || gm.get(GM_TARGET, '') || '';
    const text = renderOfflineHandoffDoc({
      prompt,
      page: { url: location.href, title: document.title, ts: Date.now() },
      picks: loadBatch(),
      record: ctx.getRecord ? ctx.getRecord() : null,
      target,
    });
    if (!copyText(text)) { toast(t('send.clipboard')); return; }
    toast(t('send.copiedOffline', { n: text.length }));
  }

  async function copyHandoffPrompt() {
    ctx.closeSendMenu();
    const prompt = elPrompt.value.trim();
    const target = ctx.getComboSel();
    const hasPicks = loadBatch().length > 0;
    const record = ctx.getRecord ? ctx.getRecord() : null;
    if (!prompt && !hasPicks && !record) { toast(t('send.needContent')); return; }
    if (conn.getState() !== 'on') { composeOffline(); return; }
    toast(t('send.composing'));
    const res = await conn.requestCompose(prompt, target, record);
    if (!res.ok) { toast(t('send.composeFailed', { detail: res.code + (res.message ? ' — ' + res.message : '') })); return; }
    if (!copyText(res.text)) { toast(t('send.clipboard')); return; }
    toast(t('send.copied', { n: res.text.length }));
  }

  async function doSend() {
    const prompt = elPrompt.value.trim();            // 可留空 → submitToAgent 落到 DEFAULT_PROMPT
    const target = ctx.getComboSel();
    if (!target) {
      toast(conn.getState() !== 'on' ? t('send.noTargetOffline') : t('send.noTarget'));
      return;
    }
    const hasPicks = loadBatch().length > 0;
    const record = ctx.getRecord ? ctx.getRecord() : null;   // v1.13：完成的 Record 随批发送
    if (!prompt && !hasPicks && !record) { toast(t('send.needContent')); return; }
    if (!hasPicks && !record && !confirm(t('send.promptOnly.confirm'))) return;
    elSend.disabled = true;
    elSend.textContent = t('send.sending');
    const res = await conn.submitToAgent(prompt, target, record);
    elSend.disabled = false;
    elSend.textContent = t('sendbtn');
    if (res.ok) {
      gm.set(GM_TARGET, target);
      toast(t('send.delivered', { id: res.result && res.result.handoff_id ? res.result.handoff_id : '?' }));
      elPrompt.value = '';
      ctx.clearBatch();
      if (record && ctx.clearRecord) ctx.clearRecord();      // record 一次性：发送成功即清
      ctx.closePanel();                              // 发送成功即收起面板；重开显示空态
    } else {
      toast(t('send.failed', { detail: res.code + (res.message ? ' — ' + res.message : '') }));
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
  if (elSendOffline) elSendOffline.addEventListener('click', copyHandoffPrompt);
  ctx.copyHandoffPrompt = copyHandoffPrompt;

  // 暂存到 broker：本页直发路径之外的第二条显式路径（硬约束：不改变本页默认行为，
  // 未连接时菜单项灰掉——袋在 broker 上，离线暂存无从谈起）。
  async function stageToBroker() {
    ctx.closeSendMenu();
    if (conn.getState() !== 'on') { toast(t('bag.stageFailed', { detail: t('conn.notConnected') })); return; }
    const b = loadBatch();
    if (!b.length) { toast(t('send.needContent')); return; }
    let ok = 0;
    for (const pick of b) {
      const res = await conn.stagePick(pick);
      if (res.ok) ok++;
      else { toast(t('bag.stageFailed', { detail: res.code + (res.message ? ' — ' + res.message : '') })); return; }
    }
    toast(t('bag.staged', { n: ok }));
    // 入袋后默认清空本页（开放问题的拍板：不保留副本，避免双份）
    ctx.clearBatch();
    ctx.renderPanel();
    if (ctx.refreshBag) void ctx.refreshBag();
  }
  elStage.addEventListener('click', stageToBroker);
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
    toast(t('pick.cleared', { n }));
  });
  // 未连接时点击 = 直接按已存/默认地址发起连接（不再先弹设置）；仅配对失败才打开设置
  elConn.addEventListener('click', () => {
    if (conn.getState() === 'on') { conn.disconnect(); return; }
    if (conn.getState() !== 'off') return;                 // connecting 中：等本次尝试出结果
    toast(t('send.connecting', { url: conn.brokerUrl() }));
    conn.connect().then((ok) => { if (!ok) ctx.openSettings(); });
  });

  // broker 状态 → 面板 conn pill（fab 圆点在 main 的 onState 里一并处理）
  // 'on' → send split button as always. 'connecting' → visible but disabled
  // (transient, avoids a flicker on every reconnect). 'off'/'blocked' → send
  // button hidden entirely and copy-prompt promoted to the primary button: with
  // no broker, composing into the clipboard is the only thing that can work.
  function renderSendAffordance(s) {
    const linked = s === 'on';
    const busy = s === 'connecting';
    elSendGroup.style.display = linked || busy ? '' : 'none';
    elSend.disabled = !linked;
    elStage.style.opacity = linked ? '' : '.45';
    elStage.style.pointerEvents = linked ? '' : 'none';
    if (elSendOffline) elSendOffline.hidden = linked || busy;
    if (!linked) closeSendMenu();
    if (ctx.renderBagAffordance) ctx.renderBagAffordance(s);
  }
  ctx.renderSendAffordance = renderSendAffordance;

  ctx.renderConnPill = (s) => {
    elConn.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : s === 'blocked' ? 'blocked' : '';
    elConn.title = s === 'on' ? t('pill.disconnect.title')
      : s === 'connecting' ? t('conn.connecting')
      : s === 'blocked' ? t('pill.blocked.title')
      : t('pill.off.title');
    elConnText.textContent = s === 'on' ? t('conn.on')
      : s === 'connecting' ? t('conn.connecting')
      : s === 'blocked' ? t('conn.blocked')
      : t('conn.off');
    renderSendAffordance(s);
  };
}
