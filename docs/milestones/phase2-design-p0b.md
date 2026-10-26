# Milestone 2 design — P0-B broker/admin daemons as committed bundles

## Decision (2026-10-13)

Bundle the broker and admin daemons like `mesh-runtime.cjs` — committed build products
with sha256 freshness tests. Kills both the experimental-API dependency
(`stripTypeScriptTypes` / type stripping) and the `node_modules` spawn restriction
(incident: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, session `pi:01a12af5`).

## Current mechanics (verified)

- `broker-manager.ts` spawns `node --disable-warning=ExperimentalWarning --import
  ts-resolve-hook.mjs broker-main.ts --port … --xfer-dir …` (detached, log fd inherited).
- `admin-manager.ts` spawns the same shape (`admin-main.ts`); both managers already accept
  a daemon-entry override (tests point at stubs).
- `broker-main.ts` / `admin-main.ts` depend only on node builtins + sibling `.ts` files —
  esbuild-bundling them needs no external deps.
- `build.mjs` already has the pattern: esbuild CJS bundle, committed artifact +
  `.sha256`, freshness assert in a test (`mesh-bundle.test.ts` /
  `artifact-freshness.test.ts`).

## Plan

1. **build.mjs**: add `buildDaemon(entry, outfile)` — esbuild, `platform: node`,
   `format: cjs`, `target: node20` (same as mesh-runtime), writing `broker.cjs` and
   `admin.cjs` + `.sha256` each. `npm run build` produces four committed artifacts.
2. **Freshness tests**: extend the existing artifact-freshness test to rebuild both
   daemons to temp files and assert byte-identity (same 漏提交防线 as mesh-runtime).
3. **managers**: default daemon entry becomes the `.cjs` bundle; spawn drops
   `--import RESOLVE_HOOK` and `--disable-warning=ExperimentalWarning` (no longer
   experimental anything). Keep the entry-override knobs for tests.
4. **Cleanup**: `ts-resolve-hook.mjs` no longer needed at runtime by the daemons; remove
   its spawn usage (extension-side test runner still uses `--import` for `npm test` — keep
   the file in-repo, see packaging).
5. **README**: state the Node requirement plainly (bundles target node20; extension host
   follows pi's own requirement). `engines` in package.json stays consistent with that.
6. **AGENTS.md**: the "two committed build products" line becomes four.

## Packaging (npm files) — correction to the original ask

`*.ts` **cannot** be dropped from the npm package wholesale: pi loads the extension
itself (`index.ts` and friends) from those sources at runtime — that path works today and
is pi's responsibility, not ours. What the bundle removes from the publish list:

- `ts-resolve-hook.mjs` (daemon spawn hook) — droppable.
- Nothing else changes: daemon entry `.ts` files stay (managers still import
  `pidAlive` from `broker-main.ts`, and they document the daemon); the `.cjs` + `.sha256`
  join the files list.

If "ship no source" is a hard requirement, that is a different, larger feature
(pre-publish compile of the whole extension to JS) — explicitly out of scope here.

## Touched areas

`build.mjs`, `broker-manager.ts`, `admin-manager.ts`, `package.json` (files, artifacts),
freshness tests, `README.md`, `AGENTS.md`; new committed artifacts `broker.cjs`,
`admin.cjs` (+ `.sha256` ×2).

## Risks

- Daemon bundles must stay byte-reproducible (esbuild version is already pinned via
  devDependencies — same guarantee as mesh-runtime).
- Behaviour drift between `node .ts` (dev/test) and `node .cjs` (production spawn):
  freshness tests plus the existing daemon-entry override let tests run against the real
  bundle once, not just the stub.
- `import.meta.dirname` usages inside broker-main resolve differently in a CJS bundle —
  esbuild's shim handles it, but the status/doctor output paths should be smoke-checked
  after the switch.
