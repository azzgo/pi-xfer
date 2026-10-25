# Contributing to pi-xfer

A short orientation for humans and outside contributors. **If you are an agent working in
this repo, read `AGENTS.md` instead** — it is stricter and it is the source of truth. This
file does not restate it, and where the two could drift, `AGENTS.md` wins.

## What this is

A pi extension for one-way cross-context handoff: `xfer_to` writes a markdown document and
hands it to another agent's socket, then returns immediately. Read `README.md` for the
capabilities table, `CONTEXT.md` for the vocabulary, and `docs/adr/` for why the design is
the way it is.

## Before you open a PR

- **`npm test` must be green.** Tests are hermetic *by rule*: a test must never reach a
  deployed engine, tunnel, or relay, and must never need a token. `mesh-guard.ts` enforces
  this structurally — it arms whenever `NODE_TEST_CONTEXT` is set and refuses every
  non-loopback endpoint, so a test that forgets to inject a stub fails loudly instead of
  quietly talking to someone's deployment.
- **If you touch `web-picker.src/`, `mesh-runtime.src/`, `daemon/broker-main.ts`, or
  `daemon/admin-main.ts`, run `npm run build` and commit the artifacts** — `web-picker.user.js`,
  `mesh-runtime.cjs`, `broker.cjs`, `admin.cjs`, and the `.sha256` files. A freshness test
  enforces byte-identical output, so a stale artifact fails CI.
- **No new runtime dependencies.** The extension ships with none; rivetkit is bundled, not
  installed. `examples/` keeps its own `package.json` and is not published.

## Adding a host

`generic` covers any host with a shell. If your host needs a different install location or
a different launch command, a named preset in `skills/xfer-agent/hosts/` is the right
shape — see `skills/xfer-agent/install.md` for what a preset may contain. **A preset
carries configuration only, never delivery logic.**

## What we are not taking

These are settled decisions, not open questions. Please argue the decision before opening a
PR for the implementation:

| | Why |
|---|---|
| A2A | pi-xfer is stateless by design; A2A inverts that choice |
| Durable read receipts behind a store | ADR-0015 chose a lossy take-to-read Inbox on purpose |
| An inbound `held` state | ADR-0020 — the mesh's queue contract cannot express it |
| Per-host delivery logic inside a preset | drifts with other projects' releases and cannot be covered by this repo's hermetic tests |
| Threading or causal fields on handoffs | deferred to a later milestone; needs its own decision first |

## How decisions get recorded

Anything hard to reverse gets an ADR in `docs/adr/` — one paragraph plus consequences,
written when the decision is made rather than after. Vocabulary lives in `CONTEXT.md`; if
your change introduces a term, or sharpens an existing one, update it in the same PR.
