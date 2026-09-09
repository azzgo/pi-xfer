// Storage — all keys under pi.wp.*, all access guarded.
// GM storage survives across tabs and sessions (debug flag today; connection
// prefs in the broker revision). sessionStorage keeps the per-tab batch.

import { KEY_PICKS, GM_DEBUG } from './constants.js';

export const gm = {
  get(k, d) {
    try { const v = GM_getValue(k); return v === undefined ? d : v; }
    catch (e) { return d; }
  },
  set(k, v) {
    try { GM_setValue(k, v); }
    catch (e) { /* GM storage unavailable — value simply won't persist */ }
  },
};

export function debugLog(...args) {
  if (gm.get(GM_DEBUG, false) !== true) return;
  console.log('[pi.wp]', ...args);
}

export function loadBatch() {
  try {
    const s = sessionStorage.getItem(KEY_PICKS);
    const b = s ? JSON.parse(s) : [];
    return Array.isArray(b) ? b : [];
  } catch (e) { return []; }
}

export function saveBatch(b) {
  try { sessionStorage.setItem(KEY_PICKS, JSON.stringify(b)); }
  catch (e) { /* quota / privacy mode — batch stays in memory for this page */ }
}
