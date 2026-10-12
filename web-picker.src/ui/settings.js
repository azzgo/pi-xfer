// Settings modal — broker URL override, framework props opt-in, per-origin
// auto-link authorization.

import { GM_FPROPS, DEFAULT_BROKER_URL } from '../constants.js';
import { gm } from '../storage.js';
import { autoLinkKey } from '../broker-conn.js';
import { writeOpsKey } from '../page-tools.js';
import { t } from '../i18n.js';

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
    toast(t('settings.toast.fprops', { state: t(elSProps.checked ? 'settings.toast.on' : 'settings.toast.off') }));
  });
  elSAuto.addEventListener('change', () => {
    // immediate persist — 撤销授权即刻生效（退避循环由 allowed() 门控）
    gm.set(autoLinkKey(location.origin), elSAuto.checked);
    toast(t('settings.toast.autoLink', { state: t(elSAuto.checked ? 'settings.toast.on' : 'settings.toast.revoked') }));
  });
  elSWrite.addEventListener('change', () => {
    gm.set(writeOpsKey(location.origin), elSWrite.checked);
    toast(t('settings.toast.write', { state: t(elSWrite.checked ? 'settings.toast.on' : 'settings.toast.off') }));
  });
  elSSave.addEventListener('click', () => {
    const url = elSUrl.value.trim() || DEFAULT_BROKER_URL;
    gm.set('wp.brokerUrl', url);
    closeSettings();
    toast(t('settings.toast.saved'));
    conn.connect();
  });
  elSCancel.addEventListener('click', closeSettings);
}
