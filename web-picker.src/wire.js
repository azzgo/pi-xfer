// Protocol constants — the single page-side source for frame kinds, op names
// and the namespace tag. Phase 3 makes this file re-export from the broker's
// shared wire module so broker and userscript can never drift.

export const PROTOCOL = {
  V: 0,                                          // envelope version on every frame
  KIND_HELLO: 'hello',
  KIND_WELCOME: 'welcome',
  KIND_SUBMIT: 'annotation.submit',
  KIND_COMPOSE: 'annotation.compose',
  KIND_ACK: 'ack',
  KIND_ERROR: 'error',
  KIND_TARGETS_LIST: 'targets.list',
  KIND_TARGETS_RESULT: 'targets.result',
  KIND_PAGE_REQUEST: 'page.request',
  KIND_PAGE_RESPONSE: 'page.response',
  NS_LOCAL: 'local',
};

// Fixed page-tool op table (v1.6 + v1.12 write ops) — the only ops
// page.request{tool} may invoke.
export const PAGE_OPS = {
  INFO: 'page.info',
  DOM_QUERY: 'dom.query',
  DOM_HTML: 'dom.html',
  CONSOLE_LOGS: 'console.logs',
  NETWORK_LOG: 'network.log',
  FRAMEWORK_INSPECT: 'framework.inspect',
  // v1.12 — write ops, gated by per-origin page-write authorization
  DOM_CLICK: 'dom.click',
  DOM_SET_VALUE: 'dom.setValue',
  PAGE_WAIT: 'page.wait',
};

// Read ops run whenever the broker link is up (status quo). Write ops need
// the origin to have been authorized for page writes (settings checkbox).
export const PAGE_OP_KINDS = {
  [PAGE_OPS.INFO]: 'read',
  [PAGE_OPS.DOM_QUERY]: 'read',
  [PAGE_OPS.DOM_HTML]: 'read',
  [PAGE_OPS.CONSOLE_LOGS]: 'read',
  [PAGE_OPS.NETWORK_LOG]: 'read',
  [PAGE_OPS.FRAMEWORK_INSPECT]: 'read',
  [PAGE_OPS.DOM_CLICK]: 'write',
  [PAGE_OPS.DOM_SET_VALUE]: 'write',
  [PAGE_OPS.PAGE_WAIT]: 'read',
};
