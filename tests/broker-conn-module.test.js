// broker-conn module tests — auto-link authorization + backoff reconnect.
// Runs the actual web-picker.src/broker-conn.js in node with stubs for
// WebSocket / GM storage / location — the seam the v1.12 modularization
// created is what makes the userscript connection layer testable at all.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerConn, autoLinkKey, policyBlockedKey } from '../web-picker.src/broker-conn.js';

// ---- node-env stubs (module expects browser globals) ----

class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    FakeWebSocket.instances.push(this);
    this.url = url;
    this.readyState = 0;
    this.sent = [];
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  // test helpers
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  message(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
  drop() { if (this.onclose) this.onclose(); }
  error() { this.readyState = 3; if (this.onerror) this.onerror(); }
}
FakeWebSocket.instances = [];

const gmStore = new Map();
globalThis.GM_getValue = (k) => gmStore.get(k);
globalThis.GM_setValue = (k, v) => gmStore.set(k, v);
globalThis.WebSocket = FakeWebSocket;
globalThis.location = { origin: 'https://app.example', href: 'https://app.example/page' };

const ORIGIN_KEY = autoLinkKey('https://app.example');

function makeConn(overrides = {}) {
  const calls = { toasts: [], states: [], welcomes: 0 };
  const conn = createBrokerConn({
    gm: {
      get: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
      set: (k, v) => gmStore.set(k, v),
    },
    debugLog: () => {},
    toast: (m) => calls.toasts.push(m),
    onState: (s) => calls.states.push(s),
    onWelcome: () => calls.welcomes++,
    ...overrides,
  });
  return { conn, calls };
}

function lastSock() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }

/** Minimal document stub that records capture-phase listeners and can fire them. */
function makeDocument() {
  const listeners = [];
  return {
    title: 't',
    listeners,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    /** Deliver a CSP violation the way the browser does. */
    violation(ev) { for (const l of listeners.slice()) if (l.type === 'securitypolicyviolation') l.fn(ev); },
  };
}

beforeEach(() => {
  gmStore.clear();
  FakeWebSocket.instances = [];
  delete globalThis.document; delete globalThis.window; // frameHello not exercised here
  globalThis.document = makeDocument();
});

test('manual connect success authorizes auto-link for the origin', async () => {
  const { conn } = makeConn();
  assert.equal(gmStore.get(ORIGIN_KEY), undefined);
  const attempt = conn.connect();
  lastSock().open();
  lastSock().message({ type: 'welcome' });
  assert.equal(await attempt, true);
  assert.equal(gmStore.get(ORIGIN_KEY), true);
});

test('failed manual connect does NOT authorize auto-link', async () => {
  const { conn } = makeConn();
  const attempt = conn.connect();
  lastSock().drop(); // close before welcome = pairing failed
  assert.equal(await attempt, false);
  assert.equal(gmStore.get(ORIGIN_KEY), undefined);
});

