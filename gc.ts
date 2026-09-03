/**
 * Zombie socket GC for the xfer peer directory.
 *
 * A peer that exits without running `controller.shutdown()` (crash, kill -9,
 * closed terminal) leaves `<name>.sock` + `<name>.json` behind in the xfer
 * dir. `/xfer gc` reaps those leftovers:
 *
 *   1. `<name>.json` readable, `pid` dead (`kill(pid, 0)` → ESRCH)  → remove both
 *   2. `<name>.json` missing/unreadable/pid-less, and nothing is
 *      listening on the sock (connect → ECONNREFUSED)              → remove both
 *   3. orphan `.sock` with no `.json` and no listener               → remove sock
 *   4. anything ambiguous (EPERM, connect timeout, odd errors)      → keep
 *
 * `broker.*` and `settings.json` are never touched. Note: pid reuse can make
 * a dead peer look alive; the worst case is a leftover that gc skips — never
 * a live peer getting reaped.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export type GcReason = "dead-pid" | "orphan-sock" | "unreadable-json";

export interface GcZombie {
  /** Encoded peer name (socket file stem). */
  name: string;
  sockPath: string;
  jsonPath?: string;
  pid?: number;
  reason: GcReason;
}

export interface GcReport {
  zombies: GcZombie[];
  /** Peer names that looked alive and were kept. */
  alive: string[];
}

/** Broker + settings files that live in the xfer dir but are not peer metadata. */
const GC_SKIP_JSON = new Set(["broker.json", "settings.json"]);

/** True when `pid` refers to a live process; ambiguous errors count as live. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM = exists but not ours; anything else — keep
  }
}

/**
 * True when something accepts connections on the unix socket at `sockPath`.
 * ECONNREFUSED (no listener), ENOENT and ENOTSOCK (not a socket at all) mean
 * nothing is behind the file; every other outcome — including timeout — is
 * treated as listening so gc stays conservative.
 */
export function socketHasListener(sockPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const conn = net.connect({ path: sockPath });
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    timer.unref?.();
    conn.once("connect", () => finish(true));
    conn.once("error", (err: NodeJS.ErrnoException) => {
      const dead = err.code === "ECONNREFUSED" || err.code === "ENOENT" || err.code === "ENOTSOCK";
      finish(!dead);
    });
  });
}

/** Find zombie peers in `xferDir` without deleting anything. */
export async function planGc(xferDir: string): Promise<GcReport> {
  const zombies: GcZombie[] = [];
  const alive: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(xferDir, { withFileTypes: true });
  } catch {
    return { zombies, alive };
  }

  const jsonStems = new Set<string>();
  const sockStems = new Set<string>();
  for (const entry of entries) {
    // NB: no isFile() filter — unix sockets are S_IFSOCK specials, so a real
    // `<name>.sock` reports isFile() === false and would be skipped.
    if (entry.isFile() && entry.name.endsWith(".json") && !GC_SKIP_JSON.has(entry.name)) {
      jsonStems.add(entry.name.slice(0, -".json".length));
    } else if (entry.name.endsWith(".sock")) {
      sockStems.add(entry.name.slice(0, -".sock".length));
    }
  }

  for (const stem of jsonStems) {
    const jsonPath = path.join(xferDir, `${stem}.json`);
    const sockPath = path.join(xferDir, `${stem}.sock`);
    let pid: number | undefined;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const candidate = (raw as Record<string, unknown> | null)?.pid;
      if (typeof candidate === "number") pid = candidate;
    } catch { /* handled below */ }

    if (pid === undefined) {
      // Metadata is unusable — only reap when nothing is listening on the sock.
      if (fs.existsSync(sockPath) && !(await socketHasListener(sockPath))) {
        zombies.push({ name: stem, sockPath, jsonPath, reason: "unreadable-json" });
      } else {
        alive.push(stem);
      }
      continue;
    }

    if (!processAlive(pid)) {
      zombies.push({ name: stem, sockPath, jsonPath, pid, reason: "dead-pid" });
    } else {
      alive.push(stem);
    }
  }

  for (const stem of sockStems) {
    if (jsonStems.has(stem)) continue; // already handled with its metadata
    const sockPath = path.join(xferDir, `${stem}.sock`);
    if (await socketHasListener(sockPath)) {
      alive.push(stem); // live peer; metadata just not written yet
      continue;
    }
    zombies.push({ name: stem, sockPath, reason: "orphan-sock" });
  }

  return { zombies, alive };
}

/** Reap every zombie found by `planGc`; returns the report (paths already removed). */
export async function collectGarbage(xferDir: string): Promise<GcReport> {
  const report = await planGc(xferDir);
  for (const zombie of report.zombies) {
    try { fs.unlinkSync(zombie.sockPath); } catch { /* already gone */ }
    if (zombie.jsonPath) {
      try { fs.unlinkSync(zombie.jsonPath); } catch { /* already gone */ }
    }
  }
  return report;
}
