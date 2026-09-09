// Broker connection — the deep module behind the page↔broker WebSocket.
//
// Owns everything connection-shaped: the socket, its state machine
// (off | connecting | on), the pending-request map, the wire routing of
// inbound frames (welcome/ack/error/targets.result/page.request), and the
// request-shaped flows (submit / compose / targets). UI modules only see the
// exported interface — they never touch `ws`/`wsState` directly and react to
// state through the `onState` callback.
//
// Auto-link (v1.12): the first MANUAL successful connect writes a per-origin
// authorization (`wp.autoLink.<origin>` in GM storage) — the user has linked
// this origin once, so reloads/HMR full refreshes may reconnect on their own.
// Auto attempts are silent (no toast) and back off 1s/4s/16s… capped at 60s;
// a manual `disconnect()` cancels the loop for this page load (the
// authorization itself is revoked only via settings/menu).

import { GM_BROKER, DEFAULT_BROKER_URL } from './constants.js';
import {
  PROTOCOL,
  frameHello, frameSubmit, frameCompose, frameTargetsList,
} from './protocol.js';

// 指数退避序列（ms）：1s → 4s → 16s → 60s（封顶）
const BACKOFF_STEPS = [1000, 4000, 16000];
const BACKOFF_CAP = 60000;

export function autoLinkKey(origin) { return 'wp.autoLink.' + origin; }

export function createBrokerConn(deps) {
  const gm = deps.gm;
  const debugLog = deps.debugLog || (() => {});
  const toast = deps.toast || (() => {});
  const onPageRequest = deps.onPageRequest || (() => {});

  let ws = null;
  let wsState = 'off';                 // off | connecting | on
  let connectSettle = null;            // 在途 connect 的结算回调（welcome→true / close→false）
  const pending = new Map();           // request id → { kind:'submit'|'compose'|'targets', resolve }

  // auto-link state：silent=自动重连中（抑制 toast）；backoffTimer/backoffStep=
  // 退避循环；manualDown=用户本页主动断开（取消自动重连，直到下次加载）。
  let silent = false;
  let manualDown = false;
  let backoffTimer = null;
  let backoffStep = 0;

  function autoLinkAllowed() { return gm.get(autoLinkKey(location.origin), false) === true; }

  function clearBackoff() {
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    backoffStep = 0;
  }

  function scheduleReconnect() {
    if (manualDown || !autoLinkAllowed() || backoffTimer) return;
    const delay = backoffStep < BACKOFF_STEPS.length ? BACKOFF_STEPS[backoffStep] : BACKOFF_CAP;
    backoffStep++;
    debugLog('auto-link: reconnect in', delay, 'ms');
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (manualDown || wsState !== 'off') return;
      silent = true;
      connect();
    }, delay);
  }

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
    clearBackoff();
    manualDown = false;
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
      if (!silent) toast('WS 创建失败: ' + e.message);
      settle(false);
      if (silent) { silent = false; scheduleReconnect(); }
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
        // 首次手动连接成功 = 用户已在本 origin 授权自动 link；此后 reload/HMR
        // 整页刷新都会静默自动重连（撤销走设置弹窗 / GM 菜单）。
        if (!silent) gm.set(autoLinkKey(location.origin), true);
        clearBackoff();
        const wasSilent = silent; silent = false;
        if (!wasSilent) toast('broker 已连接');
        debugLog('auto-link: connected', wasSilent ? '(auto)' : '(manual)');
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
      const wasSilent = silent; silent = false;
      if (wsState !== 'off') { setState('off'); }
      if (wasSilent) {
        debugLog('auto-link: attempt failed');
        scheduleReconnect();                 // 自动尝试失败 → 继续退避，不弹 toast
      } else if (wsState === 'off') {
        // 手动连接断开：若本 origin 已授权 auto-link（HMR 整页刷新之外的情
        // 况，如 broker 重启），同样进入退避重连；否则保持旧行为提示用户。
        if (autoLinkAllowed() && !manualDown) {
          scheduleReconnect();
        } else {
          toast('broker 连接已断开');
        }
      }
    };
    sock.onerror = () => {
      if (ws === sock && wsState !== 'off') {
        setState('off');
        if (!silent) toast('broker 连不上: ' + url + '（连接设置里可改地址）');
      }
    };
    return attempt;
  }

  function disconnect() {
    manualDown = true;                     // 本页加载内不再自动重连（授权仍在，reload 后恢复）
    clearBackoff();
    silent = false;
    setState('off');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    toast('已断开');
  }

  // 页面加载（含 HMR 整页刷新后的重新注入）时调用：本 origin 已授权且上一次
  // 连接不是被用户手动断开的，才静默自动重连。manualDown 不入 GM storage——
  // 「断开」只作用于当前页面生命周期。
  function maybeAutoConnect() {
    if (!autoLinkAllowed() || manualDown) return false;
    silent = true;
    connect();
    return true;
  }

  function revokeAutoLink() {
    gm.set(autoLinkKey(location.origin), false);
  }

  // ---------- request-shaped flows ----------

  // prompt 可留空：留空时落 DEFAULT_PROMPT——逐条回应标注 note / 解释元素渲染逻辑。
  // broker 端 v0 校验要求 prompt 非空，所以默认值在这一侧补齐，线上帧始终带具体指令。
  const DEFAULT_PROMPT = '请逐条回应本页标注：note 写了要求的按 note 处理；没写 note 的，请解释该元素的渲染逻辑（组件与样式来源）。';
  // 反向查询规则随每次 send 下发（prompt 尾部追加）：v1.12 起，用户手动连过
  // broker 的域名会在刷新后自动重连，所以改代码 → 页面刷新 → 重连后 agent 可以
  // 重新查询验证结果；只在 auto-link 未授权的页面才维持「改代码前一次查完」。
  const PAGE_QUERY_RULE = '\n\n[页面查询规则] 反向查询本页（page.request：dom.query / dom.html / console.logs / framework.inspect / page.wait 等）随时可用：本页已授权 broker 自动重连，修改代码导致页面刷新后，连接会自动恢复（重连期间 page.request 可能短暂返回 no_tabs/timeout，等几秒重试即可，重试上限 3 次）。完成修改后请主动反向查询验证：dom.query 复查目标元素的最终状态，console.logs 检查是否引入新报错。若错误信息表明页面写操作已授权，可用 dom.click / dom.setValue 做交互式验证（如点击按钮、填写表单后复查状态）；返回 denied_op 则不要重试写操作。';

  // record (v1.13)：可选的 Record-mode 时间线，随帧带出（加性字段，旧 broker 忽略）。
  function submitToAgent(prompt, targetName, record) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'submit', resolve });
      const promptText = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT) + PAGE_QUERY_RULE;
      if (!sendFrame(frameSubmit(id, promptText, targetName, record))) {
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
  function requestCompose(prompt, targetName, record) {
    return new Promise((resolve) => {
      if (wsState !== 'on') { resolve({ ok: false, code: 'not_connected', message: 'broker 未连接' }); return; }
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      pending.set(id, { kind: 'compose', resolve });
      const promptText = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT) + PAGE_QUERY_RULE;
      if (!sendFrame(frameCompose(id, promptText, targetName, record))) {
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
    autoLinkAllowed,
    revokeAutoLink,
    maybeAutoConnect,
    submitToAgent,
    requestCompose,
    requestTargets,
  };
}
