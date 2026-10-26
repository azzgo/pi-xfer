/**
 * Pure markdown renderer for the web-annotation handoff doc (Wayfinder ticket
 * 007 skeleton, goal 027). No I/O — the `annotation.submit` handler writes the
 * returned string to `os.tmpdir()/pi-xfer-<msg_id>.md`.
 *
 * Picks follow the picker.js `payloadFor()` schema (protocol v0):
 * `{selector, xpath, tagName, textPreview, rect, note, ts, url, source}` —
 * only the fields the ticket names for the doc are rendered; `tagName`, per-pick
 * `ts`/`url` ride along in the type for schema fidelity. web-picker v1.5 adds an
 * optional `group` id that links all picks submitted as one shift-group; it is
 * rendered on the members that carry it and stays absent on solo picks.
 */

import { formatHandoffKind } from "./handoff-kind.ts";
import { FROM_WEB_PICKER } from "./wire.ts";
/** `page` block of the `annotation.submit` payload. */
export interface HandoffPageInfo {
  url: string;
  title: string;
  ts: number;
  /**
   * Page-lifetime tab id of the submitting tab (the broker resolves it from the
   * live connection, not from the frame). Rendered into the doc so `--tab` is
   * read rather than guessed — ADR-0022.
   */
  tabId?: string;
}

/** Dev-build source mapping attached to a pick (`payloadFor().source`). */
export interface HandoffPickSource {
  framework: string;
  component: string;
  file: string;
  line: number;
  column: number;
}

/** One pick, matching the picker.js `payloadFor()` schema (ticket 007). */
export interface HandoffPick {
  selector: string;
  xpath: string;
  tagName?: string;
  textPreview?: string;
  rect: { x: number; y: number; w: number; h: number };
  note?: string;
  /** web-picker v1.5 shift-group: shared id on every member of one group (absent on solo picks). */
  group?: string;
  /** web-picker v1.6: element attribute key/value pairs (values pre-truncated by the picker). */
  attributes?: Record<string, string>;
  ts?: number;
  url?: string;
  source?: HandoffPickSource | null;
}

/** One recorded action inside a Record-mode timeline (`record.events[]`). */
export interface HandoffRecordEvent {
  /** 1-based order within the record. */
  seq: number;
  /** Milliseconds from the record's start. */
  t: number;
  kind: string;
  sel?: string;
  text?: string;
  /** Final field value for `input` events (passwords pre-masked by the picker). */
  value?: string;
  key?: string;
  from?: string;
  to?: string;
  /** 1-based index into `picks[]` when the event's selector matches a submitted pick. */
  ref?: number;
}

/** One ring-buffer entry as captured (`console`/`net` are start-time slices). */
export interface HandoffRecordConsoleEntry { level?: string; text?: string; ts?: number; }
export interface HandoffRecordNetEntry {
  method?: string;
  url?: string;
  status?: number | string;
  durationMs?: number;
  ts?: number;
  pending?: boolean;
  kind?: string;
  msgs?: number;
  error?: string;
}

/**
 * web-picker v1.13 Record mode: one human-operated capture span — the temporal
 * marker sequence. Events group by `record`-less containment (the whole object
 * IS one sequence); console/net are the always-on rings sliced to the window.
 */
export interface HandoffRecord {
  id: string;
  start: number;
  end?: number;
  url0?: string;
  url1?: string;
  events: HandoffRecordEvent[];
  console?: HandoffRecordConsoleEntry[];
  net?: HandoffRecordNetEntry[];
}

/** Arguments for {@link renderHandoffDoc}. */
export interface RenderHandoffDocInput {
  /** Handoff/ack id; becomes the doc's `handoff_id` footer value. */
  msgId: string;
  /** User prompt, rendered verbatim (multiline preserved). */
  prompt: string;
  page: HandoffPageInfo;
  picks: readonly HandoffPick[];
  /** Optional Record-mode timeline (v1.13); rendered as its own section when present. */
  record?: HandoffRecord;
  /** Asking session's xfer name/socket; substituted into the page-tool example when present. */
  fromTarget?: string;
  /**
   * Absolute path to the broker CLI entry (broker-main.ts). The receiving agent
   * has no way to discover this otherwise — always pass it so the doc carries a
   * runnable command instead of a filename the agent would have to find.
   */
  brokerCliPath?: string;
}

/**
 * Fixed follow-up channel section (Wayfinder 009 decision: doc-embedded prompt
 * section, not a skill). Kept ≤10 lines — the bloat criterion for spinning it
 * into a skill stays in force.
 */
