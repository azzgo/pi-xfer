// Resolve/load hooks for `node --test` AND the spawned daemons
// (daemon/broker-main.ts / daemon/admin-main.ts / mesh CLI): relative .js specifiers fall
// back to .ts when the .js file doesn't exist, and .ts sources are stripped
// here via node:module's stripTypeScriptTypes instead of node's built-in
// stripping — the built-in refuses every file under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly where an
// npm-installed extension lives (~/.pi/agent/npm/node_modules/pi-xfer).
// No enums/namespaces/param-properties are used, so plain `strip` mode is
// enough; type-only imports are elided, so no module resolution happens
// post-strip.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    let source;
    try {
      source = readFileSync(fileURLToPath(url), "utf8");
    } catch {
      return next(url, context);
    }
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { sourceUrl: url }),
      shortCircuit: true,
    };
  },
});
