# The page-tool channel advertises itself

`broker.cjs page-tool` could query the page a web-picker handoff came from,
but the receiving agent had no way to learn it existed: its default move was
to open a browser, which hands it the whole DOM instead of the elements that
were picked. A capability that nobody knows about is not a capability — the
cost of the missing knowledge was paid in tool calls and re-reads of the
page, not in a missing feature.

## Decision

The channel states itself in every surface the receiving agent touches:

1. **The delivery message leads with it.** The web-picker branch of the
   inbound envelope names the channel *before* the request, says not to open a
   browser, and carries a runnable command pointing at the shipped
   `dist/broker.cjs` (the `daemon/broker-main.ts` path is not runnable under
   `node_modules`, where node refuses to type-strip it).
2. **The handoff doc opens with a pointer** to its `Follow-up channel`
   section, and names the tabId when the broker resolved one. The pointer is
   above the request, so an agent that reads the doc top-down meets the
   channel before it decides how to work.
3. **The CLI describes itself**: `broker.cjs page-tool --help` prints the op
   table, `broker.cjs --help` prints both modes.

The existing `## Follow-up channel` doc section (ADR-0022's tab routing) is
unchanged; the pointer adds no new routing rule.

## Why not the alternatives

- **A skill.** The receiving agent is not guaranteed to load the xfer skill,
  and the skill cannot outrank a message the agent reads first. The channel
  has to travel with the handoff.
- **Only a doc section.** It already existed — and the agent still opened a
  browser. A section at the end of a document is found only after the
  document is read end to end; the failure mode is a decision made before
  that.
- **Make page-tool a general browser replacement.** It is not one: it needs a
  picker tab, and a page with no picker tab has no tabId. The wording
  therefore says "the page this handoff came from", never "any URL".

## Consequences

- The tabId is still read, never guessed (ADR-0022). The pointer repeats that
  rule because a guessed tabId is a `tab_unreachable` in disguise.
- The delivery message's example command is a bundle path, because the
  extension's own directory layout is not what the reader has installed.
- `page-tool --help` exiting 0 without a broker running is intentional: the
  op table is a description, not a call.
