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
 * Write markup into `target` (element or shadow root) the way the page's CSP
 * allows. Falls back to plain assignment, then to text, and never throws.
 */
export function setHTML(target, html) {
  if (!target) return;
  const markup = html == null ? '' : String(html);
  const policy = ttPolicy();
  try {
    target.innerHTML = policy ? policy.createHTML(markup) : markup;
  } catch (e) {
    try { target.innerHTML = markup; } catch (e2) { target.textContent = markup; }
  }
}

/** Clear an element's children without assigning markup (same as innerHTML = ''). */
export function clearHTML(target) {
  if (!target) return;
  try { target.innerHTML = ''; } catch (e) { target.textContent = ''; }
}