function followUpSection(fromTarget: string | undefined, brokerCliPath: string | undefined, tabId: string | undefined): string[] {
  const target = fromTarget?.trim() ? fromTarget.trim() : "<session-socket>";
  const cli = brokerCliPath?.trim() ? brokerCliPath.trim() : "daemon/broker-main.ts";
  // The tabId is named in the `## Page` section; when the caller could not
  // resolve it, the command carries a placeholder instead of a bare op that
  // would fail with missing_tab.
  const tab = tabId?.trim() ? tabId.trim() : "<tabId from the page section>";
  return [
    "## Follow-up channel",
    "",
    "Collect page data by calling the originating tab's fixed tool ops via the broker CLI. Every call names that tab with `--tab`; the command waits and prints the result JSON on stdout:",
    `\`node ${cli} page-tool ${target} <op> [paramsJSON] --tab ${tab}\``,
    "Ops (fixed table): page.info · dom.query {selector, maxCount?, styleProps?} · dom.html {selector?, maxLength?, maxDepth?} · console.logs {lastN?, sinceTs?, level?} · network.log {lastN?, urlFilter?} · framework.inspect {selector, props?, maxDepth?} · page.wait {selector} (read) · dom.click {selector} / dom.setValue {selector, value} (write — only when the origin has page-write authorization; a refusal answers denied_op). Example:",
    `\`node ${cli} page-tool ${target} dom.query '{"selector":"button.primary","maxCount":5}' --tab ${tab}\``,
    "A timeout exits 1 with an error on stderr — after a page reload wait a few seconds for the userscript auto-reconnect and retry (≤3 times). `missing_tab` means `--tab` was left off — read it from the Page section, never guess. `tab_unreachable` means that page is closed: do NOT retry, stop and ask the human to reopen it. Multiple calls may be issued in parallel. After changing code, verify by re-querying: dom.query the target elements and check console.logs for new errors.",
  ];
}

/** `- name: value` line, without a trailing space when value is empty. */
function field(name: string, value: string): string {
  return `- ${name}: ${value}`.trimEnd();
}

/** `attrs` line: `key="value"` pairs (empty values render as bare keys), or null when absent. */
function attrsField(pick: HandoffPick): string | null {
  if (!pick.attributes) return null;
  const entries = Object.entries(pick.attributes).slice(0, 20);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => (value ? `${key}="${value}"` : key)).join(" ");
}

function pickSection(pick: HandoffPick): string[] {
  const lines = [
    `### ${pick.selector}`,
    "",
    field("xpath", pick.xpath),
    field("text", pick.textPreview ?? ""),
  ];
  const attrs = attrsField(pick);
  if (attrs) lines.push(field("attrs", attrs));
  lines.push(
    field("rect", `x=${pick.rect.x} y=${pick.rect.y} w=${pick.rect.w} h=${pick.rect.h}`),
    field("note", pick.note ?? ""),
  );
  if (pick.group) lines.push(field("group", pick.group));
  if (pick.source) lines.push(field("source", `${pick.source.file}:${pick.source.line}`));
  lines.push("");
  return lines;
}

/** One timeline event line: `+140ms click #login-btn — "login"` (+ value / ref). */
function recordEventLine(ev: HandoffRecordEvent): string {
  const parts = [`+\`${ev.t}ms\``, `\`${ev.kind}\``];
  if (ev.sel) parts.push(`\`${ev.sel}\``);
  if (ev.kind === "input" && ev.value !== undefined) parts.push(`value=\`${ev.value}\``);
  if (ev.kind === "key" && ev.key) parts.push(`key=\`${ev.key}\``);
  if (ev.kind === "nav" && ev.to) parts.push(`→ ${ev.to}`);
  if (ev.text) parts.push(`— "${ev.text}"`);
  if (ev.ref) parts.push(`(pick #${ev.ref})`);
  return `- ${parts.join(" ")}`;
}

/** Cap the scene slices so one record cannot blow the 1MB frame budget. */
const RECORD_SCENE_MAX = 40;

function recordSection(rec: HandoffRecord): string[] {
  const lines = [
    "## Operation timeline",
    "",
    field("record", rec.id),
    field(
      "span",
      `${rec.start}${rec.end ? ` → ${rec.end}` : ""} (${new Date(rec.start).toISOString()}${rec.end ? ` → ${new Date(rec.end).toISOString()}` : ""})`,
    ),
    field("url", rec.url1 && rec.url1 !== rec.url0 ? `${rec.url0} → ${rec.url1}` : (rec.url0 ?? "")),
    "",
    "The user reproduced the problem by hand while the picker recorded. Events are ordered (`seq`) with millisecond offsets (`t`); `input` values are final field values (passwords masked).",
    "",
    ...rec.events.map(recordEventLine),
    "",
  ];
  if (rec.net && rec.net.length) {
    lines.push("### Network (window slice)", "");
    for (const n of rec.net.slice(-RECORD_SCENE_MAX)) {
      const status = n.pending ? "pending" : String(n.status ?? "?");
      const sse = n.kind === "sse" ? ` sse${n.msgs !== undefined ? ` msgs=${n.msgs}` : ""}` : "";
      const dur = n.durationMs !== undefined ? ` ${n.durationMs}ms` : "";
      lines.push(`- ${n.method ?? "?"} ${n.url ?? "?"} → ${status}${sse}${dur}${n.error ? ` error="${n.error}"` : ""}`);
    }
    lines.push("");
  }
  if (rec.console && rec.console.length) {
    lines.push("### Console (window slice)", "");
    for (const c of rec.console.slice(-RECORD_SCENE_MAX)) {
      lines.push(`- [${c.level ?? "log"}] ${c.text ?? ""}`);
    }
    lines.push("");
  }
  return lines;
}

