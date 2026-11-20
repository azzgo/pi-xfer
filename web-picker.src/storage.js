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

export function fabHiddenKey(origin) {
  return 'wp.fabHidden.' + origin;
}

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

// Injection whitelist (v1.16): localhost + 127.* + IPv6 loopback activate the
// picker by default; every other origin stays silent until the user opts in
// from the script menu. One GM key holds the opted-in origins.
const GM_ENABLED_ORIGINS = 'wp.enabledOrigins';

export function isDefaultAllowedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (h === '::1' || h === '::' ) return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(h)) return true;
  // IPv4-mapped and other all-zero forms ending in ::1 (e.g. 0:0:0:0:0:0:0:1)
  return h === '0:0:0:0:0:0:0:1';
}

export function originEnabled() {
  if (isDefaultAllowedHost(location.hostname)) return true;
  const list = gm.get(GM_ENABLED_ORIGINS, []);
  return Array.isArray(list) && list.indexOf(location.origin) >= 0;
}

export function setOriginEnabled(on) {
  const list = Array.isArray(gm.get(GM_ENABLED_ORIGINS, [])) ? gm.get(GM_ENABLED_ORIGINS, []) : [];
  const i = list.indexOf(location.origin);
  if (on && i < 0) list.push(location.origin);
  if (!on && i >= 0) list.splice(i, 1);
  gm.set(GM_ENABLED_ORIGINS, list);
}
