# Release Guide
[简体中文](release.zh.md)

How to ship a new version of pi-xfer to npm. The process is tag-driven: a
GitHub Actions workflow (`.github/workflows/publish.yml`) publishes on every
pushed `v*` tag.

## Before releasing

1. All changes are committed to `main` and `npm test` is green.
2. Build products are fresh: if `web-picker.src/` or `mesh-runtime.src/`
   changed, run `npm run build` and commit `dist/web-picker.user.js` and
   `dist/mesh-runtime.cjs` + `.sha256`.

## Steps

1. **Bump the version** in `package.json` and commit:

   ```bash
   npm version patch   # or minor / major
   ```

   `npm version` updates `package.json`, commits, and creates the `vX.Y.Z`
   tag in one step. The publish workflow verifies that the tag matches
   `package.json`'s version and aborts on mismatch, so never hand-edit one
   without the other.

   If you touched `dependencies` / `peerDependencies` / `devDependencies`,
   run `npm install` first so `package-lock.json` is in sync — `npm ci`
   in CI fails on an out-of-date lockfile.

2. **Push the branch and the tag together**:

   ```bash
   git push origin main --follow-tags
   ```

3. **Watch the workflow** at
   `https://github.com/azzgo/pi-xfer/actions` — it runs `npm ci`,
   `npm test`, the tag/version check, then `npm publish --provenance`.

## After releasing

Users upgrade with:

```bash
pi update --extensions
```

(or reinstall via `pi install npm:pi-xfer`).

## Package manifest requirements

`package.json` must keep the extension loadable when installed from npm:

- `"pi": { "extensions": ["./index.ts"] }` — without a `pi` manifest, pi
  only discovers extensions in conventional directories (`extensions/` …),
  and the root-level `index.ts` would never load.
- Host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are
  declared as `peerDependencies` with `"*"` ranges — never `dependencies`,
  never bundled.
- `files` must cover every module the extension imports plus the daemon
  sources (`daemon/*.ts`) and the committed `dist/` bundles. A missing entry
  is invisible in the repo tree — `daemon/` once was — and only shows up as
  `Cannot find module` on an npm install, after which the extension never
  registers its flags and `pi --xfer <name>` reports `Unknown option: --xfer`.
  `src/package-files.test.ts` walks the import graph and fails on any gap.
