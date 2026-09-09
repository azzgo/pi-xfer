// Broker connection — the deep module behind the page↔broker WebSocket.
//
// Owns everything connection-shaped: the socket, its state machine
// (off | connecting | on), the pending-request map, the wire routing of
// inbound frames (welcome/ack/error/targets.result/page.request), and the
// request-shaped flows (submit / compose / targets). UI modules only see the
// exported interface — they never touch `ws`/`wsState` directly and react to
// state through the `onState` callback.
//
// v1.11 semantics (preserved): manual connect only, reconnect is NEVER
// automatic. Auto-link + backoff land on top of this module (v1.12).

import { GM_BROKER, DEFAULT_BROKER_URL } from './constants.js';
import {
  PROTOCOL,
  frameHello, frameSubmit, frameCompose, frameTargetsList,
} from './protocol.js';

export function createBrokerConn(deps) {
  const gm = deps.gm;
  const debugLog = deps.debugLog || (() => {});
  const toast = deps.toast || (() => {});
  const onPageRequest = deps.onPageRequest || (() => {});

  let ws = null;
  let wsState = 'off';                 // off | connecting | on
  let connectSettle = null;            // 在途 connect 的结算回调（welcome→true / close→false）
  const pending = new Map();           // request id → { kind:'submit'|'compose'|'targets', resolve }

  function brokerUrl() { return gm.get(GM_BROKER, DEFAULT_BROKER_URL); }

  function sendFrame(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function setState(s) {
    wsState = s;
    deps.onState(s);
  }

  // 返回 Promise：welcome 兑现 true；构造失败/close（含 onerror 后的必然 close）兑现 false。
  // fire-and-forget 调用方（菜单、settings 保存、API）照旧忽略返回值。
  function connect() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    const url = brokerUrl().replace(/\/+$/, '') + '/ws';
    setState('connecting');
    let settle;
    const attempt = new Promise((resolve) => { settle = resolve; });
    connectSettle = settle;
    let sock;
    try { sock = new WebSocket(url); }
    catch (e) {
      connectSettle = null;
      setState('off');
      toast('WS 创建失败: ' + e.message);
      settle(false);
      return attempt;
    }
    ws = sock;
    sock.onopen = () => { sendFrame(frameHello()); };
    sock.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (!f || typeof f.type !== 'string') return;
      if (f.type === PROTOCOL.KIND_WELCOME) {
        setState('on');
        toast('broker 已连接');
        const settled = connectSettle; connectSettle = null;
        if (settled) settled(true);
        if (deps.onWelcome) deps.onWelcome();
        return;
      }
      if (f.type === PROTOCOL.KIND_ACK) {
        const p = pending.get(f.id);
        if (p && p.kind === 'submit') { pending.delete(f.id); p.resolve({ ok: true, result: f.result }); }
        else if (p && p.kind === 'compose') {
          pending.delete(f.id);
          p.resolve({ ok: true, text: f.result && typeof f.result.prompt === 'string' ? f.result.prompt : '' });
        }
        return;
      }
      if (f.type === PROTOCOL.KIND_ERROR) {
        const p = pending.get(f.id);
        if (p) {
          pending.delete(f.id);
          p.resolve(p.kind === 'submit' ? { ok: false, code: f.code, message: f.message }
            : p.kind === 'compose' ? { ok: false, code: f.code, message: f.message } : []);
        } else {
          toast('broker 错误: ' + (f.code || '?'));
        }
        return;
      }
      if (f.type === PROTOCOL.KIND_TARGETS_RESULT) {
        const p = pending.get(f.id);
        if (p && p.kind === 'targets') { pending.delete(f.id); p.resolve(Array.isArray(f.targets) ? f.targets : []); }
        return;
      }
      if (f.type === PROTOCOL.KIND_PAGE_REQUEST) {
        debugLog('page.request', f.id, f.tool && f.tool.op);
        onPageRequest(f);
        return;
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;               // superseded by a newer connect
      ws = null;
      for (const p of pending.values()) p.resolve(p.kind === 'submit'
        ? { ok: false, code: 'closed', message: 'broker 连接已断开' }
        : []);
      pending.clear();
      const settled = connectSettle; connectSettle = null;
      if (settled) settled(false);           // 握手未完成即断开 = 配对失败
      if (wsState !== 'off') { setState('off'); toast('broker 连接已断开'); }
    };
    sock.onerror = () => {
      if (ws === sock && wsState !== 'off') {
        setState('off');
        toast('broker 连不上: ' + url + '（连接设置里可改地址）');
      }
    };
    return attempt;
  }

  function disconnect() {
    setState('off');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    toast('已断开');
  }

  // ---------- request-shaped flows ----------

  // prompt 可留空：留空时落 DEFAULT_PROMPT——逐条回应标注 note / 解释元素渲染逻辑。
  // broker 端 v0 校验要求 prompt 非空，所以默认值在这一侧补齐，线上帧始终带具体指令。
  const DEFAULT_PROMPT = '请逐条回应本页标注：note 写了要求的按 note 处理；没写 note 的，请解释该元素的渲染逻辑（组件与样式来源）。';
  // 反向查询规则随每次 send 下发（prompt 尾部追加）：HMR 改代码失败会整页刷新，
  // 刷新即断开 userscript ↔ broker 连接，此后的 page.request 全部无人应答。
  const PAGE_QUERY_RULE = '\n\n[页面查询规则] 反向查询本页（page.request：dom.query / dom.html / framework.inspect 等）只能在开始修改代码之前进行；需要 DOM、样式、组件链信息时请在动第一行代码前一次性查完。一旦开始改代码，HMR 无法热更新时浏览器会整页刷新，userscript 与 broker 的连接会随刷新断开，此后的 page.request 不会再有响应，不要浪费尝试。';

  function submitToAgent(prompt, targetName) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'submit', resolve });
      const promptText = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT) + PAGE_QUERY_RULE;
      if (!sendFrame(frameSubmit(id, promptText, targetName))) {
        pending.delete(id);
        resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout', message: 'broker 无响应' }); }
      }, 10000);
    });
  }

  // compose flow（v1.10）：broker 拼完整 handoff 文档 → 剪贴板。
  // prompt 组装与 submit 完全一致（留空落 DEFAULT_PROMPT + PAGE_QUERY_RULE），
  // broker 侧用同一个 renderHandoffDoc 渲染，但不落盘不投递——只是把最终发给
  // agent 的完整 prompt 交还给页面。
  function requestCompose(prompt, targetName) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'compose', resolve });
      const promptText = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT) + PAGE_QUERY_RULE;
      if (!sendFrame(frameCompose(id, promptText, targetName))) {
        pending.delete(id);
        resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' });
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout', message: 'broker 无响应' }); }
      }, 10000);
    });
  }

  function requestTargets() {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve([]); return; }
      const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'targets', resolve });
      if (!sendFrame(frameTargetsList(id))) { pending.delete(id); resolve([]); return; }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve([]); }
      }, 5000);
    });
  }

  return {
    brokerUrl,
    connect,
    disconnect,
    sendFrame,
    getState: () => wsState,
    submitToAgent,
    requestCompose,
    requestTargets,
  };
}
