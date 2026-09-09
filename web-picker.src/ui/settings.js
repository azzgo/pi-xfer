// Settings modal — broker URL override + framework props opt-in.

import { GM_FPROPS, DEFAULT_BROKER_URL } from '../constants.js';
import { gm } from '../storage.js';

export function initSettings(ctx) {
  const { els, toast } = ctx;
  const { elSettings, elSUrl, elSSave, elSCancel, elSProps } = els;
  const conn = ctx.conn;

  function openSettings() {
    elSUrl.value = conn.brokerUrl();
    elSProps.checked = gm.get(GM_FPROPS, false) === true;
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
  elSSave.addEventListener('click', () => {
    const url = elSUrl.value.trim() || DEFAULT_BROKER_URL;
    gm.set('wp.brokerUrl', url);
    closeSettings();
    toast('已保存，连接中…');
    conn.connect();
  });
  elSCancel.addEventListener('click', closeSettings);
}
