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
4. **`docs/dev/web-picker.md`** — userscript + broker workflow details
5. **`docs/dev/mesh-log.md`** — mesh log: what is recorded, what the native runtime keeps off the file, how to maintain it
6. **`docs/release.md`** — how to cut a release: bump version, tag, push; the publish workflow does the rest

## Working agreements

- **Trunk-based**: commit to `main` in small focused commits.
- **Four committed build products** (`web-picker.user.js`, `mesh-runtime.cjs`, `broker.cjs`, `admin.cjs`; the `.cjs` ones ship a `.sha256`): after changing `web-picker.src/`, `mesh-runtime.src/`, `broker-main.ts` or `admin-main.ts` run `npm run build` and commit the artifacts; `npm test` enforces byte-identical freshness.
- **Tests**: `npm test` must be green before every push. Tests must be hermetic — never depend on the developer's real `~/.pi/xfer` state.
- **Never test against a live deployment.** A hermetic mesh test uses the injected engine seams (`fakeDeps`) or an engine the test starts locally; it must never reach a deployed engine, tunnel or relay, and must never need a token. Manual end-to-end checks against a real deployment are a human decision each time — ask first, and never leave one wired into a script, a test, or a sub-agent's default instructions.
- **No runtime npm dependencies** for the extension itself; rivetkit stays out of the dependency list (see the ADR above).
- **Verify visible changes**: `npm test` green is not verification for UI or interactive changes — after editing `admin-*.ts` pages or `commands.ts` flows, run the `.agents/skills/verify/` skill (chrome-devtools MCP for the admin page, tmux for command smoke). web-picker userscript stays out of scope (manual).
- **One installed copy**: keep `npm:pi-xfer` as the only pi-xfer entry in `~/.pi/agent/settings.json` and upgrade it with `pi update --extensions`. Two copies in one session collide on `xfer_to` / `xfer_mesh_to` / `--xfer` and the second fails to load. Never `pi install <path to this repo>`; run the working tree with `pi -ne -e ./` (skip discovery, load this `index.ts`).
- **Releases**: follow `docs/release.md` — `npm version` + `git push origin main --follow-tags`; never hand-edit the version and tag separately.

## Layout pointers

| Path | Role |
|---|---|
| `*.ts` (root) | extension source; `index.ts` is the entry point |
| `mesh-runtime.src/` | mesh engine source (bundled to `mesh-runtime.cjs`) |
| `web-picker.src/` | userscript source (bundled to `web-picker.user.js`) |
| `broker-main.ts`, `admin-main.ts` | daemon sources (bundled to `broker.cjs`, `admin.cjs` — what the managers spawn) |
| `docs/adr/`, `CONTEXT.md` | decisions and glossary — update only with cause, never casually |
| `skills/xfer/` | the pi-side skill + its `scripts/xfer` wrapper — canonical here, deployed by symlink (never copied into dotfiles) |
| `skills/xfer-agent/` | the non-pi host skill, rendered by `xfer-adapterd install` |
