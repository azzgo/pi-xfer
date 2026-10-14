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
 * allows. Escalating fallbacks, none of which throw:
 *   1. plain innerHTML (no enforcement — the common case)
 *   2. Element.setHTMLUnsafe — a Sanitizer API sink, NOT a Trusted Types
 *     sink; survives pages like Teams whose trusted-types allow-list rejects
 *     every policy name we could create and where enforcement even covers
 *     DOMParser. ShadowRoot targets go through a temp container element.
 *   3. policy-created TrustedHTML (YouTube-style enforcement)
 *   4. DOMParser / implementation-document parse in a detached document
 *   5. textContent — degraded but visible
 */
/**
 * Parse markup in a detached document — not a Trusted Types sink, and not
 * reachable through a page-hardened global: `DOMParser` first, then a
 * document from `document.implementation` (neither carries the page's CSP,
 * which is exactly why sanitizer libraries parse there). Teams hardens its
 * globals enough that `new DOMParser()` can throw, hence the second route.
 */
function parseDetached(markup) {
  try {
    return new DOMParser().parseFromString(markup, 'text/html');
  } catch (e) { /* DOMParser blocked or stripped */ }
  const doc = document.implementation.createHTMLDocument('pi-xfer');
  doc.body.innerHTML = markup;
  return doc;
}

export function setHTML(target, html) {
  if (!target) return;
  const markup = html == null ? '' : String(html);
  try {
    target.innerHTML = markup;
    return;
  } catch (e) { /* TT enforcement or sink blocked */ }
  {
    const owner = target.setHTMLUnsafe === 'function'
      ? target
      : typeof document !== 'undefined' ? document.createElement('div') : null;
    try {
      if (owner === target) {
        target.setHTMLUnsafe(markup);
      } else if (owner) {
        owner.setHTMLUnsafe(markup);
        let node = owner.firstChild;
        while (node) { target.appendChild(node); node = owner.firstChild; }
      }
      if (owner) return;
    } catch (e) { /* stripped or signature-changed by the page */ }
  }
  try {
    const policy = ttPolicy();
    if (policy) {
      target.innerHTML = policy.createHTML(markup);
      return;
    }
  } catch (e) { /* enforced without a usable policy */ }
  try {
    const doc = parseDetached(markup);
    let node = doc.body.firstChild;
    while (node) { target.appendChild(node); node = doc.body.firstChild; }
    return;
  } catch (e) { /* nothing left to try */ }
  try { target.textContent = markup; } catch (e2) { /* give up silently */ }
}

/** Clear an element's children without assigning markup (same as innerHTML = ''). */
export function clearHTML(target) {
  if (!target) return;
  try { target.innerHTML = ''; } catch (e) { target.textContent = ''; }
}