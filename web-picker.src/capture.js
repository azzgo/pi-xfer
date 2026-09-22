// Always-on capture — console.* + fetch/XHR ring buffers.
// Best-effort patch of the PAGE realm (unsafeWindow when available): sandbox-
// realm wrappers never see page-realm calls. Firefox Xray may reject function
// patching — everything is try/catch-wrapped; worst case capture is silent.

import { CAPTURE_MAX, SSE_BUDGET_CHARS, SSE_MAX_EVENTS, SSE_MSG_MAX_CHARS } from './constants.js';
import { jsonSafe } from './json-safe.js';

export const consoleRing = [];   // {level, text, ts, stack?}
// Pending-first semantics: a record is pushed when the request STARTS and
// mutated in place when it completes, so a never-ending response (SSE /
// long-poll) stays visible as {pending:true, kind:'sse'?, msgs?} instead of
// being invisible until "completion" that never comes. Ordering is by start
// time, not completion time.
export const netRing = [];       // {method, url, status, ts, durationMs?, error?, pending?, kind?, msgs?}

export function ringPush(ring, rec) {
  ring.push(rec);
  if (ring.length > CAPTURE_MAX) {
    const removed = ring.splice(0, ring.length - CAPTURE_MAX);
    // Records evicted from netRing take their SSE content buffer with them,
    // so the 1MB SSE budget is freed as streams age out.
    for (const r of removed) {
      if (r && r.sseStream) sseEvict(r.sseStream);
    }
  }
}


// ---------- SSE content capture (v1.14) ----------
// A stream's content lives only while its netRing record is alive: `rec.sse`
// carries the metadata the agent queries (msgs/chars/captured), `rec.sseStream`
// is the internal link so ring eviction frees the buffer. The budget is
// SSE-only (SSE_BUDGET_CHARS); per-stream rings hold the last SSE_MAX_EVENTS
// events, each tail-capped at SSE_MSG_MAX_CHARS, so one stream ≤ ~400KB and
// the whole page ≤ 1MB no matter how many firehose streams are open.
const sseStreams = new Map(); // id -> {id, rec, ring, chars}
let sseSeq = 0;
let sseBudgetUsed = 0;

function sseRecord(rec) {
  const st = { id: 's' + (++sseSeq), rec, ring: [], chars: 0 };
  rec.sse = { id: st.id, msgs: 0, chars: 0, captured: true, events: st.ring };
  rec.sseStream = st;
  sseStreams.set(st.id, st);
  return st;
}

function ssePush(st, ev) {
  try {
    const full = typeof ev.data === 'string' ? ev.data : '';
    const text = full.length > SSE_MSG_MAX_CHARS ? full.slice(-SSE_MSG_MAX_CHARS) : full;
    const entry = { ts: Date.now(), type: ev.type || 'message', data: text };
    if (ev.id) entry.id = ev.id;
    st.ring.push(entry);
    if (st.ring.length > SSE_MAX_EVENTS) st.chars -= (st.ring.shift().data || '').length;
    st.chars += text.length;
    st.rec.sse.msgs++;
    st.rec.sse.chars += full.length; // full count — eviction only drops stored content
    sseBudgetUsed += text.length;
    while (sseBudgetUsed > SSE_BUDGET_CHARS) {
      const oldest = sseStreams.values().next().value;
      if (!oldest || oldest === st) break; // one stream can never exceed the budget
      sseEvict(oldest);
    }
  } catch (e) { /* capture must never break the page */ }
}

function sseEvict(st) {
  try {
    sseStreams.delete(st.id);
    sseBudgetUsed -= st.chars;
    const rec = st.rec;
    if (rec && rec.sse) {
      rec.sse.captured = false; // metadata (msgs/chars) survives; content dropped
      rec.sse.events.length = 0;
    }
    if (rec && rec.sseStream === st) rec.sseStream = undefined;
  } catch (e) { /* ignore */ }
}

// SSE frame parser: `field:value` lines, blank-line separation (\n\n after
// \r\n/\r normalization), `:` comment lines skipped, data lines joined by \n.
function sseParseBlock(st, block) {
  let data = [];
  let type = 'message';
  let id;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const eq = line.indexOf(':');
    const field = eq === -1 ? line : line.slice(0, eq);
    const value = eq === -1 ? '' : line.slice(eq + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
    else if (field === 'id') id = value;
    // `retry` is a reconnect hint, not content — ignored.
  }
  if (data.length) ssePush(st, { type, id, data: data.join('\n') });
}

