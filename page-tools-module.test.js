// page-tools module tests — per-origin write gate + write op handlers.
// createPageTools(env) accepts injected gm/doc, so the gate and handlers run
// in node against a minimal DOM stub.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPageTools, writeOpsKey } from './web-picker.src/page-tools.js';
import { PAGE_OPS } from './web-picker.src/wire.js';

const gmStore = new Map();
const gmStub = {
  get: (k, d) => (gmStore.has(k) ? gmStore.get(k) : d),
  set: (k, v) => gmStore.set(k, v),
};

// Minimal document stub: only what the gate tests and dom.click/setValue hit.
function makeDoc(elements) {
  const bySel = new Map(Object.entries(elements));
  return {
    querySelector: (sel) => bySel.get(sel) || null,
    querySelectorAll: (sel) => (bySel.has(sel) ? [bySel.get(sel)] : []),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };
}

function makeEl(overrides = {}) {
  const listeners = [];
  return {
    tagName: 'BUTTON',
    nodeName: 'button',
    nodeType: 1,
    id: '',
    classList: [],
    disabled: false,
    value: '',
    dispatched: [],
    getBoundingClientRect: () => ({ left: 1, top: 2, width: 30, height: 10 }),
    getAttribute: () => null,
    closest: () => null,
    addEventListener: () => {},
    click() { this.dispatched.push('native-click'); },
    dispatchEvent(ev) { this.dispatched.push(ev.type); return true; },
    ...overrides,
  };
}

beforeEach(() => {
  gmStore.clear();
  globalThis.location = { origin: 'https://app.example' };
  // cssPath walks up via document.documentElement / window.CSS — minimal stubs
  globalThis.document = { documentElement: {}, title: 't' };
  globalThis.window = {};
});

