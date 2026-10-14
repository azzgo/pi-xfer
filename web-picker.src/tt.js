// Trusted Types shim — the only sanctioned way this userscript writes markup.
//
// YouTube serves `require-trusted-types-for 'script'`, where a bare
// `el.innerHTML = "…"` throws ("This document requires 'TrustedHTML'") and
// takes the whole injection down with it. A `trustedTypes` policy turns the
// same string back into an acceptable TrustedHTML value.
//
// Everything here is feature-detected and defensive: the API is missing on
// older browsers, the policy name may already be taken (createPolicy throws —
// then we simply fall back to plain assignment), and even the guarded path is
// wrapped so a future enforcement mode degrades to text instead of dying
// mid-render. Never assume a policy exists.

const POLICY_NAME = 'pi-xfer';

let cached;   // undefined = not probed yet, null = unusable, object = policy
let enforced = false;      // a plain innerHTML write was blocked — skip rung 1 next time
let detachedBroken = false; // detached-document parsing (DOMParser etc.) threw on this page

function ttPolicy() {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const tt = window.trustedTypes;
    if (tt && typeof tt.createPolicy === 'function') {
      cached = tt.createPolicy(POLICY_NAME, { createHTML: (s) => s });
    }
  } catch (e) {
    cached = null;   // name taken, no createHTML hook, or a stricter policy mode
  }
  return cached;
}

/** True when a Trusted Types policy is available for markup writes. */
export function ttEnabled() {
  return ttPolicy() !== null;
}

/**
/**
 * Parse markup in a detached document — not a Trusted Types sink, and not
 * reachable through a page-hardened global: `DOMParser` first, then a
 * document from `document.implementation` (neither carries the page's CSP,
 * which is exactly why sanitizer libraries parse there).
 */
function parseDetached(markup) {
  try {
    return new DOMParser().parseFromString(markup, 'text/html');
  } catch (e) { /* DOMParser blocked or stripped */ }
  const doc = document.implementation.createHTMLDocument('pi-xfer');
  doc.body.innerHTML = markup;
  return doc;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TAGS = new Set(['style', 'script']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb' };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = (body[1] === 'x' || body[1] === 'X')
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

/**
 * Minimal HTML fragment parser — the last markup rung before textContent.
 * Touches only createElement / createElementNS / createTextNode, so it is
 * immune to Trusted Types enforcement no matter how far a page extends it.
 * Deliberately tolerant: this renders OUR first-party static templates, so
 * recovery from malformed input is best-effort, never a throw.
 */
function miniParse(markup) {
  const frag = document.createDocumentFragment();
  const stack = [{ tag: null, el: frag, ns: null }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const len = markup.length;
  const addText = (raw) => {
    if (raw) top().el.appendChild(document.createTextNode(decodeEntities(raw)));
  };
  while (i < len) {
    const lt = markup.indexOf('<', i);
    if (lt === -1) { addText(markup.slice(i)); break; }
    addText(markup.slice(i, lt));
    if (markup.startsWith('<!--', lt)) {
      const end = markup.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (markup.startsWith('</', lt)) {
      const gt = markup.indexOf('>', lt + 2);
      const name = markup.slice(lt + 2, gt === -1 ? len : gt).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      i = gt === -1 ? len : gt + 1;
      continue;
    }
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(markup.slice(lt + 1));
    if (!nameMatch) { addText('<'); i = lt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    let j = lt + 1 + nameMatch[1].length;
    const attrs = [];
    let gt = -1;
    let selfClose = false;
    while (j < len) {
      while (j < len && /\s/.test(markup[j])) j++;
      if (markup[j] === '>') { gt = j; break; }
      if (markup[j] === '/' && markup[j + 1] === '>') { gt = j + 1; selfClose = true; break; }
      const nameMatch2 = /^[^\s=/>]+/.exec(markup.slice(j));
      if (!nameMatch2) { j++; continue; }
      const attrName = nameMatch2[0];
      j += attrName.length;
      let value = '';
      while (j < len && /\s/.test(markup[j])) j++;
      if (markup[j] === '=') {
        j++;
        while (j < len && /\s/.test(markup[j])) j++;
        const q = markup[j];
        if (q === '"' || q === "'") {
          const end = markup.indexOf(q, j + 1);
          value = markup.slice(j + 1, end === -1 ? len : end);
          j = end === -1 ? len : end + 1;
        } else {
          const vm = /^[^\s>]+/.exec(markup.slice(j));
          value = vm ? vm[0] : '';
          j += value.length;
        }
      }
      attrs.push([attrName, value]);
    }
    i = gt === -1 ? len : gt + 1;
    const parent = top();
    const ns = parent.ns || (tag === 'svg' ? SVG_NS : null);
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [n, v] of attrs) el.setAttribute(n, decodeEntities(v));
    parent.el.appendChild(el);
    if (RAW_TAGS.has(tag)) {
      const lower = markup.toLowerCase();
      const close = lower.indexOf('</' + tag, i);
      const raw = markup.slice(i, close === -1 ? len : close);
      if (raw) el.appendChild(document.createTextNode(raw));
      const closeGt = markup.indexOf('>', i + raw.length);
      i = closeGt === -1 ? len : closeGt + 1;
      continue;
    }
    if (!selfClose && !VOID_TAGS.has(tag)) {
      stack.push({ tag, el, ns });
    }
  }
  return frag;
}

/**
 * Write markup into `target` (element or shadow root) the way the page's CSP
 * allows. Escalating fallbacks, none of which throw:
 *   1. plain innerHTML (no enforcement — the common case)
 *   2. policy-created TrustedHTML (YouTube-style enforcement)
 *   3. DOMParser / implementation-document parse in a detached document
 *   4. miniParse — a built-in HTML fragment parser that only touches
 *     createElementNS/createTextNode, so it works on ANY page, including
 *     ones like Teams where trusted-types enforcement blocks innerHTML,
 *     every createPolicy name, AND (non-standard) DOMParser and
 *     implementation-document innerHTML. Verified live: there the whole
 *     platform-parser ladder throws and only this rung survives.
 *   5. textContent — degraded but visible
 *
 * Once a rung proves the page enforces TT, the result is cached
 * (`enforced` / `detachedBroken`), so later writes skip the noisy probes
 * instead of logging a console violation per render.
 */
export function setHTML(target, html) {
  if (!target) return;
  const markup = html == null ? '' : String(html);
  if (!enforced) {
    try {
      target.innerHTML = markup;
      return;
    } catch (e) { enforced = true; }
  }
  try {
    const policy = ttPolicy();
    if (policy) {
      target.innerHTML = policy.createHTML(markup);
      return;
    }
  } catch (e) { /* enforced without a usable policy */ }
  if (!detachedBroken && typeof DOMParser === 'function') {
    try {
      const doc = parseDetached(markup);
      let node = doc.body.firstChild;
      while (node) { target.appendChild(node); node = doc.body.firstChild; }
      return;
    } catch (e) { detachedBroken = true; }
  }
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const frag = miniParse(markup);
      let node = frag.firstChild;
      while (node) { target.appendChild(node); node = frag.firstChild; }
      return;
    }
  } catch (e) { /* nothing left to try */ }
  try { target.textContent = markup; } catch (e2) { /* give up silently */ }
}

/** Clear an element's children without assigning markup (same as innerHTML = ''). */
export function clearHTML(target) {
  if (!target) return;
  try { target.innerHTML = ''; } catch (e) { target.textContent = ''; }
}