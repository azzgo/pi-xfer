// broker-conn module tests — auto-link authorization + backoff reconnect.
// Runs the actual web-picker.src/broker-conn.js in node with stubs for
// WebSocket / GM storage / location — the seam the v1.12 modularization
// created is what makes the userscript connection layer testable at all.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerConn, autoLinkKey } from './web-picker.src/broker-conn.js';

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

beforeEach(() => {
  gmStore.clear();
  FakeWebSocket.instances = [];
  delete globalThis.document; delete globalThis.window; // frameHello not exercised here
  globalThis.document = { title: 't' };
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
