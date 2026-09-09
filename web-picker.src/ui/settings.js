// Settings modal — broker URL override, framework props opt-in, per-origin
// auto-link authorization.

import { GM_FPROPS, DEFAULT_BROKER_URL } from '../constants.js';
import { gm } from '../storage.js';
import { autoLinkKey } from '../broker-conn.js';
import { writeOpsKey } from '../page-tools.js';

export function initSettings(ctx) {
  const { els, toast } = ctx;
  const { elSettings, elSUrl, elSSave, elSCancel, elSProps, elSAuto, elSWrite } = els;
  const conn = ctx.conn;

  function openSettings() {
    elSUrl.value = conn.brokerUrl();
    elSProps.checked = gm.get(GM_FPROPS, false) === true;
    elSAuto.checked = conn.autoLinkAllowed();
    elSWrite.checked = gm.get(writeOpsKey(location.origin), false) === true;
    elSettings.style.display = 'block';
    setTimeout(() => elSUrl.focus(), 0);
  }
  function closeSettings() { elSettings.style.display = 'none'; }
  ctx.openSettings = openSettings;
  ctx.closeSettings = closeSettings;
  ctx.settingsOpen = () => elSettings.style.display === 'block';

  elSProps.addEventListener('change', () => {
    gm.set(GM_FPROPS, elSProps.checked);   // immediate persist — no reconnect needed to toggle
    toast('framework.inspect props/state ' + (elSProps.checked ? '已开启' : '已关闭'));
  });
  elSAuto.addEventListener('change', () => {
    // immediate persist — 撤销授权即刻生效（退避循环由 allowed() 门控）
    gm.set(autoLinkKey(location.origin), elSAuto.checked);
    toast('本页自动连接 ' + (elSAuto.checked ? '已开启' : '已撤销'));
  });
  elSWrite.addEventListener('change', () => {
    gm.set(writeOpsKey(location.origin), elSWrite.checked);
    toast('agent 页面操作权限 ' + (elSWrite.checked ? '已开启' : '已关闭'));
  });
  elSSave.addEventListener('click', () => {
    const url = elSUrl.value.trim() || DEFAULT_BROKER_URL;
    gm.set('wp.brokerUrl', url);
    closeSettings();
    toast('已保存，连接中…');
    conn.connect();
  });
  elSCancel.addEventListener('click', closeSettings);
}
