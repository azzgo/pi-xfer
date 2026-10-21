// Build script, four committed artifacts (web-picker 双轨模式):
//
// 1. web-picker.user.js — esbuild IIFE bundle of web-picker.src/ with the
//    userscript metadata banner. Tampermonkey installs it straight from the
//    raw GitHub URL, so `npm run build && git add` is part of every change.
// 2. mesh-runtime.cjs — esbuild CJS bundle of mesh-runtime.src/ + rivetkit.
//    This is what `/xfer mesh up` runs; the extension itself has zero runtime
//    deps (the rivetkit native addon is downloaded on first `mesh up` into
//    ~/.pi/xfer/cache). Building requires rivetkit in node_modules; when
//    missing it is installed --no-save at the version pinned in
//    mesh-native.ts (RIVETKIT_VERSION) so bundle and download pin never drift.
// 3. broker.cjs / 4. admin.cjs — esbuild CJS bundles of the two daemons the
//    managers spawn. Bundling them drops the daemon's dependency on node's
//    experimental type stripping AND on a node_modules resolvable from the
//    caller's project (see docs/milestones/phase2-design-p0b.md).
//
// Every builder is exported so artifact-freshness.test.ts can rebuild to a
// temp file and assert the committed artifact is byte-identical (漏提交防线).
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// rivetkit's napi-runtime.ts deliberately keeps its native-addon specifier
// computed so bundlers never capture the .node file; esbuild therefore emits a
// real ESM import() that cannot resolve without node_modules. Rewrite it to a
// loader we control: mesh-native.ts downloads the addon to ~/.pi/xfer/cache,
// sets globalThis.__meshNapiBindingsPath, and the banner-defined loader
// require()s it. (A Module._load shim is not enough — this stays a real
// dynamic import in the CJS output.)
/** @type {import('esbuild').Plugin} */
const napiRuntimeRewrite = {
  name: 'mesh-napi-runtime-rewrite',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/].*\.[cm]?js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8');
      let rewritten = false;
      const targets = [
        ['import(["@rivetkit", "rivetkit-napi"].join("/"))', '__meshLoadNapiBindings'],
        ['import(["@rivetkit", "engine-cli"].join("/"))', '__meshLoadEngineCli'],
      ];
      for (const [source, globalName] of targets) {
        if (contents.includes(source)) {
          contents = contents.replaceAll(source, `globalThis.${globalName}()`);
          rewritten = true;
        }
      }
      if (!rewritten) return undefined;
      return { contents, loader: 'js' };
    });
  },
};

const meshRuntimeBanner = `
globalThis.__meshLoadNapiBindings = async () => {
  const bindingsPath = globalThis.__meshNapiBindingsPath;
  if (typeof bindingsPath !== "string") {
    throw new Error("mesh: native runtime not prepared — /xfer mesh up must download the rivetkit addon first");
  }
  return require(bindingsPath);
};
globalThis.__meshLoadEngineCli = async () => {
  const entryPath = globalThis.__meshEngineCliEntry;
  if (typeof entryPath !== "string") {
    throw new Error("mesh: engine-cli not prepared — /xfer mesh up must download the rivetkit runtime first");
  }
  return require(entryPath);
};
`;

/**
 * Install + pin-verify rivetkit and its floating transitives for a bundle build.
 *
 * rivetkit is not a runtime dep (downloaded on first `mesh up`). Its floating
 * transitives (zod ^4.1.0, p-retry ^6.2.1) silently change the bundle — new
 * exports, version stamps, even hoisting layout — so they are pinned at top
 * level too. npm prunes previously --no-save packages on every install, so all
 * specs always go into a single install call.
 */
function ensureRivetkitDeps() {
  const versionPin = readFileSync(join(here, 'mesh-native.ts'), 'utf8')
    .match(/RIVETKIT_VERSION = "([^"]+)"/)?.[1];
  if (!versionPin) throw new Error('cannot read RIVETKIT_VERSION from mesh-native.ts');

  // Every rivetkit transitive that reaches the bundle must be pinned: a
  // floating one (^1.1.0 on @opentelemetry/api) resolves to a newer version at
  // build time than the one the committed bundle was made with, and the
  // freshness guard then fails on CI with a "stale" claim no local rebuild
  // reproduces. Pin what the bundle actually contains.
  const pins = { rivetkit: versionPin, zod: '4.6.5', 'p-retry': '6.2.1', 'cbor-x': '1.6.7', '@opentelemetry/api': '1.10.0' };
  const pkgVersion = (name) => {
    const pkg = join(here, `node_modules/${name}/package.json`);
    return existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version : null;
  };
  const specs = Object.entries(pins).map(([name, pin]) => `${name}@${pin}`);
  if (Object.entries(pins).some(([name, pin]) => pkgVersion(name) !== pin)) {
    console.log(`installing ${specs.join(' ')} --no-save for the bundle build (not runtime deps)...`);
    const result = spawnSync('npm', ['install', '--no-save', ...specs], { cwd: here, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`failed to install ${specs.join(' ')} for the bundle build`);
  }
  for (const [name, pin] of Object.entries(pins)) {
    const version = pkgVersion(name);
    if (version !== pin) throw new Error(`${name} ${version} in node_modules != pinned ${pin} — align before building`);
  }
}