test('write ops are denied without per-origin authorization', () => {
  const { handlePageToolRequest } = createPageTools({ gm: gmStub, doc: makeDoc({}) });
  const replies = [];
  handlePageToolRequest(
    { id: 'r1', tool: { op: PAGE_OPS.DOM_CLICK, params: { selector: '#go' } } },
    (id, ok, payload) => replies.push({ id, ok, payload }),
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.match(replies[0].payload, /^denied_op: dom\.click/);
  assert.ok(replies[0].payload.includes('https://app.example'));
});

test('write ops run once the origin is authorized; overlay targets are refused', () => {
  gmStore.set(writeOpsKey('https://app.example'), true);
  // browser globals the click sequence touches
  globalThis.window = {};
  class MouseEventStub { constructor(type) { this.type = type; } }
  globalThis.MouseEvent = MouseEventStub;
  globalThis.PointerEvent = class extends MouseEventStub {};

  const button = makeEl();
  const overlay = makeEl({ closest: () => ({}) });   // inside [data-pi-wp-host]
  const { handlePageToolRequest } = createPageTools({
    gm: gmStub,
    doc: makeDoc({ '#go': button, '.overlay': overlay }),
  });

  const replies = [];
  const send = (id, ok, payload) => replies.push({ id, ok, payload });

  handlePageToolRequest({ id: 'r2', tool: { op: PAGE_OPS.DOM_CLICK, params: { selector: '#go' } } }, send);
  assert.equal(replies[0].ok, true, 'dom.click should succeed: ' + replies[0].payload);
  const result = JSON.parse(replies[0].payload);
  assert.equal(result.clicked, true);
  assert.ok(button.dispatched.includes('click') && button.dispatched.includes('native-click'));

  handlePageToolRequest({ id: 'r3', tool: { op: PAGE_OPS.DOM_CLICK, params: { selector: '.overlay' } } }, send);
  assert.equal(replies[1].ok, false);
  assert.match(replies[1].payload, /refused: target is the picker overlay/);
});

test('dom.setValue uses the native setter contract and dispatches input+change', () => {
  gmStore.set(writeOpsKey('https://app.example'), true);
  const written = { v: null };
  const events = [];
  class EventStub { constructor(type) { this.type = type; } }
  globalThis.Event = EventStub;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLSelectElement = class {};
  globalThis.HTMLInputElement = class {
    set value(v) { written.v = v; }
    get value() { return written.v; }
  };
  const input = makeEl();
  Object.setPrototypeOf(input, HTMLInputElement.prototype);
  input.dispatched = []; // reset; prototype accessors record via `written`, events via dispatchEvent
  input.dispatchEvent = (ev) => { events.push(ev.type); return true; };

  const { handlePageToolRequest } = createPageTools({ gm: gmStub, doc: makeDoc({ '#q': input }) });
  const replies = [];
  handlePageToolRequest({ id: 'r4', tool: { op: PAGE_OPS.DOM_SET_VALUE, params: { selector: '#q', value: 'hello' } } },
    (id, ok, payload) => replies.push({ id, ok, payload }));
  assert.equal(replies[0].ok, true, 'dom.setValue should succeed: ' + replies[0].payload);
  assert.equal(written.v, 'hello');
  assert.deepEqual(events, ['input', 'change']);
});

test('page.wait is a read op: found → ok, missing → error naming the selector', () => {
  const { handlePageToolRequest } = createPageTools({
    gm: gmStub,
    doc: makeDoc({ '.done': makeEl({ tagName: 'DIV' }) }),
  });
  const replies = [];
  const send = (id, ok, payload) => replies.push({ id, ok, payload });
  handlePageToolRequest({ id: 'r5', tool: { op: PAGE_OPS.PAGE_WAIT, params: { selector: '.done' } } }, send);
  assert.equal(replies[0].ok, true);
  assert.equal(JSON.parse(replies[0].payload).found, true);
  handlePageToolRequest({ id: 'r6', tool: { op: PAGE_OPS.PAGE_WAIT, params: { selector: '.nope' } } }, send);
  assert.equal(replies[1].ok, false);
  assert.match(replies[1].payload, /page\.wait: no element matches \.nope/);
});

test('read ops never hit the write gate', () => {
  const { handlePageToolRequest } = createPageTools({ gm: gmStub, doc: makeDoc({}) });
  const replies = [];
  handlePageToolRequest({ id: 'r7', tool: { op: PAGE_OPS.PAGE_WAIT, params: { selector: '.x' } } },
    (id, ok, payload) => replies.push({ id, ok, payload }));
  assert.equal(replies[0].ok, false);
  assert.ok(!String(replies[0].payload).startsWith('denied_op')); // gate skipped → plain no-match error
});

test('network.sse returns captured event slices and truthful eviction state', () => {
  const netRing = [
    {
      method: 'GET', url: 'https://api.example/stream', status: 200, ts: 1, pending: true, kind: 'sse',
      sse: {
        id: 's1', msgs: 3, chars: 120, captured: true,
        events: [
          { ts: 1, type: 'message', data: 'hello' },
          { ts: 2, type: 'ping', data: 'x'.repeat(5000) },
          { ts: 3, type: 'message', data: 'world' },
        ],
      },
    },
    {
      method: 'GET', url: 'https://api.example/old', status: 200, ts: 0, pending: true, kind: 'sse',
      sse: { id: 's0', msgs: 900, chars: 9000, captured: false, events: [] },
    },
  ];
  const { handlePageToolRequest } = createPageTools({ gm: gmStub, doc: makeDoc({}), netRing });
  const replies = [];
  const send = (id, ok, payload) => replies.push({ id, ok, payload });

  handlePageToolRequest({ id: 'r8', tool: { op: PAGE_OPS.SSE_LOG, params: { urlFilter: '/stream' } } }, send);
  assert.equal(replies[0].ok, true);
  const result = JSON.parse(replies[0].payload);
  assert.equal(result.total, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.streams[0].stream, 's1');
  assert.equal(result.streams[0].captured, true);
  assert.equal(result.streams[0].events.length, 3);
  assert.equal(result.streams[0].events[2].data, 'world');
  assert.equal(result.streams[0].events[2].type, 'message');

  handlePageToolRequest({ id: 'r9', tool: { op: PAGE_OPS.SSE_LOG, params: { maxCharsPerEvent: 64 } } }, send);
  const sliced = JSON.parse(replies[1].payload);
  assert.equal(sliced.streams[0].events[1].data.length, 64);
  assert.ok(sliced.streams[0].events[1].data.endsWith('xxxxx'));

  handlePageToolRequest({ id: 'r10', tool: { op: PAGE_OPS.SSE_LOG, params: { urlFilter: '/old' } } }, send);
  const evicted = JSON.parse(replies[2].payload);
  assert.equal(evicted.total, 1);
  assert.equal(evicted.streams[0].captured, false);
  assert.deepEqual(evicted.streams[0].events, []);
  assert.equal(evicted.streams[0].msgs, 900); // metadata survives eviction
});
