// Wire protocol v0.1 (Ticket 007 + trial amends: no token, targets frames).
// Every frame carries { v, type }; each request gets exactly one reply (ack | error).
// All protocol constants and frame builders live here — never write a frame inline.

import { PROTOCOL, PAGE_OPS } from './wire.js';
import { loadBatch } from './storage.js';

export { PROTOCOL, PAGE_OPS };

export function frame(type, extra) { return Object.assign({ v: PROTOCOL.V, type }, extra); }

export function frameHello() {
  return frame(PROTOCOL.KIND_HELLO, {
    client: { ua: 'tampermonkey', tab: { id: String(Date.now()), url: location.href, title: document.title } },
  });
}

export function frameSubmit(id, prompt, targetName) {
  return frame(PROTOCOL.KIND_SUBMIT, {
    id,
    page: { url: location.href, title: document.title },
    picks: loadBatch(),
    prompt,
    target: { namespace: PROTOCOL.NS_LOCAL, name: targetName },
  });
}

// 与 submit 同构（page/picks/prompt/target），但 target 可省略——compose 只用
// 它渲染 follow-up 示例里的 fromTarget，没有目标也能渲染。
export function frameCompose(id, prompt, targetName) {
  return frame(PROTOCOL.KIND_COMPOSE, {
    id,
    page: { url: location.href, title: document.title },
    picks: loadBatch(),
    prompt,
    ...(targetName ? { target: { namespace: PROTOCOL.NS_LOCAL, name: targetName } } : {}),
  });
}

export function frameTargetsList(id) {
  return frame(PROTOCOL.KIND_TARGETS_LIST, { id });
}

export function framePageResponse(id, ok, payload) {
  return frame(PROTOCOL.KIND_PAGE_RESPONSE, {
    id,
    ok,
    ...(ok ? { text: payload } : { error: payload }),
  });
}
