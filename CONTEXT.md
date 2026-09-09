# Xfer Web Picker — Language

Glossary for the web-picker loop (userscript + broker + receiving agent). Implementation details live in `docs/web-picker.md`; this file only fixes terms.

## Language

**Marker**:
The common shape of everything the picker hands to the agent: a lightweight pointer at something on the page (an element, an action) plus human-written or captured context. The agent is *pulled into understanding* by markers, not by dumps.
_Avoid_: annotation dump, full DOM snapshot, payload

**Pick**:
A static marker — "look at this element". A selected element with selector/tag/text and an optional note, optionally aggregated into a `group`.
_Avoid_: selection, highlight, annotation (too vague next to the handoff document)

**Record**:
A temporal marker sequence — "this is what I did and what happened". One user-operated capture span (start → stop) holding ordered events with time offsets plus the console/network scene data sliced over the same window. The record object is itself the sequence; it rides a submit the way picks do, as the temporal analogue of a pick's `group`.
_Avoid_: replay, recording session, log (it is a bounded, hand-curated capture, not a log stream)

**Scene Data**:
The always-on ring-buffer captures (console entries, network requests) sliced to a Record's time window and attached to it. Not new collection — a view over existing capture.
_Avoid_: telemetry, logs, tracing output

**Handoff**:
The rendered document a submit delivers to a target session. Picks and Records are sections in it; both are markers at different axes (space vs time).
_Avoid_: prompt, message, report
