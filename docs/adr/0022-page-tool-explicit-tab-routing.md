# 0022 — Page-tool always targets a tab; broadcast fallback removed

Page-tool routing used to guess (`latestTabIdByTarget` from the last
`annotation.submit`) and silently broadcast to all tabs when the guess
missed — the main reason agents ended up on the wrong page and retried
blindly. Every inbound connection declares its page-lifetime tab id at
`hello`, and every submit/bag entry carries Provenance, so the origin tab
is always a known fact, never a guess. Decided:

- `page-tool` requires an explicit tabId; a miss is a direct connect-style
  error (no `unknown_tab` vs `tab_disconnected` taxonomy — the id being
  unparseable is the parser's business, inability to reach the tab is just
  "connection failed").
- The submit ack carries `routedTabId`, and handoff docs state the originating
  tab (`- tabId: <id>` under `## Page`, plus `--tab` on every page-tool command
  example). Agents read the tabId from the doc and pass `--tab` explicitly.

  Both values come from ONE fact — the tab registered at `hello` on the live
  connection, never from the frame (a page cannot vouch for its own routing
  identity). The ack is for the picker; the doc is for the agent, which has no
  bus to that ack. Shipping the ack without the doc line was a real defect:
  handoff docs carried url/title/ts only, agents had nothing to read, guessed
  `handoff_id`/`group`/`latest` values, and every guess answered
  `tab_unreachable`. The command examples now also name a `--tab` placeholder
  when no id could be resolved, instead of a bare op that fails `missing_tab`.

  The doc's CLI path has the same "known fact" standard applied to it: it is
  existence-checked at render time and prefers the runnable `dist/broker.cjs`
  over a `.ts` source (node refuses to type-strip under `node_modules`). A
  long-lived daemon keeps the `import.meta.dirname` of its startup process, so
  after an upgrade it must not name a file from the old layout — `/xfer doctor`
  and `/xfer broker status` warn when the live daemon's version differs from
  the install's, which is exactly that condition.
- No broadcast, not even opt-in: the web picker is not an agent and cannot
  answer intelligently for the wrong page. Shipping commit is marked
  breaking; no back-compat shim — the sole user upgrades everything together.

Considered and rejected: keeping latest-tab fallback for CLI compatibility
(covers a wrong fact with a vague one); an explicit `--broadcast` debug flag
(there is no legitimate audience for a blind fan-out).

Consequence: a page-tool call for a closed page fails loudly with the page's
title/url in the error; the agent stops and asks the human (HITL) instead of
retrying.
