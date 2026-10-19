/** Wrangler resolves `*.wasm` to a `WebAssembly.Module` and inlines it; only the type is missing. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
