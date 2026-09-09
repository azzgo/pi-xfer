// Page tools — page.request{tool:{op,params}} → fixed read-only op → page.response.
// No human modal, no free-form eval: the op table below is the entire attack
// surface, all handlers are read-only, and every result passes through
// jsonSafe (depth/string/array caps) so JSON.stringify can never throw or
// blow the 1MB broker frame budget on its own.
//
// Handlers receive an injected environment (`env`) instead of reaching for
// module globals — that seam is what makes the op table testable in node and
// what the per-origin authorization gate (v1.12) dispatches through.

import { DEFAULT_STYLE_PROPS, RESULT_MAX_CHARS, GM_FPROPS, HOST_FLAG } from './constants.js';
import { PAGE_OPS, PAGE_OP_KINDS } from './wire.js';
import { jsonSafe } from './json-safe.js';
import { cssPath, xPath } from './dom-utils.js';
import { consoleRing, netRing } from './capture.js';

// Per-origin page-write authorization key (GM storage). Mirrors auto-link:
// off by default, explicitly enabled per origin in the settings modal.
export function writeOpsKey(origin) { return 'wp.writeOps.' + origin; }

export function createPageTools(env) {
  const e = env || {};
  const gm = e.gm;
  const doc = e.doc || document;
  const rings = { consoleRing: e.consoleRing || consoleRing, netRing: e.netRing || netRing };

  function writeAllowed() { return !!(gm && gm.get(writeOpsKey(location.origin), false) === true); }

  // Agent 驱动的点击/填值绝不能落在 picker 自己的浮层上：host 挂在 light DOM，
  // document.querySelector 就能选中它，命中即拒。
  function findOutside(selector) {
    if (typeof selector !== 'string' || !selector) throw new Error('params.selector (CSS) is required');
    const el = doc.querySelector(selector);
    if (!el) return null;
    if (el.closest && el.closest('[' + HOST_FLAG + ']')) {
      throw new Error('refused: target is the picker overlay itself');
    }
    return el;
  }

  function toolPageInfo() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      scroll: { x: window.scrollX, y: window.scrollY },
      ua: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled,
      ts: Date.now(),
    };
  }

  function elToolInfo(el, styleProps) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of styleProps) style[p] = cs.getPropertyValue(p);
    const attributes = {};
    for (const a of el.attributes) attributes[a.name] = a.value;
    return {
      selector: cssPath(el),
      xpath: xPath(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: Array.from(el.classList || []),
      attributes,
      textPreview: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none',
      style,
    };
  }

  function toolDomQuery(params) {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) throw new Error('dom.query: params.selector (CSS) is required');
    const maxCount = Math.min(50, Math.max(1, Number(params.maxCount) || 10));
    const styleProps = Array.isArray(params.styleProps) && params.styleProps.length
      ? params.styleProps.filter((s) => typeof s === 'string').slice(0, 30)
      : DEFAULT_STYLE_PROPS;
    const all = doc.querySelectorAll(selector);   // invalid selector throws → surfaced as the response error
    const nodes = Array.from(all).slice(0, maxCount);
    return {
      selector,
      matched: all.length,
      returned: nodes.length,
      elements: nodes.map((el) => elToolInfo(el, styleProps)),
    };
  }

  // Pruned outerHTML: depth-capped clone so full-page dumps stay bounded.
  function pruneClone(el, depth) {
    const clone = el.cloneNode(false);
    if (depth > 1) {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) {
          const t = (child.textContent || '').trim();
          if (t) clone.appendChild(doc.createTextNode(t.slice(0, 80) + ' '));
        } else if (child.nodeType === 1) {
          clone.appendChild(pruneClone(child, depth - 1));
        }
      }
    } else if (el.childNodes && el.childNodes.length) {
      clone.appendChild(doc.createTextNode('…'));
    }
    return clone;
  }

  function toolDomHtml(params) {
    const selector = typeof params.selector === 'string' ? params.selector : 'body';
    const maxLength = Math.min(200000, Math.max(200, Number(params.maxLength) || 20000));
    const maxDepth = Math.max(1, Math.min(20, Number(params.maxDepth) || 8));
    const target = doc.querySelector(selector);
    if (!target) throw new Error('dom.html: no element matches ' + selector);
    let html = pruneClone(target, maxDepth).outerHTML;
    let truncated = false;
    if (html.length > maxLength) { html = html.slice(0, maxLength); truncated = true; }
    return { selector, maxDepth, length: html.length, truncated, html };
  }

  function toolConsoleLogs(params) {
    const lastN = Math.min(500, Math.max(1, Number(params.lastN) || 50));
    const sinceTs = typeof params.sinceTs === 'number' ? params.sinceTs : 0;
    const level = typeof params.level === 'string' ? params.level : null;
    const all = rings.consoleRing.filter((en) => en.ts >= sinceTs && (!level || en.level === level));
    return { total: all.length, returned: Math.min(lastN, all.length), entries: all.slice(-lastN) };
  }

  function toolNetworkLog(params) {
    const lastN = Math.min(500, Math.max(1, Number(params.lastN) || 50));
    const filter = typeof params.urlFilter === 'string' ? params.urlFilter.toLowerCase() : null;
    const all = rings.netRing.filter((en) => !filter || en.url.toLowerCase().includes(filter));
    return { total: all.length, returned: Math.min(lastN, all.length), entries: all.slice(-lastN) };
  }

  // Component chains live in the page realm — re-resolve through unsafeWindow
  // when the sandbox element hides the expandos (same fallback as sourceInfo).
  function chainTargetEl(el) {
    try {
      const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
      if (!uw || !uw.document) return el;
      const pageEl = uw.document.querySelector(cssPath(el));
      return pageEl || el;
    } catch (err) { return el; }
  }
  function reactChain(el, maxDepth, withProps) {
    const chain = [];
    try {
      for (const k of Object.getOwnPropertyNames(el)) {
        if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactInternalInstance$')) continue;
        let f = el[k], guard = 0;
        while (f && guard++ < 200 && chain.length < maxDepth) {
          const t = f.type;
          if (t && (t.name || t.displayName)) {
            const src = f._debugSource;
            const level = { component: t.displayName || t.name || '' };
            if (src && src.fileName) { level.file = src.fileName; level.line = src.lineNumber || 0; }
            if (withProps && f.memoizedProps !== undefined) level.props = f.memoizedProps;
            chain.push(level);
          }
          f = f.return;
        }
        if (chain.length) break;
      }
    } catch (err) { /* fiber unwrapping is best-effort */ }
    return chain;
  }
  function vueChain(el, maxDepth, withProps) {
    const chain = [];
    try {
      let vm = el.__vueParentComponent || el.__vue__ || null, guard = 0;
      while (vm && guard++ < 200 && chain.length < maxDepth) {
        const opts = vm.$options || {};
        const name = (vm.type && (vm.type.name || vm.type.__name)) || opts.name || opts.__name || '';
        if (opts.__file || name) {
          const level = { component: name };
          if (opts.__file) level.file = opts.__file;
          if (withProps && vm.$props !== undefined) level.props = vm.$props;
          chain.push(level);
        }
        vm = vm.$parent || null;
      }
    } catch (err) { /* vm walking is best-effort */ }
    return chain;
  }
  function toolFrameworkInspect(params) {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) throw new Error('framework.inspect: params.selector (CSS) is required');
    const el = doc.querySelector(selector);
    if (!el) throw new Error('framework.inspect: no element matches ' + selector);
    const maxDepth = Math.max(1, Math.min(10, Number(params.maxDepth) || 5));
    const withProps = params.props !== undefined ? !!params.props : (gm ? gm.get(GM_FPROPS, false) === true : false);
    const target = chainTargetEl(el);
    let chain = reactChain(target, maxDepth, withProps);
    let framework = chain.length ? 'react' : null;
    if (!chain.length) {
      chain = vueChain(target, maxDepth, withProps);
      framework = chain.length ? 'vue' : null;
    }
    return { selector, framework, withProps, depth: chain.length, chain };
  }

  // ---------- write ops (v1.12, gated by per-origin authorization) ----------

  // 派发完整的 pointer/mouse 序列再补原生 click()：React onClick / 原生按钮 /
  // 框架代理监听都能命中，不依赖具体框架。
  function toolDomClick(params) {
    const el = findOutside(params.selector);
    if (!el) throw new Error('dom.click: no element matches ' + params.selector);
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, opts)); }
      catch (err) { el.dispatchEvent(new MouseEvent(type, opts)); }
    }
    el.click();
    return { selector: cssPath(el), clicked: true, tagName: el.tagName.toLowerCase(), disabled: !!el.disabled };
  }

  // React 受控组件兼容：走 native setter（绕过 React 对 value 的 own-property
  // 检测）再派发 input/change，组件状态才会真正更新。
  function toolDomSetValue(params) {
    const el = findOutside(params.selector);
    if (!el) throw new Error('dom.setValue: no element matches ' + params.selector);
    if (!('value' in el)) throw new Error('dom.setValue: element has no value property (' + el.tagName.toLowerCase() + ')');
    const value = params.value === undefined || params.value === null ? '' : String(params.value);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selector: cssPath(el), value, tagName: el.tagName.toLowerCase() };
  }

  // 等元素出现（agent 改完代码后验证渲染的最常用原语）。同步快路径：已存在立
  // 即返回；不存在则报错，由 agent 侧按重试节奏再查（page.response 是同步应答，
  // 页面侧不做长轮询）。
  function toolPageWait(params) {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) throw new Error('page.wait: params.selector (CSS) is required');
    if (doc.querySelector(selector)) return { selector, found: true, waitedMs: 0 };
    throw new Error('page.wait: no element matches ' + selector + ' yet — retry shortly (e.g. every 1-2s, ≤ retry budget)');
  }

  const PAGE_TOOLS = {
    [PAGE_OPS.INFO]: toolPageInfo,
    [PAGE_OPS.DOM_QUERY]: toolDomQuery,
    [PAGE_OPS.DOM_HTML]: toolDomHtml,
    [PAGE_OPS.CONSOLE_LOGS]: toolConsoleLogs,
    [PAGE_OPS.NETWORK_LOG]: toolNetworkLog,
    [PAGE_OPS.FRAMEWORK_INSPECT]: toolFrameworkInspect,
    [PAGE_OPS.DOM_CLICK]: toolDomClick,
    [PAGE_OPS.DOM_SET_VALUE]: toolDomSetValue,
    [PAGE_OPS.PAGE_WAIT]: toolPageWait,
  };

  // page.request{tool:{op,params}} → authorization gate → fixed op → exactly
  // one page.response. `send` is injected by the caller (the broker connection
  // owns the wire).
  function handlePageToolRequest(f, send) {
    const tool = f.tool && typeof f.tool === 'object' && !Array.isArray(f.tool) ? f.tool : null;
    if (!tool || typeof tool.op !== 'string') {
      send(f.id, false, 'invalid_tool: missing tool.op');
      return;
    }
    const handler = PAGE_TOOLS[tool.op];
    if (!handler) {
      send(f.id, false, 'unknown_op: ' + tool.op + ' (available: ' + Object.keys(PAGE_TOOLS).join(', ') + ')');
      return;
    }
    // Per-origin gate: write ops require explicit page-write authorization
    // (settings modal checkbox → GM wp.writeOps.<origin>); read ops stay open.
    if (PAGE_OP_KINDS[tool.op] === 'write' && !writeAllowed()) {
      send(f.id, false, 'denied_op: ' + tool.op + ' requires page-write authorization for ' + location.origin + ' (enable it in the picker settings modal)');
      return;
    }
    let text;
    try {
      const params = tool.params && typeof tool.params === 'object' && !Array.isArray(tool.params) ? tool.params : {};
      text = jsonSafe(handler(params)).text;
    } catch (err) {
      send(f.id, false, err && err.message ? String(err.message) : String(err));
      return;
    }
    if (text.length > RESULT_MAX_CHARS) { send(f.id, false, 'result_too_large'); return; }
    send(f.id, true, text);
  }

  return { PAGE_TOOLS, handlePageToolRequest, writeAllowed };
}
