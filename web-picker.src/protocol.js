// Wire protocol v0.1 (Ticket 007 + trial amends: no token, targets frames).
// Every frame carries { v, type }; each request gets exactly one reply (ack | error).
// All protocol constants and frame builders live here — never write a frame inline.

import { PROTOCOL, PAGE_OPS } from './wire.js';
import { loadBatch } from './storage.js';

export { PROTOCOL, PAGE_OPS };

export function frame(type, extra) { return Object.assign({ v: PROTOCOL.V, type }, extra); }

export function frameHello() {
  return frame(PROTOCOL.KIND_HELLO, {
    client: { ua: 'tampermonkey', tab: { id: pageTabId(), url: location.href, title: document.title } },
  });
}

// Page-lifetime tab id: stable across HMR full reloads (sessionStorage) so
// the broker routes follow-up page.requests back to THIS tab — that's the
// reload-surviving half of the verification loop.
function pageTabId() {
  const KEY = 'pi.wp.tabId';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) { id = 'tab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); sessionStorage.setItem(KEY, id); }
    return id;
  } catch (e) { return 'tab-' + Date.now().toString(36); }
}

// `record` (v1.13) is additive: a finished Record-mode capture attached to
// the submit. Old brokers ignore the unknown field; the broker renders it as
// an "Operation timeline" section. Absent on pick-only submits.
export function frameSubmit(id, prompt, targetName, record) {
  return frame(PROTOCOL.KIND_SUBMIT, {
    id,
    page: { url: location.href, title: document.title },
    picks: loadBatch(),
    prompt,
    ...(record ? { record } : {}),
    target: { namespace: PROTOCOL.NS_LOCAL, name: targetName },
  });
}

// 与 submit 同构（page/picks/prompt/target），但 target 可省略——compose 只用
// 它渲染 follow-up 示例里的 fromTarget，没有目标也能渲染。
export function frameCompose(id, prompt, targetName, record) {
  return frame(PROTOCOL.KIND_COMPOSE, {
    id,
    page: { url: location.href, title: document.title },
    picks: loadBatch(),
    prompt,
    ...(record ? { record } : {}),
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

// Staging bag（跨页暂存）：stage 把本页一条 pick 带完整 Provenance 入袋；
// list 全量对账（重连后重建视图的唯一来源）；submit 整袋投递并清袋。
// page 携带本 tab 的 pageTabId —— broker 按它做 page-tool 定向路由。
export function frameStage(id, pick) {
  return frame(PROTOCOL.KIND_STAGE, {
    id,
    pick,
    page: { tabId: pageTabId(), origin: location.origin, url: location.href, title: document.title, ts: Date.now() },
  });
}

export function frameBagList(id) {
  return frame(PROTOCOL.KIND_BAG_LIST, { id });
}

export function frameBagSubmit(id, prompt, targetName) {
  return frame(PROTOCOL.KIND_BAG_SUBMIT, {
    id,
    prompt,
    target: { namespace: PROTOCOL.NS_LOCAL, name: targetName },
  });
}
