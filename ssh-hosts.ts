/**
 * ssh-hosts.ts — the two things `/xfer ssh` completion needs, both cheap enough
 * to run inside a synchronous completion call.
 *
 * 1. Host aliases, parsed from ~/.ssh/config (plus any `Include`d file at the
 *    usual relative path). No network, no subprocess.
 * 2. Remote socket names, served from a cache written whenever a probe or a
 *    Link actually reaches that host. Completion cannot probe: it is
 *    synchronous and an ssh round trip would freeze the TUI. A stale cache is
 *    harmless — a wrong suggestion is rejected by planSshUp, which reports the
 *    real available names.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Cache file holding `{ host: { names, at } }`; lives beside the Links. */
const CACHE_NAME = ".ssh-link-hosts.json";
/** Suggestions older than this are dropped rather than shown as fact. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Host aliases declared in an ssh config file, in file order, deduped. */
export function parseSshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      // `Host *` and wildcard patterns are matching rules, not destinations.
      if (!token || token.includes("*") || token.includes("?") || token.includes("!")) continue;
      if (!hosts.includes(token)) hosts.push(token);
    }
  }
  return hosts;
}

/** Aliases from ~/.ssh/config; missing or unreadable config is simply empty. */
export function listSshHosts(home = os.homedir()): string[] {
  const configPath = path.join(home, ".ssh", "config");
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    const dir = path.dirname(configPath);
    const included = [...text.matchAll(/^\s*include\s+(.+)$/gim)]
      .flatMap(m => m[1].split(/\s+/))
      .map(p => (path.isAbsolute(p) ? p : path.join(dir, p)))
      .filter(p => !p.includes("*"))
      .map(p => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } })
      .join("\n");
    return parseSshConfigHosts(`${text}\n${included}`);
  } catch {
    return [];
  }
}

interface HostCacheEntry {
  names: string[];
  at: number;
}

function cachePath(xferDir: string): string {
  return path.join(xferDir, CACHE_NAME);
}

function readCache(xferDir: string): Record<string, HostCacheEntry> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cachePath(xferDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, HostCacheEntry>;
  } catch {
    return {};
  }
}

/** Remember what a probe just found, so the next completion can offer it. */
export function rememberRemoteNames(xferDir: string, host: string, names: string[]): void {
  try {
    const cache = readCache(xferDir);
    cache[host] = { names, at: Date.now() };
    fs.mkdirSync(xferDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath(xferDir), `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch { /* completion sugar: never fail the command that triggered it */ }
}

/** Cached remote names for one host, or [] when absent/stale. */
export function cachedRemoteNames(xferDir: string, host: string, now = Date.now()): string[] {
  const entry = readCache(xferDir)[host];
  if (!entry || !Array.isArray(entry.names)) return [];
  if (now - entry.at > CACHE_TTL_MS) return [];
  return entry.names;
}

/** How long a cache entry is worth showing without a refresh attempt. */
const FRESH_MS = 60_000;

/**
 * Whether a background probe is worth starting for `host`: nothing cached, a
 * stale entry, or one older than the freshness window.
 */
export function wantsProbe(xferDir: string, host: string, now = Date.now()): boolean {
  const entry = readCache(xferDir)[host];
  if (!entry || !Array.isArray(entry.names)) return true;
  return now - entry.at > FRESH_MS;
}

/** Hosts we have ever probed — suggestions even without an ssh config alias. */
export function cachedHosts(xferDir: string, now = Date.now()): string[] {
  return Object.entries(readCache(xferDir))
    .filter(([, entry]) => Array.isArray(entry.names) && now - entry.at <= CACHE_TTL_MS)
    .map(([host]) => host);
}

/**
 * In-flight background probes, keyed by host.
 *
 * Completion runs on every keystroke, so without this a user typing a host name
 * would spawn one ssh per character: they compete for the same connection,
 * each holds a slot for up to 15s, and the last one to finish wins the cache —
 * possibly with an older answer than one already written. One probe per host at
 * a time, and a second request joins the first instead of stacking up.
 */
const inflight = new Map<string, Promise<string[]>>();

/**
 * Kick off a probe for `host` unless one is already running; returns the shared
 * promise. Callers must not await this from a completion path — completion is
 * synchronous and must never block on the network.
 */
export function prefetchRemoteNames(
  xferDir: string,
  host: string,
  probe: (host: string) => Promise<{ names: string[] }>,
): Promise<string[]> {
  const running = inflight.get(host);
  if (running) return running;

  const task = probe(host)
    .then(({ names }) => {
      rememberRemoteNames(xferDir, host, names);
      return names;
    })
    .catch(() => cachedRemoteNames(xferDir, host))
    .finally(() => { inflight.delete(host); });

  inflight.set(host, task);
  return task;
}

/** True while a background probe for `host` is running (for the completion hint). */
export function isPrefetching(host: string): boolean {
  return inflight.has(host);
}
