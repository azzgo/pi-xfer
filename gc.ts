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

export type GcReason = "dead-pid" | "orphan-sock" | "unreadable-json" | "dead-link";

export interface GcZombie {
  /** Encoded peer name (socket file stem). */
  name: string;
  sockPath: string;
  jsonPath?: string;
  pid?: number;
  reason: GcReason;
  /** Set for a reaped ssh Link: rebuild hint for the gc output (ADR-0021). */
  linkHost?: string;
  /**
   * Found but not ours to delete (a `role: reverse` marker). Its owner is a pi
   * on another machine, so `collectGarbage` only reports it.
   */
  reportOnly?: boolean;
  /** Sockets a Link ledger declares; all are dead once its ssh process is. */
  ownedSockets?: string[];
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
  const linkLedgers: string[] = [];
  for (const entry of entries) {
    // NB: no isFile() filter — unix sockets are S_IFSOCK specials, so a real
    // `<name>.sock` reports isFile() === false and would be skipped.
    if (entry.isFile() && entry.name.startsWith(".link.") && entry.name.endsWith(".json")) {
      // Our own Link ledger (ADR-0021): keyed by host, judged in its own pass.
      linkLedgers.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".json") && !GC_SKIP_JSON.has(entry.name)) {
      jsonStems.add(entry.name.slice(0, -".json".length));
    } else if (entry.name.endsWith(".sock")) {
      sockStems.add(entry.name.slice(0, -".sock".length));
    }
  }

  for (const stem of jsonStems) {
    const jsonPath = path.join(xferDir, `${stem}.json`);
    const sockPath = path.join(xferDir, `${stem}.sock`);
    let pid: number | undefined;
    let linkHost: string | undefined;
    let reverseMarker = false;
    let importMarker = false;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const rec = raw as Record<string, unknown> | null;
      const candidate = rec?.pid;
      if (typeof candidate === "number") pid = candidate;
      if (rec?.via === "ssh" && typeof rec.host === "string") linkHost = rec.host;
      reverseMarker = rec?.role === "reverse";
      importMarker = rec?.role === "import";
    } catch { /* handled below */ }

    if (importMarker && !reverseMarker) {
      // An `import` record is written by THIS machine for a socket it brought
      // in over a Link. It has no pid for the same reason a reverse marker has
      // none — the process lives on the other machine — so liveness is the
      // socket's own: ours is a plain endpoint that goes silent when the tunnel
      // dies. Unlike a reverse marker, this one IS ours to clear.
      if (!(await socketHasListener(sockPath))) {
        zombies.push({ name: stem, sockPath, jsonPath, reason: "dead-link" });
      } else {
        alive.push(stem);
      }
      continue;
    }

    if (reverseMarker) {
      // A reverse marker (ADR-0021) is written BY the other machine and carries
      // no pid on purpose: the landing socket here is an sshd endpoint, so the
      // only honest signal is whether anything still answers behind it. A dead
      // tunnel leaves the file connectable but silent — that is what the
      // listener probe distinguishes, unlike an `in` Link's own ledger.
      // It belongs to a pi on the other machine, and this machine cannot observe
      // whether that pi lives: the endpoint may answer, refuse, or linger as the
      // tunnel flaps. Deleting it here once erased a live Link's record and
      // silently downgraded every later send to a path the receiver could not
      // read. So: report, never delete — its writer removes it on teardown.
      zombies.push({ name: stem, sockPath, jsonPath, reason: "dead-link", linkHost, reportOnly: true });
      continue;
    }

    if (linkHost !== undefined) {
      // This machine's own Link ledger (ADR-0021): the ssh process is the only
      // honest signal — a local endpoint always accepts connections, so probing
      // the socket would call a dead tunnel alive. gc reaps the files; the
      // process is `in`/`down`'s business.
      if (pid !== undefined && !processAlive(pid)) {
        zombies.push({ name: stem, sockPath, jsonPath, pid, reason: "dead-link", linkHost });
      } else {
        alive.push(stem);
      }
      continue;
    }

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

  // A Link ledger declares the sockets it owns, so it judges them: a dead ssh
  // process means every socket it created here is dead, even though the files
  // still look connectable on disk. Runs before the generic socket pass so those
  // sockets are not also reported as orphan-sock.
  const claimedByLink = new Set<string>();
  for (const file of linkLedgers) {
    const jsonPath = path.join(xferDir, file);
    const label = decodeURIComponent(file.slice(".link.".length, -".json".length));
    let host: string | undefined;
    let pid: number | undefined;
    let names: string[] = [];
    try {
      const rec = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      if (typeof rec.host === "string") host = rec.host;
      if (typeof rec.pid === "number") pid = rec.pid;
      if (Array.isArray(rec.names)) names = rec.names.filter((n): n is string => typeof n === "string");
    } catch { /* unreadable: leave it for a human */ }

    const sockets = names.map(n => path.join(xferDir, `${encodeURIComponent(n)}.sock`));
    for (const name of names) claimedByLink.add(name);

    if (pid !== undefined && !processAlive(pid)) {
      // Keep only the entries that still exist, so the report is about reality.
      const owned = sockets.filter(p => fs.existsSync(p));
      zombies.push({
        name: label,
        sockPath: owned[0] ?? path.join(xferDir, `.link-${label}.sock`),
        jsonPath,
        pid,
        reason: "dead-link",
        ...(host ? { linkHost: host } : {}),
        ...(owned.length > 0 ? { ownedSockets: owned } : {}),
      });
      for (const name of names) {
        const at = alive.indexOf(name);
        if (at >= 0) alive.splice(at, 1);
      }
    } else {
      alive.push(label);
    }
  }

  for (const stem of sockStems) {
    if (claimedByLink.has(stem)) continue; // judged by its Link ledger
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
    // A reverse marker is not ours: deleting it desynchronises another machine.
    if (zombie.reportOnly) continue;
    // A Link ledger and its ssh process are one thing. Deleting the ledger while
    // the process lives orphans the tunnel on both ends, with nothing left to
    // reap it — so the pid goes first, and only the pid this ledger names.
    if (zombie.linkHost !== undefined && zombie.pid !== undefined) {
      try { process.kill(zombie.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    const sockets = zombie.ownedSockets ?? [zombie.sockPath];
    for (const sock of sockets) {
      try { fs.unlinkSync(sock); } catch { /* already gone */ }
    }
    if (zombie.jsonPath) {
      try { fs.unlinkSync(zombie.jsonPath); } catch { /* already gone */ }
    }
  }
  return report;
}