// Drain the clone branch in the background; the page keeps the original
// response untouched. Decoder stream-mode keeps multi-byte UTF-8 intact
// across chunk boundaries; a page abort just ends the pump.
async function pumpFetchSse(st, stream) {
  const decoder = new TextDecoder();
  let buf = '';
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        sseParseBlock(st, buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    const tail = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (tail.trim()) sseParseBlock(st, tail);
  } catch (e) { /* aborted / opaque — the metadata record still stands */ }
}

function maybeCaptureSse(res, rec) {
  try {
    if (rec.kind !== 'sse' || !res || !res.body || typeof res.clone !== 'function') return;
    const clone = res.clone();
    if (!clone.body) return;
    const st = sseRecord(rec);
    void pumpFetchSse(st, clone.body);
  } catch (e) { /* clone/pump is best-effort; metadata record still stands */ }
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
        // Start-order record; completed in place. An SSE response resolves its
        // headers like any other but the stream never "finishes" — the record
        // keeps pending:true and kind:'sse' so reverse queries find it.
        const rec = { method: String(method), url: String(url).slice(0, 500), ts: started, pending: true };
        ringPush(netRing, rec);
        const done = (res, error) => {
          try {
            if (error) { rec.status = 0; rec.error = String((error && error.message) || error).slice(0, 200); rec.pending = false; }
            else {
              rec.status = res && res.status;
              let ct = '';
              try { ct = String((res && res.headers && res.headers.get('content-type')) || ''); } catch (e) { /* headers may be opaque */ }
              if (ct.includes('text/event-stream')) { rec.kind = 'sse'; }   // stays pending
              else rec.pending = false;
            }
            rec.durationMs = Date.now() - started;
          } catch (e) { /* ignore */ }
        };
        return origFetch.apply(this, args).then(
          (res) => {
            done(res);
            maybeCaptureSse(res, rec);
            return res;
          },
          (err) => {
            done(null, err);
            throw err;
          },
        );
      };
    }
  } catch (e) { /* fetch not patchable */ }
  // EventSource: mark the stream open immediately and keep a message counter —
  // enough for the agent to tell "this stream is alive and has delivered N
  // events" without ever reading the stream body.
  try {
    const ES = realm.EventSource;
    if (typeof ES === 'function') {
      realm.EventSource = function (url, cfg) {
        const es = new ES(url, cfg);
        try {
          const rec = { method: 'GET', url: String(url || '').slice(0, 500), status: 'pending', ts: Date.now(), pending: true, kind: 'sse', msgs: 0 };
          ringPush(netRing, rec);
          const st = sseRecord(rec);
          es.addEventListener('open', () => { rec.status = es.status || 200; });
          es.addEventListener('message', (ev) => {
            rec.msgs++;
            ssePush(st, { type: 'message', id: ev && ev.lastEventId, data: ev && ev.data });
          });
          es.addEventListener('error', () => { if (es.readyState === 2) rec.pending = false; });
          // Named events (`event: <type>`) never fire the generic `message`
          // listener — observe them by wrapping the instance's addEventListener.
          const origAEL = es.addEventListener.bind(es);
          const seenNamed = new Set(); // one capture listener per event type,
          // whatever the page registers
          es.addEventListener = (type, cb, opts) => {
            if (typeof type === 'string' && type !== 'message' && type !== 'open' && type !== 'error' && !seenNamed.has(type)) {
              seenNamed.add(type);
              try {
                origAEL(type, (ev) => {
                  rec.msgs++;
                  ssePush(st, { type, id: ev && ev.lastEventId, data: ev && ev.data });
                }, opts);
              } catch (e) { /* ignore */ }
            }
            return origAEL(type, cb, opts);
          };
        } catch (e) { /* recording must never break the stream */ }
        return es;
      };
      realm.EventSource.prototype = ES.prototype;
    }
  } catch (e) { /* EventSource not patchable */ }
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
            // Record on send, complete on loadend (same object): long-poll XHR
            // is visible as pending while it hangs, like fetch SSE above.
            meta.rec = { method: meta.method, url: meta.url, ts: meta.started, pending: true };
            ringPush(netRing, meta.rec);
            this.addEventListener('loadend', () => {
              try {
                const rec = meta.rec;
                if (!rec) return;                       // evicted from the ring already
                rec.status = this.status;
                rec.durationMs = Date.now() - (meta.started || Date.now());
                rec.pending = false;
              } catch (e) { /* ignore */ }
            });
          } catch (e) { /* ignore */ }
          return origSend.apply(this, arguments);
        };
      }
    }
  } catch (e) { /* XHR not patchable */ }
}
