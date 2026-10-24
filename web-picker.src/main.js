// Xfer Web Picker — entry assembly.
// Source of truth for wiring: build the shadow UI, create the broker
// connection, create the page-tool table, then let each UI module register
// onto the shared ctx. Cross-module calls go through ctx at event time, so
// registration order only decides which functions exist when the first event
// fires — by the end of this file everything is in place.

import { GM_DEBUG, GM_FAB_SIZE } from './constants.js';
import { gm, debugLog, loadBatch } from './storage.js';
import { framePageResponse } from './protocol.js';
import { installCapture, consoleRing, netRing } from './capture.js';
import { createPageTools } from './page-tools.js';
import { createBrokerConn } from './broker-conn.js';
import { buildUI } from './ui/shadow.js';
import { initPanel } from './ui/panel.js';
import { initPick } from './ui/pick.js';
import { initCombo } from './ui/combo.js';
import { initSend } from './ui/send.js';
import { initBag } from './ui/bag.js';
import { initSettings } from './ui/settings.js';
import { initFab } from './ui/fab.js';
import { initHotkeys } from './ui/hotkeys.js';
import { initRecord } from './record.js';
import { t, toggleLang } from './i18n.js';

if (!window.__PI_WEBPICKER__) {
  window.__PI_WEBPICKER__ = true;

  try {
    installCapture();

    const ui = buildUI();
    const ctx = { ui, toast: ui.toast, root: ui.root, host: ui.host, els: ui.els };

    // page.request → 固定 op 表 → 恰一次 page.response（send 由 conn 注入）
    const pageTools = createPageTools({ gm, consoleRing, netRing, debugLog });
    ctx.pageTools = pageTools;

    const conn = createBrokerConn({
      gm,
      debugLog,
      toast: ui.toast,
      onState: (s) => {
        // 'blocked' = the page's CSP refuses the local broker socket: a visible
        // red dot, not the silent "off" the user could mistake for "broker down".
        ui.els.elDot.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : s === 'blocked' ? 'blocked' : '';
        if (ctx.renderConnPill) ctx.renderConnPill(s);
        if (s !== 'on' && ctx.renderTargetCombo) ctx.renderTargetCombo();
      },
      onWelcome: () => { if (ctx.refreshTargets) void ctx.refreshTargets(); },    onPageRequest: (f) => {
        // Last line of defense: an op is never allowed to become an uncaught
        // page error (handlePageToolRequest already catches handler failures;
        // this guards the dispatch machinery itself and page-realm side effects).
        try {
          pageTools.handlePageToolRequest(f, (id, ok, payload) => {
            conn.sendFrame(framePageResponse(id, ok, payload));
          });
        } catch (err) {
          debugLog('page.request dispatch failed:', err && err.message ? err.message : err);
          conn.sendFrame(framePageResponse(f.id, false, 'dispatch_failed: ' + (err && err.message ? err.message : String(err))));
        }
      },
    });
    ctx.conn = conn;

    initPanel(ctx);
    initPick(ctx);
    initCombo(ctx);
    initSend(ctx);
    initBag(ctx);          // 暂存袋抽屉：在 send 之后（依赖 conn），在 fab 之前（bag entry 显隐）
    ctx.setBagEntry(ctx.els.elBagEntry);
    initSettings(ctx);
    initFab(ctx);
    ctx.consoleRing = consoleRing;   // record stop 时按窗口切片用
    ctx.netRing = netRing;
    initRecord(ctx);       // 先于 hotkeys，⇧⌥R 才有目标
    initHotkeys(ctx);

    ctx.refreshCount();
    ctx.updateGroupUI();
    ctx.renderTargetCombo();
    if (ctx.renderSendAffordance) ctx.renderSendAffordance(conn.getState());
    // auto-link：本 origin 授权过（手动连上过一次）就静默重连——覆盖 HMR 整页
    // 刷新、broker 重启两类断链；从未连接过的页面保持完全静默。
    conn.maybeAutoConnect();
  // 未授权过的 origin 也做一次静默探测：像 npmjs 这种用 CSP connect-src 拦截本地
  // broker 的站点，光看状态行要用户点一下才知道——这一次探测让 blocked 徽标立刻
  // 出现，且该判定按 origin 记住（policyBlockedKey），此后不再重复探测。
  conn.maybeProbePolicyBlocked();
    debugLog('ready — ⇧⌥P pick · ⇧⌥L panel · ⇧Enter group · ⌫ clear group · ' + location.host);

    // ---------- programmatic API (DevTools console) ----------
    window.__PI_WP_API__ = {
      start: () => { ctx.setActive(true); return true; },
      stop: () => { ctx.setActive(false); return true; },
      panel: ctx.togglePanel,
      record: () => ctx.toggleRecord(),
      recordState: () => ctx.recState,
      getRecord: () => ctx.getRecord(),
      connect: () => conn.connect(),
      disconnect: () => conn.disconnect(),
      settings: ctx.openSettings,
      send: (prompt, target) => conn.submitToAgent(prompt, target),
      copyPrompt: ctx.copyHandoffPrompt,
      targets: ctx.getTargets,
      refreshTargets: () => ctx.refreshTargets(),
      snapshot: () => loadBatch(),
      tools: () => Object.keys(pageTools.PAGE_TOOLS),
      consoleLog: () => consoleRing.slice(),
      netLog: () => netRing.slice(),
      frameworkProps: () => gm.get('wp.frameworkProps', false) === true,
      setFrameworkProps: (on) => { gm.set('wp.frameworkProps', !!on); ui.els.elSProps.checked = !!on; return !!on; },
      setDebug: (on) => { gm.set(GM_DEBUG, !!on); return !!on; },
      reinject: ui.reinjectTrigger,
    };

    // ---------- Tampermonkey menu ----------
    try {
      GM_registerMenuCommand(t('menu.connect'), () => conn.connect());
      GM_registerMenuCommand(t('menu.disconnect'), () => conn.disconnect());
      GM_registerMenuCommand(t('menu.settings'), ctx.openSettings);
      GM_registerMenuCommand(t('menu.revokeAuto'), () => {
        conn.revokeAutoLink();
        ui.toast(t('toast.autoRevoked', { origin: location.origin }));
      });
      GM_registerMenuCommand(t('menu.openPanel'), ctx.togglePanel);
      GM_registerMenuCommand(t('menu.startPick'), () => ctx.setActive(true));
      GM_registerMenuCommand(t('menu.toggleRecord'), () => ctx.toggleRecord());
      GM_registerMenuCommand(t('menu.reinject'), () => {
        ui.toast(ui.reinjectTrigger() ? t('toast.reinjected') : t('toast.reinjectStuck'));
      });
        GM_registerMenuCommand(t('menu.lang'), () => {
        const lang = toggleLang();
        ui.toast(t('toast.langSwitched'));
        debugLog('language set to', lang);
      });
      GM_registerMenuCommand(t('menu.fabSize'), () => {
        const next = gm.get(GM_FAB_SIZE, 'small') === 'small' ? 'large' : 'small';
        gm.set(GM_FAB_SIZE, next);
        ui.els.elFab.classList.toggle('large', next === 'large');
        ui.toast(t('toast.fabSize', { size: next }));
      });
    } catch (e) { /* menu registration unavailable in this manager */ }
  } catch (err) {
    // Injection died (Trusted Types enforcement, a hostile page API, …). Stay
    // silent no longer: a plain-node message beats a userscript that vanished
    // with no trace — page-tool debugging starts from what the user can see.
    try { failSafeNotice(err); } catch (e) { /* nothing left to render with */ }
    debugLog('init failed:', err && err.message ? err.message : err);
 }
}

/**
 * Last-resort notice rendered outside the shadow UI (buildUI may be exactly what
 * threw). Text-only on purpose: no markup write, no CSS, nothing to enforce.
 */
function failSafeNotice(err) {
  const msg = String((err && err.message) || err || 'unknown error');
  const box = document.createElement('div');
  box.setAttribute('data-pi-wp-error', '');
  box.textContent = 'pi-xfer web picker failed to start: ' + msg;
  Object.assign(box.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    maxWidth: '380px', padding: '10px 12px', borderRadius: '8px',
    background: '#1e293b', color: '#f8fafc', font: '12px/1.5 system-ui, sans-serif',
  });
  (document.body || document.documentElement).appendChild(box);
  setTimeout(() => { try { box.remove(); } catch (e) { /* gone already */ } }, 12000);
}
