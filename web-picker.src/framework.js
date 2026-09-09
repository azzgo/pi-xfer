// Framework source extraction (React/Vue dev builds) — sandbox first,
// unsafeWindow fallback.

import { cssPath } from './dom-utils.js';

export function reactSource(el) {
  const keys = Object.getOwnPropertyNames(el);
  for (const k of keys) {
    if (!k.startsWith('__reactFiber$') && !k.startsWith('__reactInternalInstance$')) continue;
    let f = el[k], guard = 0;
    while (f && guard++ < 200) {
      const t = f.type;
      const src = f._debugSource;
      if (t && (t.name || t.displayName) && src && src.fileName) {
        return { framework: 'react', component: t.displayName || t.name || '', file: src.fileName, line: src.lineNumber || 0, column: src.columnNumber || 0 };
      }
      f = f.return;
    }
  }
  return null;
}

export function vueSource(el) {
  let vm = el.__vueParentComponent || el.__vue__ || null;
  let guard = 0;
  while (vm && guard++ < 200) {
    const opts = vm.$options || {};
    if (opts.__file) {
      const name = (vm.type && (vm.type.name || vm.type.__name)) || opts.name || opts.__name || '';
      return { framework: 'vue', component: name, file: opts.__file, line: 0, column: 0 };
    }
    vm = vm.$parent || null;
  }
  return null;
}

// Page-realm expandos are invisible from the userscript sandbox (isolated world).
// Fallback: re-resolve the element through unsafeWindow's document, then walk there.
export function sourceInfo(el) {
  const direct = reactSource(el) || vueSource(el);
  if (direct) return direct;
  try {
    const uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : null;
    if (!uw || !uw.document) return null;
    const sel = cssPath(el);
    const pageEl = uw.document.querySelector(sel);
    if (!pageEl || pageEl === el) return null; // same object → same realm, no point
    return reactSource(pageEl) || vueSource(pageEl);
  } catch (e) { return null; }
}
