// Xfer Web Picker — entry assembly.
// Source of truth for wiring: build the shadow UI, create the broker
// connection, create the page-tool table, then let each UI module register
// onto the shared ctx. Cross-module calls go through ctx at event time, so
// registration order only decides which functions exist when the first event
// fires — by the end of this file everything is in place.

import { GM_DEBUG } from './constants.js';
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
import { initSettings } from './ui/settings.js';
import { initFab } from './ui/fab.js';
import { initHotkeys } from './ui/hotkeys.js';

if (!window.__PI_WEBPICKER__) {
  window.__PI_WEBPICKER__ = true;

  installCapture();

  const ui = buildUI();
  const ctx = { ui, toast: ui.toast, root: ui.root, host: ui.host, els: ui.els };

  // page.request → 固定 op 表 → 恰一次 page.response（send 由 conn 注入）
  const pageTools = createPageTools({ gm, consoleRing, netRing });
  ctx.pageTools = pageTools;

  const conn = createBrokerConn({
    gm,
    debugLog,
    toast: ui.toast,
    onState: (s) => {
      ui.els.elDot.className = s === 'on' ? 'on' : s === 'connecting' ? 'connecting' : '';
      if (ctx.renderConnPill) ctx.renderConnPill(s);
      if (s !== 'on' && ctx.renderTargetCombo) ctx.renderTargetCombo();
    },
    onWelcome: () => { if (ctx.refreshTargets) void ctx.refreshTargets(); },
    onPageRequest: (f) => {
      pageTools.handlePageToolRequest(f, (id, ok, payload) => {
        conn.sendFrame(framePageResponse(id, ok, payload));
      });
    },
  });
  ctx.conn = conn;

  initPanel(ctx);
  initPick(ctx);
  initCombo(ctx);
  initSend(ctx);
  initSettings(ctx);
  initFab(ctx);
  initHotkeys(ctx);

  ctx.refreshCount();
  ctx.updateGroupUI();
  ctx.renderTargetCombo();
  debugLog('ready — ⇧⌥P 拾取 · ⇧⌥L 面板 · ⇧Enter 加组 · ⌫ 清组 · ' + location.host);

  // ---------- programmatic API (DevTools console) ----------
  window.__PI_WP_API__ = {
    start: () => { ctx.setActive(true); return true; },
    stop: () => { ctx.setActive(false); return true; },
    panel: ctx.togglePanel,
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
    GM_registerMenuCommand('连接 broker', () => conn.connect());
    GM_registerMenuCommand('断开 broker', () => conn.disconnect());
    GM_registerMenuCommand('连接设置…', ctx.openSettings);
    GM_registerMenuCommand('打开标注面板 (⇧⌥L)', ctx.togglePanel);
    GM_registerMenuCommand('开始拾取 (⇧⌥P)', () => ctx.setActive(true));
    GM_registerMenuCommand('重新注入 trigger', () => {
      ui.toast(ui.reinjectTrigger() ? 'trigger 已重新注入' : 'trigger 仍在页面上');
    });
  } catch (e) { /* menu registration unavailable in this manager */ }
}
