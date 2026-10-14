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
 * Write markup into `target` (element or shadow root) the way the page's CSP
 * allows. Escalating fallbacks, none of which throw:
 *   1. plain innerHTML (no enforcement — the common case; also avoids the
 *     console noise a createPolicy attempt causes on allow-list pages like
 *     Teams, whose `trusted-types` directive rejects every name we pick)
 *   2. policy-created TrustedHTML (YouTube-style enforcement)
 *   3. DOMParser parse in a detached document, then adopt the nodes —
 *     DOMParser is not a Trusted Types sink, so this works on pages like
 *     Teams whose `trusted-types` allow-list blocks every policy name we
 *     could create AND enforces require-trusted-types-for (where fallbacks
 *     1 and 2 throw too). Safe because our templates are first-party
 *     static markup.
 *   4. textContent — degraded but visible
 */
export function setHTML(target, html) {
  if (!target) return;
  const markup = html == null ? '' : String(html);
  try {
    target.innerHTML = markup;
    return;
  } catch (e) { /* TT enforcement or sink blocked */ }
  try {
    const policy = ttPolicy();
    if (policy) {
      target.innerHTML = policy.createHTML(markup);
      return;
    }
  } catch (e) { /* enforced without a usable policy */ }
  try {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
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