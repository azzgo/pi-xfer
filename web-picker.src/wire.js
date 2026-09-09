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

// Fixed page-tool op table (v1.6) — the only ops page.request{tool} may invoke.
export const PAGE_OPS = {
  INFO: 'page.info',
  DOM_QUERY: 'dom.query',
  DOM_HTML: 'dom.html',
  CONSOLE_LOGS: 'console.logs',
  NETWORK_LOG: 'network.log',
  FRAMEWORK_INSPECT: 'framework.inspect',
};
