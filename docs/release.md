# Release Guide

How to ship a new version of pi-xfer to npm. The process is tag-driven: a
GitHub Actions workflow (`.github/workflows/publish.yml`) publishes on every
pushed `v*` tag.

## Before releasing

1. All changes are committed to `main` and `npm test` is green.
2. Build products are fresh: if `web-picker.src/` or `mesh-runtime.src/`
   changed, run `npm run build` and commit `web-picker.user.js` and
   `mesh-runtime.cjs` + `.sha256`.

## Steps

1. **Bump the version** in `package.json` and commit:

   ```bash
   npm version patch   # or minor / major
   ```

   `npm version` updates `package.json`, commits, and creates the `vX.Y.Z`
   tag in one step. The publish workflow verifies that the tag matches
   `package.json`'s version and aborts on mismatch, so never hand-edit one
   without the other.

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
