# Web picker captures human-operated records, not agent replays

Status: accepted

## Context

The web-picker loop hands the agent static Pick markers; some bugs only show
themselves through dynamic before/after behavior across a short operation
sequence. We considered having the agent replay operations itself — e.g.
replaying a Chrome DevTools Recorder export (Puppeteer script or translated
`page-tool` calls) — and decided against any replay path.

Replay runs against the wrong environment: an agent-driven Puppeteer browser
is not the user's live tab, so it loses the web-picker connection, login
state, and every observability hook, and each "suspect" it finds still has to
be re-reproduced in the real tab. Even replaying `page-tool` steps on the
live tab re-derives evidence the human already produced, and inherits
Recorder's own artifacts (forced page refresh, selector drift). The human
reproducing the problem by hand is the highest-fidelity executor available.

## Decision

The picker gains a **Record mode**: the user marks a start, operates the page
freely, marks a stop; the picker captures the timeline of core actions
(click, field-level input, SPA route change, commits) plus scene data sliced
from the existing console/network ring buffers, and submits the whole span as
one marker sequence. No replay step exists — the human operation IS the
evidence. Details in `pi/agent/extensions/xfer/docs/web-picker.md`
("Planned: Record mode").

## Consequences

- Recording SSE/long-poll traffic requires `netRing` to log *pending*
  requests (today it only records completed ones), so the agent can
  reverse-query live streams via `network.log`.
- The `record` field on `annotation.submit` is additive — no new frame type,
  broker unchanged.
- Cross-origin navigation deliberately breaks a Record (sessionStorage is
  per-origin); cross-origin reproduction is out of scope until a real need
  appears.
