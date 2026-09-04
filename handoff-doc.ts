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

/** `page` block of the `annotation.submit` payload. */
export interface HandoffPageInfo {
  url: string;
  title: string;
  ts: number;
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

/** Arguments for {@link renderHandoffDoc}. */
export interface RenderHandoffDocInput {
  /** Handoff/ack id; becomes the doc's `handoff_id` footer value. */
  msgId: string;
  /** User prompt, rendered verbatim (multiline preserved). */
  prompt: string;
  page: HandoffPageInfo;
  picks: readonly HandoffPick[];
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
function followUpSection(fromTarget: string | undefined, brokerCliPath: string | undefined): string[] {
  const target = fromTarget?.trim() ? fromTarget.trim() : "<session-socket>";
  const cli = brokerCliPath?.trim() ? brokerCliPath.trim() : "broker-main.ts";
  return [
    "## Follow-up channel",
    "",
    "The sending browser tab is still online. Collect page data by calling its fixed tool ops via the broker CLI — the command waits and prints the result JSON on stdout:",
    `\`node ${cli} page-tool ${target} <op> [paramsJSON]\``,
    "Ops (fixed read-only table): page.info · dom.query {selector, maxCount?, styleProps?} · dom.html {selector?, maxLength?, maxDepth?} · console.logs {lastN?, sinceTs?, level?} · network.log {lastN?, urlFilter?} · framework.inspect {selector, props?, maxDepth?}. Example:",
    `\`node ${cli} page-tool ${target} dom.query '{"selector":"button.primary","maxCount":5}'\``,
    "A timeout or no_tabs exits 1 with an error on stderr — treat the handoff as one-way then. Multiple calls may be issued in parallel.",
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

/** Render the ticket-007 handoff doc skeleton as a markdown string (trailing newline). */
export function renderHandoffDoc({ msgId, prompt, page, picks, fromTarget, brokerCliPath }: RenderHandoffDocInput): string {
  const lines: string[] = [
    "# Web annotation handoff",
    "",
    "## Request",
    "",
    prompt,
    "",
    "## Page",
    "",
    field("url", page.url),
    field("title", page.title),
    field("ts", `${page.ts} (${new Date(page.ts).toISOString()})`),
    "",
    "## Annotations",
    "",
  ];
  for (const pick of picks) lines.push(...pickSection(pick));
  lines.push(...followUpSection(fromTarget, brokerCliPath), "");
  lines.push("---", "", "from: web-picker", `handoff_id: ${msgId}`);
  return lines.join("\n") + "\n";
}
