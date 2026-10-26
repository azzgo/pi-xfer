# Xfer board: Markdown cards, human-commanded, prompt-injected writes

Status: accepted

## Context

The xfer extension moved handoffs between sessions, but cross-project async
collaboration had no home: an agent's findings and open questions died with its
session, and agents that could help were often offline when the need arose. The
collaboration model wanted is deliberately modest — a shared surface of topics
where any agent can be *sent to read and write by the human*, without needing a
live peer connection or a messaging protocol between agents.

Three decisions had real alternatives:

1. **Storage format.** JSONL/SQLite give cheap indexing and atomic updates but
   produce opaque blobs: neither the human nor an agent can inspect a card
   without tooling, and the value of a reviewable audit trail (who said what,
   when) is the point of a discussion board.
2. **Who drives reads and writes.** The obvious agent-native design is to
   register `board_read` / `board_write` tools and let agents use the board
   autonomously. That was rejected: the operator wants to be the sole
   coordinator of cross-agent communication (agents already talk directly via
   the existing xfer handoff protocol when online), and registering more tools
   widens the surface the operator has to reason about.
3. **How agent-composed entries get onto a card.** Without tools, a slash
   command handler (deterministic code, no LLM) cannot judge entry type or
   distill "把你刚才的结论记到卡上" into an Entry — but it can inject a prompt
   and intercept the reply.

## Decision

- **One Markdown file per card** under `~/.pi/xfer/board/`
  (`c-XXXX-slug.md`): YAML-ish front matter (id/title/created_by/created_at)
  plus an append-only body of `### e-XXXX · type · author · timestamp`
  sections. Agents and humans read the file as-is; `read` injects it verbatim;
  review means opening the directory.
- **Command-driven only.** All board operations live under `/xfer board …`.
  No `pi.registerTool`. Agents never touch the board unprompted; the human
  orchestrates (`read` into one session, `write` in another, or dispatches via
  `/xfer <target>` for online peers).
- **Two-phase writes via prompt injection + `agent_end` interception.**
  `/xfer board write <id> <intent>` (and untitled `new`) stores a pending
  target, injects a prompt asking the agent to reply with *only* a fenced
  ```board-entry``` block (title for new cards, type, `---`, markdown body);
  the `agent_end` handler parses that block, appends the Entry, and clears the
  pending state. Malformed replies abort with a warning — nothing half-written.
- **Cards are stateless.** No lifecycle statuses, no assignees, no timers.
  `del` (one card, confirmed) and `clean` (all cards, confirmed) are the only
  cleanup paths, both human-invoked. Entry types (note/finding/question/answer)
  are labels, not logic.

## Consequences

- The board is trivially inspectable (`ls ~/.pi/xfer/board`, `cat`, `grep`) and
  the review entry point is the filesystem itself (`/xfer board open`).
- Inter-session collaboration has latency floor of one human round-trip per
  hop; acceptable for discussion/analysis, wrong for tight loops — those
  should use live `/xfer` handoffs instead.
- The fenced-block protocol is convention, not schema: if the agent ignores
  it, the write fails loudly rather than corrupting a card. A future
  `registerTool` switch could replace it without touching the storage format.
