// Always-on capture — console.* + fetch/XHR ring buffers.
// Best-effort patch of the PAGE realm (unsafeWindow when available): sandbox-
// realm wrappers never see page-realm calls. Firefox Xray may reject function
// patching — everything is try/catch-wrapped; worst case capture is silent.

import { CAPTURE_MAX } from './constants.js';
import { jsonSafe } from './json-safe.js';

export const consoleRing = [];   // {level, text, ts, stack?}
export const netRing = [];       // {method, url, status, durationMs, ts, error?}

export function ringPush(ring, rec) {
  ring.push(rec);
  if (ring.length > CAPTURE_MAX) ring.splice(0, ring.length - CAPTURE_MAX);
}

function captureRealm() {
  try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; }
  catch (e) { return window; }
}

function fmtCaptureArg(v) {
  try {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    const t = jsonSafe(v).text;
    return t.length > 400 ? t.slice(0, 400) + '…' : t;
  } catch (e) { return String(v); }
}

export function installCapture() {
  const realm = captureRealm();
  // console.*（跳过我们自己的 [pi.wp] 调试行，避免 debug 模式污染环形缓冲）
  try {
    for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
      const original = realm.console && typeof realm.console[level] === 'function' ? realm.console[level] : null;
      if (!original) continue;
      realm.console[level] = function (...args) {
        try {
          const first = typeof args[0] === 'string' ? args[0] : '';
          if (!first.startsWith('[pi.wp]')) {
            const rec = { level, text: args.map(fmtCaptureArg).join(' '), ts: Date.now() };
            if (level === 'error' && args[0] instanceof Error && args[0].stack) rec.stack = String(args[0].stack).slice(0, 2000);
            ringPush(consoleRing, rec);
          }
        } catch (e) { /* capture must never break the page */ }
        return original.apply(this === undefined ? realm.console : this, args);
      };
    }
  } catch (e) { /* console not patchable */ }
  try {
    realm.addEventListener('error', (ev) => {
      try {
        const err = ev && ev.error;
        ringPush(consoleRing, {
          level: 'error',
          text: (ev && ev.message) || 'window.onerror',
          stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
          ts: Date.now(),
        });
      } catch (e) { /* ignore */ }
    });
    realm.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = ev && ev.reason;
        ringPush(consoleRing, {
          level: 'error',
          text: 'unhandledrejection: ' + fmtCaptureArg(reason),
          stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : undefined,
          ts: Date.now(),
        });
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* realm listeners unavailable */ }
  try {
    const origFetch = realm.fetch;
    if (typeof origFetch === 'function') {
      realm.fetch = function (...args) {
        const started = Date.now();
        const req = args[0];
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        const method = (args[1] && args[1].method) || (req && req.method) || 'GET';
        const done = (res, error) => {
          try {
            const rec = { method: String(method), url: String(url).slice(0, 500), ts: Date.now() };
            if (error) { rec.status = 0; rec.error = String((error && error.message) || error).slice(0, 200); }
            else rec.status = res && res.status;
            rec.durationMs = Date.now() - started;
            ringPush(netRing, rec);
          } catch (e) { /* ignore */ }
        };
        return origFetch.apply(this, args).then(
          (res) => { done(res); return res; },
          (err) => { done(null, err); throw err; },
        );
      };
    }
  } catch (e) { /* fetch not patchable */ }
  try {
    const XHR = realm.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      if (typeof origOpen === 'function' && typeof origSend === 'function') {
        XHR.prototype.open = function (method, url) {
          try { this.__wpNet = { method: String(method || 'GET'), url: String(url || '').slice(0, 500), started: 0 }; }
          catch (e) { /* Xray may refuse expando writes */ }
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          let meta = null;
          try { meta = this.__wpNet || null; } catch (e) { /* Xray */ }
          if (!meta) meta = { method: 'GET', url: '', started: Date.now() };
          meta.started = Date.now();
          try {
            this.addEventListener('loadend', () => {
              try {
                ringPush(netRing, {
                  method: meta.method, url: meta.url, status: this.status,
                  durationMs: Date.now() - (meta.started || Date.now()), ts: Date.now(),
                });
              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }
          return origSend.apply(this, arguments);
        };
      }
    }
  } catch (e) { /* XHR not patchable */ }
}