/** esbuild a rivetkit-bearing CJS bundle (mesh runtime / adapter daemon). */
async function buildRivetBundle(entry, outfile) {
  ensureRivetkitDeps();
  await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    banner: { js: meshRuntimeBanner + importMetaBanner },
    define: {
      'import.meta.url': '__xferImportMetaUrl',
      'import.meta.dirname': '__dirname',
      'import.meta.filename': '__filename',
    },
    plugins: [napiRuntimeRewrite],
    charset: 'utf8',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const bundle = readFileSync(outfile);
  writeFileSync(`${outfile}.sha256`, `${createHash('sha256').update(bundle).digest('hex')}\n`);
}

/** Rebuild mesh-runtime.cjs (or any outfile) exactly as `npm run build` does. */
export function buildMeshRuntime(outfile = join(here, 'mesh-runtime.cjs')) {
  return buildRivetBundle('mesh-runtime.src/index.ts', outfile);
}

/** Rebuild xfer-adapterd.cjs (or any outfile) from adapterd.src/main.ts. */
export function buildAdapterd(outfile = join(here, 'xfer-adapterd.cjs')) {
  return buildRivetBundle('adapterd.src/main.ts', outfile);
}

/** Rebuild web-picker.user.js (or any outfile) exactly as `npm run build` does. */
export async function buildWebPicker(outfile = join(here, 'web-picker.user.js')) {
  const banner = readFileSync(join(here, 'web-picker.src/banner.js'), 'utf8');
  await build({
    entryPoints: [join(here, 'web-picker.src/main.js')],
    bundle: true,
    format: 'iife',
    outfile,
    banner: { js: banner },
    charset: 'utf8',
    target: 'es2020',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
}
/*
 * `import.meta` shim for the CJS daemon bundles. esbuild rewrites `import.meta`
 * in cjs output to an empty `var import_meta = {}`, which would leave every
 * `import.meta.dirname` / `import.meta.url` use in the daemon sources undefined
 * (broker's page-tool CLI hint + its isMainModule() check, admin's version read).
 * The banner defines the values; `define` rewrites the two expressions onto them
 * — define only accepts entity names or literals, hence the banner variable for
 * the url rather than an inline call. Sources stay plain ESM and run unchanged
 * under `node --import ts-resolve-hook.mjs broker-main.ts`.
 */
const importMetaBanner = `
var __xferImportMetaUrl = require("node:url").pathToFileURL(__filename).href;
`;

/**
 * Rebuild a daemon bundle (broker.cjs / admin.cjs) from its `.ts` entry exactly
 * as `npm run build` does. Same esbuild settings as mesh-runtime (node platform,
 * cjs, node20 target): node builtins only, no external deps. The sha256 sidecar
 * is written next to the bundle like every other artifact.
 */
export async function buildDaemon(entry, outfile) {
  await build({
    entryPoints: [join(here, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    banner: { js: importMetaBanner },
    define: {
      'import.meta.url': '__xferImportMetaUrl',
      'import.meta.dirname': '__dirname',
      'import.meta.filename': '__filename',
    },
    charset: 'utf8',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  writeFileSync(`${outfile}.sha256`, `${createHash('sha256').update(readFileSync(outfile)).digest('hex')}\n`);
}

/** Rebuild broker.cjs (or any outfile) from broker-main.ts. */
export function buildBrokerDaemon(outfile = join(here, 'broker.cjs')) {
  return buildDaemon('broker-main.ts', outfile);
}

/** Rebuild admin.cjs (or any outfile) from admin-main.ts. */
export function buildAdminDaemon(outfile = join(here, 'admin.cjs')) {
  return buildDaemon('admin-main.ts', outfile);
}

async function main() {
  await buildWebPicker();
  await buildMeshRuntime();
  await buildAdapterd();
  await buildBrokerDaemon();
  await buildAdminDaemon();
  console.log('mesh-runtime.cjs, xfer-adapterd.cjs, broker.cjs, admin.cjs built');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (isAbsolute(process.argv[1]) ? process.argv[1] : join(process.cwd(), process.argv[1]))) {
  await main();
}
