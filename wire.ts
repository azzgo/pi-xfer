/**
 * wire.ts — the single source of truth for the xfer broker wire protocol
 * (v0): frame type names, page-tool op names + read/write classification,
 * error codes, and the local namespace tag.
 *
 * Consumed from both sides of the wire:
 *   - broker-main.ts (node) imports the WIRE_* / ERR_* constants directly;
 *   - web-picker.src/wire.js re-exports the same object as `PROTOCOL`, and
 *     esbuild bundles it into web-picker.user.js at build time.
 *
 * Adding an op or frame type here is by construction enough — the two ends
 * can no longer drift. Wire frame shapes stay documented in docs/web-picker.md.
 */

/** Envelope version carried on every frame (v0 protocol). */
export const WIRE_VERSION = 0;

/** Frame `type` values. Every request frame gets exactly one reply. */
export const WIRE = {
  V: WIRE_VERSION,
  KIND_HELLO: "hello",
  KIND_WELCOME: "welcome",
  KIND_ACK: "ack",
  KIND_ERROR: "error",
  KIND_SUBMIT: "annotation.submit",
  KIND_COMPOSE: "annotation.compose",
  KIND_TARGETS_LIST: "targets.list",
  KIND_TARGETS_RESULT: "targets.result",
  KIND_PAGE_REQUEST: "page.request",
  KIND_PAGE_RESPONSE: "page.response",
  NS_LOCAL: "local",
} as const;

/**
 * Fixed page-tool op table — the only ops page.request{tool} may invoke.
 * Write ops require per-origin page-write authorization on the page side.
 */
export const PAGE_OPS = {
  INFO: "page.info",
  DOM_QUERY: "dom.query",
  DOM_HTML: "dom.html",
  CONSOLE_LOGS: "console.logs",
  NETWORK_LOG: "network.log",
  FRAMEWORK_INSPECT: "framework.inspect",
  DOM_CLICK: "dom.click",
  DOM_SET_VALUE: "dom.setValue",
  PAGE_WAIT: "page.wait",
} as const;

/** Read ops run whenever the broker link is up; write ops are gated per origin. */
export const PAGE_OP_KINDS = {
  [PAGE_OPS.INFO]: "read",
  [PAGE_OPS.DOM_QUERY]: "read",
  [PAGE_OPS.DOM_HTML]: "read",
  [PAGE_OPS.CONSOLE_LOGS]: "read",
  [PAGE_OPS.NETWORK_LOG]: "read",
  [PAGE_OPS.FRAMEWORK_INSPECT]: "read",
  [PAGE_OPS.DOM_CLICK]: "write",
  [PAGE_OPS.DOM_SET_VALUE]: "write",
  [PAGE_OPS.PAGE_WAIT]: "read",
} as const;

/** Structured error codes carried by error{code} frames. */
export const ERR = {
  AUTH_FAILED: "auth_failed",
  INVALID_PAYLOAD: "invalid_payload",
  BAD_TARGET: "bad_target",
  TARGET_NOT_FOUND: "target_not_found",
  DELIVERY_FAILED: "delivery_failed",
  UNSUPPORTED_VERSION: "unsupported_version",
} as const;
