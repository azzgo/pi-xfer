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
- The submit ack carries `routedTabId`; handoff docs state the originating
  tab. Agents read the tabId from there and pass `--tab` explicitly.
- No broadcast, not even opt-in: the web picker is not an agent and cannot
  answer intelligently for the wrong page. Shipping commit is marked
  breaking; no back-compat shim — the sole user upgrades everything together.

Considered and rejected: keeping latest-tab fallback for CLI compatibility
(covers a wrong fact with a vague one); an explicit `--broadcast` debug flag
(there is no legitimate audience for a blind fan-out).

Consequence: a page-tool call for a closed page fails loudly with the page's
title/url in the error; the agent stops and asks the human (HITL) instead of
retrying.
