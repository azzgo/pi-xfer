# AGENTS.md

You are working on **pi-xfer**, a pi coding-agent extension for cross-context handoff.
This file is a map, not a rulebook — the authoritative guidance lives in the
documents it points to.

## Read in this order

1. **`README.md`** — what the extension is, install, capabilities table
2. **`CONTEXT.md`** — glossary and mental model (Mesh, Node, Board, Card, Marker, …). Use these terms as defined; do not invent synonyms.
3. **`docs/adr/`** — why the architecture is the way it is. Decisions recorded there are settled; do not relitigate or work around them:
   - mesh transport (bundle + on-demand native runtime, engine-side discovery)
   - board scope (append-only, human-cleaned)
   - web-picker record philosophy
4. **`docs/web-picker.md`** — userscript + broker workflow details
5. **`docs/release.md`** — how to cut a release: bump version, tag, push; the publish workflow does the rest

## Working agreements

- **Trunk-based**: commit to `main` in small focused commits.
- **Two committed build products** (`web-picker.user.js`, `mesh-runtime.cjs` + `.sha256`): after changing `web-picker.src/` or `mesh-runtime.src/` run `npm run build` and commit the artifacts; `npm test` enforces byte-identical freshness.
- **Tests**: `npm test` must be green before every push. Tests must be hermetic — never depend on the developer's real `~/.pi/xfer` state.
- **No runtime npm dependencies** for the extension itself; rivetkit stays out of the dependency list (see the ADR above).
- **Releases**: follow `docs/release.md` — `npm version` + `git push origin main --follow-tags`; never hand-edit the version and tag separately.

## Layout pointers

| Path | Role |
|---|---|
| `*.ts` (root) | extension source; `index.ts` is the entry point |
| `mesh-runtime.src/` | mesh engine source (bundled to `mesh-runtime.cjs`) |
| `web-picker.src/` | userscript source (bundled to `web-picker.user.js`) |
| `docs/adr/`, `CONTEXT.md` | decisions and glossary — update only with cause, never casually |
