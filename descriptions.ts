/**
 * Durable node-description store: `<xferDir>/descriptions.json`.
 *
 * A description outlives its pi process — unlike the `<name>.json` metadata,
 * which `/xfer gc` reaps together with the zombie socket. Each entry carries an
 * `updatedAt` stamp refreshed while the owning process runs; gc prunes entries
 * whose stamp is older than {@link DESCRIPTION_TTL_MS}, so the store is
 * "longer than a process, but not forever".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DESCRIPTION_TTL_MS, XFER_DIR } from "./constants.ts";

/** Store file name; also the gc skip-list key. */
export const DESCRIPTIONS_FILE = "descriptions.json";

interface DescriptionEntry {
  text: string;
  updatedAt: number;
}

type DescriptionStore = Record<string, DescriptionEntry>;

function storePath(xferDir: string = XFER_DIR): string {
  return path.join(xferDir, DESCRIPTIONS_FILE);
}

function loadStore(xferDir: string): DescriptionStore {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(storePath(xferDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as DescriptionStore;
  } catch {
    return {};
  }
}

function saveStore(xferDir: string, store: DescriptionStore): void {
  try {
    fs.mkdirSync(xferDir, { recursive: true });
    const temp = `${storePath(xferDir)}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, storePath(xferDir));
  } catch { /* best effort */ }
}

/** Set or clear (empty text) one node's description, stamping it as of now. */
export function setStoredDescription(name: string, text: string, xferDir: string = XFER_DIR): void {
  const store = loadStore(xferDir);
  const trimmed = text.trim();
  if (trimmed) store[name] = { text: trimmed, updatedAt: Date.now() };
  else delete store[name];
  saveStore(xferDir, store);
}

/** Read one node's description; undefined when absent. */
export function getStoredDescription(name: string, xferDir: string = XFER_DIR): string | undefined {
  const entry = loadStore(xferDir)[name];
  return entry?.text.trim() || undefined;
}

/** Refresh the timestamp (not the text) — the "this process is still alive" signal. */
export function touchStoredDescription(name: string, xferDir: string = XFER_DIR): void {
  const store = loadStore(xferDir);
  if (!store[name]) return;
  store[name].updatedAt = Date.now();
  saveStore(xferDir, store);
}

/** Drop entries not touched within `ttlMs`; returns the pruned names. */
export function pruneStoredDescriptions(ttlMs: number, xferDir: string = XFER_DIR, now = Date.now()): string[] {
  const store = loadStore(xferDir);
  const pruned = Object.entries(store)
    .filter(([, entry]) => now - entry.updatedAt > ttlMs)
    .map(([name]) => name);
  if (pruned.length === 0) return [];
  for (const name of pruned) delete store[name];
  saveStore(xferDir, store);
  return pruned;
}
