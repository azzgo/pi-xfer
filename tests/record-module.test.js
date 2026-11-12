// record module tests — the parked record must be plain JSON.
// netRing entries keep a live back-link (`sseStream.rec === entry`) for SSE
// budget eviction; parking those objects verbatim made the record circular,
// which broke both the submit frame and sessionStorage persistence.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initRecord } from '../web-picker.src/record.js';
import { KEY_REC } from '../web-picker.src/constants.js';

function makeSessionStorage() {
  const store = new Map();
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

function elStub() {
  return { style: {}, addEventListener() {}, textContent: '' };
}

function makeCtx() {
  const ctx = {
    els: {
      elRecBar: elStub(),
      elRecCount: elStub(),
      elRecStop: elStub(),
      elRecDiscard: elStub(),
      elRecBadge: elStub(),
    },
    toast: () => {},
    pickState: {},
    consoleRing: [],
    netRing: [],
    refreshCount: () => {},
  };
  initRecord(ctx);
  return ctx;
}

beforeEach(() => {
  globalThis.sessionStorage = makeSessionStorage();
  globalThis.location = { href: 'https://app.example/page', origin: 'https://app.example' };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
});

test('a parked record is JSON-serializable and free of the SSE back-link', () => {
  const events = [{ ts: 1, type: 'message', data: 'tick' }];
  const entry = {
    method: 'GET', url: 'https://api.example/stream', status: 200, ts: Date.now(), kind: 'sse',
    sse: { id: 's1', msgs: 1, chars: 4, captured: true, events },
  };
  entry.sseStream = { id: 's1', rec: entry, ring: events, chars: 4 };

  const ctx = makeCtx();
  ctx.startRecord();
  const started = Date.now();
  entry.ts = started;
  ctx.consoleRing.push({ level: 'log', text: 'hello', ts: started });
  ctx.netRing.push(entry);
  ctx.stopRecord(false);

  const rec = ctx.getRecord();
  assert.ok(rec, 'the record was parked');
  assert.doesNotThrow(() => JSON.stringify(rec), 'the record no longer closes a cycle');
  assert.equal(rec.net.length, 1);
  assert.equal(rec.net[0].sseStream, undefined, 'the internal back-link is stripped');
  assert.deepEqual(rec.net[0].sse.events, events, 'SSE content survives as a copy');
  assert.notEqual(rec.net[0].sse.events, events);
  assert.equal(rec.net[0].sse.captured, true);

  assert.equal(entry.sseStream.id, 's1', 'the live ring entry keeps its back-link');
  assert.equal(entry.sse.events, events, 'the live ring entry keeps its event buffer');

  const persisted = JSON.parse(globalThis.sessionStorage.getItem(KEY_REC));
  assert.equal(persisted.status, 'done', 'persistence no longer fails silently');
  assert.equal(persisted.rec.net[0].sseStream, undefined);
});
