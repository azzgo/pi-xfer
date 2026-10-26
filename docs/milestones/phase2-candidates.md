# Milestone 2 — draft candidate list (brainstorm, not yet approved)
[简体中文](phase2-candidates.zh.md)

Collected from: retro of milestone-1 sessions (agentsview), user input, and cross-project
retro handoffs from `refine` (2026-10-13).

## P0-A — Web Picker site compatibility: silent failure
## P0-A — Web Picker site compatibility: silent failure

- Decision (2026-10-13): **investigate first** — root-cause both failure modes (npmjs WS
  block, YouTube no-init), fix what is fixable; for what is not, document which site
  classes/policies are affected (README or docs/guides known-limitations note).
- npmjs hypothesis: CSP `connect-src` blocks `ws://127.0.0.1`; `new WebSocket` does **not**
  throw on CSP block — only async `onerror` + page `securitypolicyviolation` fire, so the
  current `conn.wsFailed` toast (wired to the constructor catch) never shows.
- YouTube: userscript never initializes at all — separate root cause to reproduce
  (injection mode / SPA timing / `window.__PI_WEBPICKER__` world / Trusted Types).
- Likely deliverables regardless of fixability: visible connection-failure feedback
  (listen for `securitypolicyviolation` + `onerror`, fab badge/toast) + documented
  incompatible-site classes.

## P0-B — Broker/admin daemon: drop experimental Node dependency
- Decision (2026-10-13): **bundle** broker/admin daemons like `mesh-runtime.cjs` (committed
  build products, `npm run build` + freshness test). Removes both the experimental-API risk
  and the node_modules restriction.
- Packaging note from user: once bundled, npm publish should **exclude the `.ts` sources**
  (currently `files` includes `*.ts`) — ship the bundles, not the source.
- README must state the Node requirement (currently missing); exact floor set during design.
## P1-E — Mesh node capability descriptions

- User request (2026-10-13): mesh nodes are equal, independent actors; today they are all
  agent-type nodes, and when one agent wants to proactively call another, it has no way to
  know who does what. Add descriptive metadata per node so other agents can decide who to
  message.
- Requirements set by user: **default absent**, editable by the node itself, **on-demand
  query** (listings carry names only; descriptions fetched per target when wanted).
- `mesh.config.json` is ruled out — it is one machine-global file with connection info
  only, no per-node data.
- Direction that fits: description lives in the node's own actor state on the engine
  (each node is already `getOrCreate("xfer-instance", [name])`). Set/change via a node-side
  command (sibling of `/xfer name`, e.g. `/xfer desc`); other agents query the target
  actor on demand. Cross-machine propagation comes for free since it is engine-side state.
- Open questions for design: query surface (new tool vs extending discovery), whether the
  description is free text or structured, and whether the ad-hoc "report interface
  capabilities to ExecutiveAgent" handoff pattern (session `pi:01a11120`) becomes this
  first-class mechanism.

## P1-D — Handoff cwd anchoring (from refine's cross-project retro)

- Problem: receiving agents repeatedly edit files in the wrong checkout when handling
  cross-project handoffs; the doc carries no authoritative working-directory anchor.
- Direction: mechanical sender-side stamping, not convention. `xfer_to`/`xfer_mesh_to`
  know the sender cwd at send time; stamp the delivered markdown (e.g.
  `<!-- xfer:sender-cwd ... -->`) and add the instruction to the injection envelope.
- Consumer-side design answers (refine, 2026-10-13, recorded verbatim in handoff
  `pi-xfer-mv647ogc-8iltwn.md`):
  1. Stamp + envelope instruction is enough; no receiver-side enforcement for now —
     revisit only if wrong-cwd edits recur after the stamp ships.
  2. Cross-machine mesh: degrade to project-name anchor **plus** sender machine/user and
     a worktree/branch hint — same project lives at different paths on different
     machines, and worktree names alone are ambiguous (dev/dup2/dup3).
  3. Put the instruction in the `📨 [Xfer from ...]` envelope text (what the receiver
     sees first), not only as an HTML comment in the doc.

## Closed / out of scope

- Quickstart video/GIF — released on YouTube instead; no milestone item.
- Publish workflow auto release notes — already implemented in `publish.yml`.
- `docs/guides/` split — already done in milestone 1.
- verify skill / chrome-devtools MCP — landed in milestone-1 retro (`e6ec107`).

## Status
Both open decisions resolved 2026-10-13 (P0-B: bundle; P0-A: investigate-first). List
ready for final approval before moving to the design node.
