/**
 * Handoff Kind — the sender's declaration of what a handoff is *for*, carried
 * as one machine-readable header line:
 *
 *   kind: task | notification
 *
 * `task` asks the target for output: it comes back with exactly one conclusion
 * (done, blocked, or needing input). `notification` informs and stays silent —
 * the target sends a reverse handoff only when it lacks information, or when
 * the document conflicts with fact.
 *
 * The sending tool stamps the line from a required parameter, so a handoff
 * never depends on the model writing the header itself; when a doc carries a
 * hand-written line the tool's value replaces it. A doc with no line is a
 * `notification`.
 *
 * The sending tool stamps the line from a required parameter, so a handoff
 * never depends on the model writing the header itself; when a doc carries a
 * hand-written line the tool's value replaces it.
 */
import * as fs from "node:fs";

/** What a handoff asks of its target. */
export type HandoffKind = "task" | "notification";

/** What a doc with no `kind:` header line reads as. */
export const DEFAULT_HANDOFF_KIND: HandoffKind = "notification";

/** Header-line grammar: anchored, case-insensitive, whitespace-tolerant. */
const KIND_LINE = /^kind:[ \t]*(task|notification)[ \t]*$/i;

/** Every `kind:` header line in a doc, wherever it sits, one per source line. */
const ANY_KIND_LINE = /^[ \t]*kind:[ \t]*(?:task|notification)[ \t]*$/gim;

/** Enough head bytes to cover any header line; the doc body is never read. */
const HEAD_CHUNK_BYTES = 4096;

/** The canonical header line for a kind. */
export function formatHandoffKind(kind: HandoffKind): string {
  return `kind: ${kind}`;
}

/** Parse the first `kind:` header line out of a doc; the default when absent. */
export function parseHandoffKind(document: string): HandoffKind {
  for (const line of document.split("\n")) {
    const match = KIND_LINE.exec(line.trim());
    if (match) return match[1]!.toLowerCase() as HandoffKind;
  }
  return DEFAULT_HANDOFF_KIND;
}

/** Read a doc's Kind from disk; the default when unreadable or unmarked. */
export function readHandoffKind(file: string): HandoffKind {
  const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
    return parseHandoffKind(chunk.subarray(0, read).toString("utf-8"));
  } catch {
    return DEFAULT_HANDOFF_KIND;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * Replace every `kind:` header line with the canonical one, placed directly
 * under the cwd stamp (or first, unstamped) so the reader — which takes the
 * first match in the doc head — always sees the sender's declaration.
 */
export function stampHandoffKind(document: string, kind: HandoffKind): string {
  const lines = document
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !KIND_LINE.test(line.trim()));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  const stamped = lines.length > 0 && /^<!--\s*xfer:sender-cwd\b/.test(lines[0]!.trim());
  lines.splice(stamped ? 1 : 0, 0, formatHandoffKind(kind));
  return lines.join("\n");
}
