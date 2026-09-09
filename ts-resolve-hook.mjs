// Resolve hook for `node --test`: relative .js specifiers fall back to .ts
// when the .js file doesn't exist — the TS extension files run via node's
// native type stripping, tests import them with .js specifiers.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith(".") || !specifier.endsWith(".js")) return next(specifier, context);
    try {
      return next(specifier, context);
    } catch (e) {
      try {
        return next(specifier.replace(/\.js$/, ".ts"), context);
      } catch {
        throw e;
      }
    }
  },
});
