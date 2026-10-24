import * as fs from "node:fs";
import * as path from "node:path";
import { XFER_DIR } from "../src/core/constants.ts";
import { encodeAgentName } from "../src/core/utils.ts";

/**
 * One received handoff as it sits in an adapter daemon's Inbox. The Inbox is a
 * JSONL file with take-to-read semantics (`take` atomically consumes lines);
 * there is no durable storage design behind it — a record is gone once read.
 */
export interface InboxRecord {
  id: string;
  from: string;
  to: string;
  summary: string;
  /** Path to the handoff document on this machine. */
  file: string;
  /** Document body captured at receive time; null when the file is unreadable. */
  document: string | null;
  transport: "local" | "mesh";
  received_at: string;
}

/** Inbox file for one adapter daemon name, derived from the same encoded name as its socket. */
export function inboxPathForName(name: string, dir: string = XFER_DIR): string {
  return path.join(dir, `${encodeAgentName(name)}.inbox.jsonl`);
}

/** Atomic single-record append. Called before any other deliver strategy runs. */
export function appendInbox(record: InboxRecord, inboxPath: string): void {
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(inboxPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
}

function parseInbox(content: string): InboxRecord[] {
  const records: InboxRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line) as InboxRecord);
  }
  return records;
}

/** Peek at every pending record; never consumes. Missing file → []. */
export function listInbox(inboxPath: string): InboxRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(inboxPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseInbox(content);
}

/**
 * Atomically consume every pending record. The Inbox is renamed out of the way
 * first, so a concurrent append (which recreates the path) lands in a fresh
 * file and is preserved rather than clobbered. Missing file → [].
 */
export function takeInbox(inboxPath: string): InboxRecord[] {
  const taken = `${inboxPath}.take-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.renameSync(inboxPath, taken);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return parseInbox(fs.readFileSync(taken, "utf-8"));
  } finally {
    fs.rmSync(taken, { force: true });
  }
}
