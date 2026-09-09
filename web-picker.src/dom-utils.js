// DOM utils — selector construction and small formatting helpers.

import { MAX_DEPTH } from './constants.js';

export const cssEscape = (s) => (window.CSS && CSS.escape)
  ? CSS.escape(s)
  : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

export function cssPath(el) {
  if (el.id) return '#' + cssEscape(el.id);
  const parts = [];
  let cur = el, depth = 0;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < MAX_DEPTH) {
    let sel = cur.nodeName.toLowerCase();
    if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
    const sibs = cur.parentElement
      ? Array.from(cur.parentElement.children).filter((s) => s.nodeName === cur.nodeName)
      : [cur];
    // 同 tag 兄弟 >1 时一律补 nth-of-type——class/stable-attr 分支也要，否则
    // 同一 table 里同 class 的不同单元格会生成完全相同的选择器（互相覆盖、
    // agent 反解时也只能命中第一个）。
    const nth = sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : '';
    const stable = ['data-testid', 'data-test', 'data-component', 'data-cy', 'name']
      .find((a) => cur.getAttribute && cur.getAttribute(a));
    if (stable) {
      parts.unshift(sel + '[' + stable + '="' + cssEscape(String(cur.getAttribute(stable))) + '"]' + nth);
    } else {
      const cls = Array.from(cur.classList || []).filter((c) => c.length > 1).slice(0, 2);
      if (cls.length) {
        parts.unshift(sel + '.' + cls.map(cssEscape).join('.') + nth);
      } else {
        parts.unshift(sel + nth);
      }
    }
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' > ') || el.nodeName.toLowerCase();
}

export function xPath(el) {
  if (el.id) return '//*[@id="' + el.id + '"]';
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    let i = 1, sib = cur;
    while ((sib = sib.previousElementSibling)) { if (sib.nodeName === cur.nodeName) i++; }
    parts.unshift(cur.nodeName.toLowerCase() + '[' + i + ']');
    cur = cur.parentElement;
  }
  return '/' + parts.join('/');
}

export function nearestScrollable(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const cs = getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(cs.overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function selectorPreview(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
  return s;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
