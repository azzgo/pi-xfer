# AGENTS.md
[简体中文](AGENTS.zh.md)

You are working on **pi-xfer**, a pi coding-agent extension for cross-context handoff.
This file is a map, not a rulebook — the authoritative guidance lives in the
documents it points to. This file is written for agents and stays English-only
(see the last working agreement below).

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
- **Committed build products** (all in `dist/`: `web-picker.user.js`, `mesh-runtime.cjs`, `xfer-adapterd.cjs`, `broker.cjs`, `admin.cjs`; the `.cjs` ones ship a `.sha256`): after changing `web-picker.src/`, `mesh-runtime.src/`, `adapterd.src/`, `daemon/broker-main.ts` or `daemon/admin-main.ts` run `npm run build` and commit the artifacts; `npm test` enforces byte-identical freshness. `mcp-gateway.mjs` is **not** one of them — a committed single file with no bundling step and no repo imports.
- **Tests**: `npm test` must be green before every push. Tests must be hermetic — never depend on the developer's real `~/.pi/xfer` state.
- **Never test against a live deployment.** A hermetic mesh test uses the injected engine seams (`fakeDeps`) or an engine the test starts locally; it must never reach a deployed engine, tunnel or relay, and must never need a token. Manual end-to-end checks against a real deployment are a human decision each time — ask first, and never leave one wired into a script, a test, or a sub-agent's default instructions. **A read is a check**: a `GET` (`/xfer mesh list`, `/xfer mesh status`) and a command typed into an interactive tmux pane both reach the deployed engine, so both need the same yes — the guard does not cover interactive sessions.
  One documented exception: the `examples/` serverless node cannot be exercised any other way — a Durable Object has no local stand-in — so its verification is a **manual, one-off, written-down procedure** on a real deployment. It stays out of `npm test` and out of every script; the procedure lives in the example's docs, not in code.
  This is now **structural, not just a rule**: `mesh-guard.ts` arms itself whenever `NODE_TEST_CONTEXT` is set (a `node --test` worker, or anything it spawns) and then refuses every non-loopback endpoint from both outbound planes (`fetch` via `engineApi`, `rivetkit/client` via `createClient`) as well as the default mesh config path. `XFER_ALLOW_REMOTE=1` is the only opt-in and no test sets it — `mesh-guard.test.ts` asserts that repo-wide. A test that forgets to inject a stub fails loudly instead of reaching a deployment.
- **No runtime npm dependencies** for the extension itself; rivetkit stays out of the dependency list (see the ADR above).
- **Verify visible changes**: `npm test` green is not verification for UI or interactive changes — after editing admin pages (`daemon/admin-main.ts`) or `src/commands.ts` flows, run the `.agents/skills/verify/` skill (chrome-devtools MCP for the admin page, tmux for command smoke). web-picker userscript stays out of scope (manual).
- **Cross-machine verification has its own rules**: when a change involves a Link (or any two-machine transport), judging results is a separate skill — a running process never picks up new code, tmpdirs differ per machine, and mesh vs Link deliveries land in same-named files. See "Judging results across two machines" in `.agents/skills/verify/SKILL.md` and the three-line checklist in `docs/dev/ssh-link-verification.md` before trusting any cross-machine observation.
- **One installed copy**: keep `npm:pi-xfer` as the only pi-xfer entry in `~/.pi/agent/settings.json` and upgrade it with `pi update --extensions`. Two copies in one session collide on `xfer_to` / `xfer_mesh_to` / `--xfer` and the second fails to load. Never `pi install <path to this repo>`; run the working tree with `pi -ne -e ./` (skip discovery, load this `index.ts`).
- **Releases**: follow `docs/release.md` — `npm version` + `git push origin main --follow-tags`; never hand-edit the version and tag separately.
- **Bilingual documentation**: every paired document has a `.zh.md` twin, and a change to one is a change to both — same commit, same review. Concretely:
  - Edit the English file first, then bring the Chinese mirror to the same state. Never "translate later".
  - Keep structure identical (heading count, fenced-block count, image count) and **code fences byte-identical** — commands, flags, paths, config keys, identifiers and URLs are never translated.
  - Point relative links at the `.zh.md` counterpart; keep the same set of document links on both sides.
  - Assets (`docs/guides/assets/`) are shared: reference the same file from both sides, never copy or translate it.
  - Glossary terms stay in English inside Chinese prose (`CONTEXT.md` fixes them; they are names, not words).
  - Not paired, on purpose: `skills/**`, `.agents/skills/**`, `.pi/**`, `.pig/**` — see `docs/i18n.md` for why.
  - `README.zh.md` uses the Bilibili cut (<https://www.bilibili.com/video/BV1oQWc6fEn9>) where `README.md` links YouTube.
  - When adding a new document, add its `.zh.md` in the same commit; `src/docs-pairs.test.ts` fails on a missing pair, structural drift, a mistranslated code block, or a Chinese file whose links do not point at counterparts.
- **Documents for humans are bilingual; documents for agents are English-only.** The pairing rule keys on *audience*, not location:
  - **Paired (human-facing)**: `README.md`, `CONTEXT.md`, `CONTRIBUTING.md`, everything under `docs/` and `examples/`/`promo/` READMEs. English is canonical, the `.zh.md` file mirrors it, and both sides carry a cross-link to each other (`[简体中文](X.zh.md)` under the English H1, `> 中文版 · 英文原文：[X](X)` atop the Chinese file).
  - **Never paired (agent-facing)**: `AGENTS.md` itself, `skills/**` (shipped prompt material installed into other hosts — a translated copy would be a second behavioural source of truth), `.agents/**` (agent tooling), `.pi/**`/`.pig/**` (local working state). Do not create `.zh.md` files for these; if one exists, delete it.
  - Rationale: a mirror only pays for itself when a *human* reads the other language. An agent reads English fine, and a second copy of its instructions is drift waiting to happen.

## Layout pointers

| Path | Role |
|---|---|
| `index.ts` (root) | extension entry point (what `pi.extensions` points at) |
| `src/` | extension source by domain: `core/` (shared kernel), `mesh/`, `link/`, `board/`, `session/`, `broker/`, `admin/` — tests live next to their modules |
| `mesh-runtime.src/` | mesh engine source (bundled to `mesh-runtime.cjs`) |
| `web-picker.src/` | userscript source (bundled to `web-picker.user.js`) |
| `daemon/` | daemon sources (`broker-main.ts`, `admin-main.ts` — bundled to `broker.cjs`, `admin.cjs`, what the managers spawn) |
| `tests/` | module tests for the unbundled web-picker sources (the colocated `*.test.ts` under `src/` cover everything else) |
| `docs/adr/`, `CONTEXT.md` | decisions and glossary — update only with cause, never casually |
| `*.zh.md` beside every paired document | the Chinese mirror; `docs/i18n.md` is the rule, `src/docs-pairs.test.ts` the guard |
| `skills/xfer/` | the pi-side skill + its `scripts/xfer` wrapper — canonical here, deployed by symlink (never copied into dotfiles) |
| `skills/xfer-agent/` | the non-pi host skill, rendered by `xfer-adapterd install` |
