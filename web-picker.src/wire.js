// Protocol constants — re-exported from the broker's shared wire module so
// the two ends of the connection can never drift. Bundled into
// web-picker.user.js by esbuild at build time.
export { WIRE as PROTOCOL, PAGE_OPS, PAGE_OP_KINDS } from '../wire.ts';
