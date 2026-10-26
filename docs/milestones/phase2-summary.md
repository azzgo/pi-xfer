# Milestone 2 Summary — Release Note Input
[简体中文](phase2-summary.zh.md)

> Milestone: Phase 2 — Robustness + site compatibility + cross-agent ergonomics.
> Status: all planned items implemented and verified. Candidate list and per-feature
> design plans: `docs/milestones/phase2-candidates.md`, `phase2-design-p0a.md`,
> `phase2-design-p0b.md`, `phase2-design-p1d.md`, `phase2-design-p1e.md`.

## Shipped

### P0

- **P0-A Web picker site compatibility** — the userscript now survives hostile pages.
  Root causes were verified live on the real sites via chrome-devtools (see *Fixes* below
  for the diagnosis): a Trusted Types shim (`createPolicy('pi-xfer')` with `setHTML`
  replacing every bare `innerHTML` assignment) fixes init crashes on Trusted-Types-enforcing
  sites; CSP-blocked WebSocket connects are now surfaced via a `securitypolicyviolation`-
  based blocked state instead of failing silently; and when the broker channel is
  unreachable the picker degrades to an offline copy-prompt flow (local prompt composer,
  no mention of the page-tool channel, send button hidden while not linked).
- **P0-B Broker/admin daemons as committed build products** — `broker-main.ts` and
  `admin-main.ts` are now esbuild-bundled to committed `broker.cjs` / `admin.cjs`
  (+ `.sha256` each, freshness-tested on rebuild like `mesh-runtime.cjs`). The daemons no
  longer spawn via Node's experimental type stripping, removing both the experimental-API
  risk and the `node_modules` spawn restriction. Committed build artifacts went from two
  to four; AGENTS.md updated accordingly.

### P1

- **P1-D Handoff cwd anchoring** — `xfer_to` / `xfer_mesh_to` stamp the delivered markdown
  with a sender-cwd comment (cwd / project / machine / branch) and the injection envelope
  now instructs the receiving agent to edit in the sender's directory. Cross-machine
  handoffs degrade to project name + machine/user + branch hint, so receivers stop editing
  in the wrong checkout.
- **P1-E Mesh node descriptions** — nodes can self-describe via `/xfer desc`; the
  description lives in the node's actor state on the engine (so cross-machine propagation
  is free), is readable per-target through a `describe` RPC, and is attached to the
  broker `targets` results. Deliberately no bulk-listing fan-out and no scheduling logic —
  deciding who to message is left to consuming agents.

## Fixes (during the milestone)

- Web picker root causes, diagnosed live before fixing: npmjs.com's CSP `connect-src`
  allowlist blocks `ws://127.0.0.1` and — importantly — `new WebSocket()` does **not**
  throw and `onclose` never fires, so the old error toast was unreachable; YouTube
  enforces Trusted Types, so `root.innerHTML = …` threw during init and killed the whole
  userscript with no error surface.
- Follow-up (`978b89e`): degraded-state layout and blocked-state timing corrections in the
  web picker.
- Broker version is now read from `package.json` instead of a hardcoded `0.1.0`.

## Key decisions

- Committed build products ship as bundles (four now: `web-picker.user.js`,
  `mesh-runtime.cjs`, `broker.cjs`, `admin.cjs`), closing the milestone-1 follow-up on
  `stripTypeScriptTypes` being an experimental Node API.
- P0-A followed an investigate-first decision: both failure modes were root-caused on the
  live sites before any code changed; unfixable cases degrade visibly instead of silently.
- P1-D is mechanical sender-side stamping, not receiver-side convention or enforcement —
  stamp + envelope instruction only, revisit only if wrong-cwd edits recur.
- P1-E keeps the mesh egalitarian: descriptions are default-absent, node-editable, and
  fetched on demand; no scheduling/dispatch logic in the extension.

## Verification

- `npm test`: 285/285 green.
- Bundled daemons smoke-tested standalone (`broker.cjs` / `admin.cjs` run directly).
- P1-D verified live via a tmux-driven pi session (stamp + envelope visible on receipt).
- Pending manual follow-ups: Tampermonkey re-test of the picker UI fixes on
  YouTube/npmjs plus a regression pass on normal sites; npm-install scenario re-test.

## Follow-ups / Deferred

- Mesh description scheduling consumer (an agent that uses descriptions to route work) —
  deferred by user decision; the data layer ships, the consumer does not.
- Documented incompatible-site-class note for the web picker if further CSP variants
  surface.

## Closed / out of scope

- Quickstart video — released on YouTube instead
  (https://youtu.be/0mm2CirJMUo, milestone 1).
- Publish workflow release notes — already automated in `publish.yml`.
- Verify skill — landed in the milestone-1 retro (`e6ec107`).