/** Render the ticket-007 handoff doc skeleton as a markdown string (trailing newline). */
export function renderHandoffDoc({ msgId, prompt, page, picks, record, fromTarget, brokerCliPath }: RenderHandoffDocInput): string {
  const lines: string[] = [
    "# Web annotation handoff",
    "",
    // A submit is a Task: it asks for output. Its reply channel is the
    // follow-up section below, not a reverse xfer — the sender is a browser.
    formatHandoffKind("task"),
    "",
    "## Request",
    "",
    prompt,
    "",
    "## Page",
    "",
    field("url", page.url),
    field("title", page.title),
    // Only when the broker resolved the live connection's tab: an absent id is
    // an absent line, never an empty or guessed one (ADR-0022).
    ...(page.tabId ? [field("tabId", page.tabId)] : []),
    field("ts", `${page.ts} (${new Date(page.ts).toISOString()})`),
    "",
    "## Annotations",
    "",
  ];
  for (const pick of picks) lines.push(...pickSection(pick));
  if (record) lines.push(...recordSection(record));
  lines.push(...followUpSection(fromTarget, brokerCliPath, page.tabId), "");
  lines.push(
    "---",
    "",
    // Identity note: the sender is never a replyable xfer peer — point the
    // agent at the page-tool channel instead of an xfer_to that cannot succeed.
    `from: ${FROM_WEB_PICKER} (browser userscript — not an agent, no reply socket; query the page via the Follow-up channel above)`,
    `handoff_id: ${msgId}`,
  );
  return lines.join("\n") + "\n";
}

/** Arguments for {@link renderBagHandoffDoc} (bag.submit, staging bag). */
export interface RenderBagHandoffDocInput {
  msgId: string;
  prompt: string;
  /** The whole Bag, already ordered by staging time; grouped by page here. */
  items: ReadonlyArray<{
    tabId: string;
    origin: string;
    url: string;
    title: string;
    pick: HandoffPick;
    ts: number;
  }>;
  fromTarget?: string;
  brokerCliPath?: string;
}

/**
 * bag.submit's doc: one section per page (url+title), the page header carrying
 * the Provenance the agent needs for `page-tool --tab` follow-ups. Follow-ups
 * for a page whose tab is gone fail with tab_unreachable — the agent must stop
 * and ask the human (ADR-0022); the routing note below says so up front.
 */
export function renderBagHandoffDoc({ msgId, prompt, items, fromTarget, brokerCliPath }: RenderBagHandoffDocInput): string {
  const pages = new Map<string, typeof items>();
  for (const item of items) {
    const key = `${item.url}|${item.title}`;
    if (!pages.has(key)) pages.set(key, []);
    pages.get(key)!.push(item);
  }
  const lines: string[] = [
    "# Web annotation handoff (staging bag)",
    "",
    formatHandoffKind("task"),
    "",
    "## Request",
    "",
    prompt,
    "",
    field("pages", String(pages.size)),
    field("markers", String(items.length)),
    "",
    "## Annotations (grouped by page)",
    "",
  ];
  for (const [key, group] of pages) {
    void key;
    const first = group[0]!;
    lines.push(
      `## Page: ${first.title || first.url}`,
      "",
      field("url", first.url),
      field("origin", first.origin),
      field("tabId", first.tabId),
      field("staged", `${group.length} marker(s)`),
      "",
    );
    for (const item of group) lines.push(...pickSection(item.pick));
  }
  lines.push(
    "## Routing",
    "",
    `Every page section above carries its tabId. Follow up with \`page-tool <target> <op> --tab <tabId>\` — tabIds come from this doc, never guessed. If a call answers tab_unreachable, that page is closed: do NOT retry — stop and ask the human to reopen the page (title/url above) or reconnect the picker. Staged markers may come from pages other than the one this bag was sent from.`,
    "",
  );
  lines.push(...followUpSection(fromTarget, brokerCliPath, undefined), "");
  lines.push(
    "---",
    "",
    `from: ${FROM_WEB_PICKER} (browser userscript — not an agent, no reply socket; query the page via the Follow-up channel above)`,
    `handoff_id: ${msgId}`,
  );
  return lines.join("\n") + "\n";
}
