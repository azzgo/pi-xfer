/**
 * Pure markdown renderer for the web-annotation handoff doc (Wayfinder ticket
 * 007 skeleton, goal 027). No I/O — the `annotation.submit` handler writes the
 * returned string to `os.tmpdir()/pi-xfer-<msg_id>.md`.
 *
 * Picks follow the picker.js `payloadFor()` schema (protocol v0):
 * `{selector, xpath, tagName, textPreview, rect, note, ts, url, source}` —
 * only the fields the ticket names for the doc are rendered; `tagName`, per-pick
 * `ts`/`url` ride along in the type for schema fidelity.
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
  /** Asking session's xfer name/socket; substituted into the ask-page example when present. */
  fromTarget?: string;
}

/**
 * Fixed follow-up channel section (Wayfinder 009 decision: doc-embedded prompt
 * section, not a skill). Kept ≤10 lines — the bloat criterion for spinning it
 * into a skill stays in force.
 */
function followUpSection(fromTarget: string | undefined): string[] {
  const target = fromTarget?.trim() ? fromTarget.trim() : "<session-socket>";
  return [
    "## Follow-up channel",
    "",
    "The sending browser tab is still online. Ask it questions via the broker CLI — the command returns a request_id immediately; keep working instead of waiting for the answer:",
    `\`node broker-main.ts ask-page ${target} "<question>"\``,
    "The answer arrives as an xfer-notify frame pushed to this session, carrying the request_id and the original question (a timeout arrives as a notify frame too — treat the handoff as one-way then). Multiple questions may be issued in parallel.",
  ];
}

/** `- name: value` line, without a trailing space when value is empty. */
function field(name: string, value: string): string {
  return `- ${name}: ${value}`.trimEnd();
}

function pickSection(pick: HandoffPick): string[] {
  const lines = [
    `### ${pick.selector}`,
    "",
    field("xpath", pick.xpath),
    field("text", pick.textPreview ?? ""),
    field("rect", `x=${pick.rect.x} y=${pick.rect.y} w=${pick.rect.w} h=${pick.rect.h}`),
    field("note", pick.note ?? ""),
  ];
  if (pick.source) lines.push(field("source", `${pick.source.file}:${pick.source.line}`));
  lines.push("");
  return lines;
}

/** Render the ticket-007 handoff doc skeleton as a markdown string (trailing newline). */
export function renderHandoffDoc({ msgId, prompt, page, picks, fromTarget }: RenderHandoffDocInput): string {
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
  lines.push(...followUpSection(fromTarget), "");
  lines.push("---", "", "from: web-picker", `handoff_id: ${msgId}`);
  return lines.join("\n") + "\n";
}
