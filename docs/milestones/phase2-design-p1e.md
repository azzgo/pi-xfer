# Milestone 2 design — P1-E mesh node capability descriptions

## Decisions (2026-10-13, user)

- Description lives in the node's own **actor state on the engine** — not
  `mesh.config.json` (that file is machine-global connection config only).
- **Default absent**; the node itself sets/changes/clears it.
- Per-node **describe RPC only** — pi-xfer provides the capability (set + get per node);
  listing stays names-only. No bulk fan-out built in: consumers who want a full map loop
  describe themselves and cache locally (same principle as no scheduling closed loop).
  scheduling design is intentionally out of scope until the user's dispatcher concept
  matures.

## Current mechanics (verified)

- Each node is one actor: `client.getOrCreate("xfer-instance", [name])` in
  `mesh-engine.ts`; the actor definition is local (`actor({ … })` in `ensureNode`).
- Node listing is an engine HTTP query (`GET /actors?name=xfer-instance`) mapped to
  `{ name, actorId }` — engine metadata carries no custom fields, so descriptions cannot
  ride the engine query; they must come from the actors themselves.
- Targets listing for agents already exists (`listTargets`, broker `targets` op) — the
  natural place to attach descriptions.

## Plan

### 1. Actor state + RPC (`mesh-runtime.src` actor, `mesh-engine.ts`)

- Actor gains a `description` field in its state (default `""`) and two RPCs:
  `set description` (validate: string, trimmed, length cap ~500 chars) and `get
  description`.
- State persists with the actor on the engine — survives node restart/reconnect; offline
  nodes keep their description.

### 2. Set/clear entry point (extension command)

- `/xfer desc <text>` sets this node's description; `/xfer desc` with no argument clears
  it. Sibling of `/xfer name`. Requires mesh online; clear error otherwise.

### 3. Read path

- **Per-node describe RPC** is the only built-in read: caller names a target, gets
  `{ name, description }`. Listing endpoints stay as-is (names only).
- The broker `targets` op (the mandatory pre-send query in the agent send flow) attaches
  the description field to each entry as the single convenience — no extra round-trip on
  the send path. Everything else is the consumer's loop-and-cache.

### 4. Docs

- README / guides: what a node description is for, suggested content ("what requests this
  agent handles"), and the explicit note that routing/scheduling is deliberately left to
  consumers.

## Touched areas

`mesh-runtime.src/` (actor state + RPCs), `mesh-engine.ts` (describe call),
`commands.ts` (`/xfer desc`), `targets.ts` / broker `targets` op (description
field), i18n strings, tests (actor RPC, command), README/guides; rebuild
`mesh-runtime.cjs`.

## Risks

- Offline nodes simply have no reachable description — the describe RPC fails with the
  normal "target may be offline" error; callers treat it as unknown.
- Description is self-declared and unverified — fine for routing hints, but docs should
  not promise more.
- Actor state API surface must stay minimal; mesh-runtime.cjs bundle changes → freshness
  test cycle applies.