test('maybeAutoConnect is a no-op without authorization', () => {
  const { conn } = makeConn();
  assert.equal(conn.maybeAutoConnect(), false);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('authorized origin auto-connects silently and survives reconnects', async () => {
  gmStore.set(ORIGIN_KEY, true);
  const { conn, calls } = makeConn();
  assert.equal(conn.maybeAutoConnect(), true);
  const sock = lastSock();
  sock.open();
  sock.message({ type: 'welcome' });
  // silent attempt still authorizes nothing new but must reach 'on' without toasts
  assert.equal(conn.getState(), 'on');
  assert.equal(calls.toasts.filter((t) => t.includes('已连接')).length, 0);
  // broker restarts → close → backoff reconnect is scheduled (not manual-down)
  sock.drop();
  assert.equal(conn.getState(), 'off');
  conn.disconnect(); // stop the backoff loop — its timer must not leak into later tests
});

test('manual disconnect cancels auto reconnect for this page load', async () => {
  gmStore.set(ORIGIN_KEY, true);
  const { conn } = makeConn();
  conn.maybeAutoConnect();
  lastSock().open();
  lastSock().message({ type: 'welcome' });
  conn.disconnect();
  assert.equal(gmStore.get(ORIGIN_KEY), true); // authorization survives…
  // …but a broker-side close after manual disconnect must not auto-reconnect.
  lastSock().drop();
  // no new socket within the first backoff step
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('revokeAutoLink clears the per-origin authorization', async () => {
  gmStore.set(ORIGIN_KEY, true);
  const { conn } = makeConn();
  conn.revokeAutoLink();
  assert.equal(gmStore.get(ORIGIN_KEY), false);
  assert.equal(conn.autoLinkAllowed(), false);
  assert.equal(conn.maybeAutoConnect(), false);
});

// ---- CSP-blocked connect (npmjs-style) ----

test('a connect-src violation for our socket settles the attempt and blocks', async () => {
  const { conn, calls } = makeConn();
  const attempt = conn.connect();
  lastSock().error();                       // npmjs fires error…
  document.violation({                      // …and reports why through the policy event
    violatedDirective: 'connect-src',
    blockedURI: 'ws://127.0.0.1:4719/ws',
  });
  assert.equal(await attempt, false, 'onerror alone settles: the socket never closes');
  assert.equal(conn.getState(), 'blocked');
  assert.equal(calls.toasts.filter((m) => m.includes('策略') || m.includes('policy')).length, 1);
});

test('blocked stops the backoff reconnect loop', async () => {
  gmStore.set(ORIGIN_KEY, true);
  const { conn } = makeConn();
  conn.maybeAutoConnect();
  lastSock().error();
  document.violation({ violatedDirective: 'connect-src', blockedURI: 'ws://127.0.0.1:4719/ws' });
  assert.equal(conn.getState(), 'blocked');
  await new Promise((r) => setTimeout(r, 1100));   // first backoff step would have fired
  assert.equal(FakeWebSocket.instances.length, 1, 'no retry: the policy will not change');
});

test('unrelated CSP violations (other directives / other hosts) are ignored', async () => {
  const { conn, calls } = makeConn();
  const attempt = conn.connect();
  document.violation({ violatedDirective: 'img-src', blockedURI: 'https://cdn.example/pixel.png' });
  document.violation({ violatedDirective: 'connect-src', blockedURI: 'wss://api.example.com/track' });
  assert.equal(conn.getState(), 'connecting');
  assert.equal(calls.toasts.length, 0);
  lastSock().open();
  lastSock().message({ type: 'welcome' });
  assert.equal(await attempt, true);
  assert.equal(conn.getState(), 'on');
});

test('a manual connect after a block retries and can succeed', async () => {
  const { conn } = makeConn();
  const blocked = conn.connect();
  lastSock().error();
  document.violation({ violatedDirective: 'connect-src', blockedURI: 'ws://127.0.0.1:4719/ws' });
  await blocked;
  const retry = conn.connect();
  lastSock().open();
  lastSock().message({ type: 'welcome' });
  assert.equal(await retry, true);
  assert.equal(conn.getState(), 'on');
});

// ---- one-shot silent probe: blocked state without a click ----

test('probe on an unlinked origin opens exactly one silent socket', async () => {
  const { conn, calls } = makeConn();
  assert.equal(conn.maybeProbePolicyBlocked(), true);
  assert.equal(FakeWebSocket.instances.length, 1);
  // Plain failure (broker simply down) stays invisible: no toast, no backoff.
  lastSock().error();
  lastSock().drop();
  assert.equal(conn.getState(), 'off');
  assert.deepEqual(calls.toasts, []);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeWebSocket.instances.length, 1, 'no backoff for an unauthorized origin');
});

test('probe surfaces a policy block quietly and remembers it for the origin', async () => {
  const { conn, calls } = makeConn();
  conn.maybeProbePolicyBlocked();
  lastSock().error();
  document.violation({ violatedDirective: 'connect-src', blockedURI: 'ws://127.0.0.1:4719/ws' });
  assert.equal(conn.getState(), 'blocked');
  assert.deepEqual(calls.toasts, [], 'the silent probe does not nag');
  assert.equal(gmStore.get(policyBlockedKey('https://app.example')), true);
});

test('a remembered block is restored with no socket at all', () => {
  gmStore.set(policyBlockedKey('https://app.example'), true);
  const { conn, calls } = makeConn();
  assert.equal(conn.maybeProbePolicyBlocked(), true);
  assert.equal(conn.getState(), 'blocked');
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepEqual(calls.toasts, []);
});

test('auto-linked origins are left to auto-link (probe is a no-op)', () => {
  gmStore.set(ORIGIN_KEY, true);
  const { conn } = makeConn();
  conn.maybeAutoConnect();
  assert.equal(conn.maybeProbePolicyBlocked(), false);
  assert.equal(FakeWebSocket.instances.length, 1, 'only the auto-link attempt');
});

test('a successful manual connect clears a remembered block', async () => {
  gmStore.set(policyBlockedKey('https://app.example'), true);
  const { conn } = makeConn();
  const attempt = conn.connect();
  lastSock().open();
  lastSock().message({ type: 'welcome' });
  assert.equal(await attempt, true);
  assert.equal(gmStore.get(policyBlockedKey('https://app.example')), false);
});

test('the blocked toast still fires on a manual attempt (not silent)', async () => {
  const { conn, calls } = makeConn();
  const attempt = conn.connect();
  lastSock().error();
  document.violation({ violatedDirective: 'connect-src', blockedURI: 'ws://127.0.0.1:4719/ws' });
  await attempt;
  assert.equal(conn.getState(), 'blocked');
  assert.equal(calls.toasts.filter((m) => m.includes('策略') || m.includes('policy')).length, 1);
});
