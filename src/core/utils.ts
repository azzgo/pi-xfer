import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { XFER_DIR } from "./constants.ts";
import type { PeerInfo } from "./types.ts";

/** Unique message id used to match an ack. */
export function msgId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function encodeAgentName(name: string): string {
  return encodeURIComponent(name);
}

export function decodeAgentName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
/** Longest encoded name a socket file stem may carry before it is hashed instead. */
export const MAX_ENCODED_STEM = 64;

/** Marks a hashed stem; `encodeURIComponent` never leaves a `+` unescaped. */
const HASHED_STEM_PREFIX = "+";

/**
 * The file stem for one peer name.
 *
 * `encodeURIComponent` triples the bytes of every CJK character, and a unix socket
 * path cannot exceed `sun_path` — 108 bytes on Linux, 104 on macOS — so a long or
 * non-ASCII name must never become the socket file name verbatim: bind fails with
 * a bare `EINVAL`, which reads like a programming error instead of "this name does
 * not fit". Past the budget the stem becomes a stable digest prefixed with `+`, so
 * `nameForStem` can tell a hashed stem from an encoded one. Never truncate: the
 * stem is the only thing keeping two peers' files apart.
 */
export function socketStem(name: string): string {
  const encoded = encodeURIComponent(name);
  if (encoded.length <= MAX_ENCODED_STEM) return encoded;
  return HASHED_STEM_PREFIX + createHash("sha256").update(name, "utf-8").digest("hex").slice(0, 16);
}

export function isHashedStem(stem: string): boolean {
  return stem.startsWith(HASHED_STEM_PREFIX);
}

export function endpointForName(name: string, xferDir: string = XFER_DIR): string {
  return path.join(xferDir, `${socketStem(name)}.sock`);
}

export function metadataForName(name: string, xferDir: string = XFER_DIR): string {
  return path.join(xferDir, `${socketStem(name)}.json`);
}

/** One `<stem>.json` read tolerantly; anything unreadable or non-object is `{}`. */
function readMetadataFile(file: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The peer name behind a socket file stem: an encoded round trip for an ordinary
 * stem, and the recorded `xferName` for a hashed one. The digest is one way, so
 * without the sidecar the name — and with it `endpointForName` — is unrecoverable.
 * A hashed stem with no readable sidecar stays itself: that file is an orphan whose
 * owner cannot be addressed by name anyway.
 */
export function nameForStem(stem: string, xferDir: string = XFER_DIR): string {
  if (!isHashedStem(stem)) return decodeAgentName(stem);
  const recorded = readMetadataFile(path.join(xferDir, `${stem}.json`)).xferName;
  return typeof recorded === "string" && recorded !== "" ? recorded : stem;
}

export function displayPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const home = os.homedir();
  return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

export function peerDescription(peer: PeerInfo): string {
  const source = peer.sessionName ? `session: ${peer.sessionName}` : "session: unnamed";
  const details = [source, displayPath(peer.cwd), peer.model, peer.status]
    .filter((value): value is string => Boolean(value));
  const base = details.join(" · ");
  const description = peer.description?.trim();
  return description ? `${base} · ${description}` : base;
}

/**
 * True when this process was launched from one of `names` (basenames of
 * `process.argv[1]`). Entrypoint detection by filename, not by comparing
 * `import.meta.url`: the daemons ship as bundles, where every module esbuild
 * inlined reports the bundle's own path as its URL — a path comparison would
 * make broker-main, admin-main and both managers believe they were all run
 * directly, and each CLI would fire (and exit) inside one another. A basename
 * match survives bundling and is unchanged for `node file.ts` runs.
 */
export function isEntryPoint(names: string[]): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return names.includes(path.basename(invoked));
}

/** Is `pid` a live process? EPERM (exists, other user) counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPeerMetadata(xferName: string, xferDir: string = XFER_DIR): Partial<PeerInfo> {
  return projectMetadata(readMetadataFile(metadataForName(xferName, xferDir)));
}

/** The `PeerInfo` fields one metadata record actually carries, typed and filtered. */
function projectMetadata(value: Record<string, unknown>): Partial<PeerInfo> {
  return {
    ...(typeof value.xferName === "string" ? { xferName: value.xferName } : {}),
    ...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(value.via === "ssh"
      ? {
          via: "ssh" as const,
          host: typeof value.host === "string" ? value.host : "",
          ...(value.role === "reverse" || value.role === "import" ? { role: value.role } : {}),
        }
      : {}),
  };
}

/** Derive this agent's xfer name: --xfer flag > .pi/settings.json name > dirname_random. */
export function deriveName(pi: ExtensionAPI): string {
  const flag = pi.getFlag("xfer") as string | undefined;
  if (flag) return flag;
  try {
    const sPath = path.join(process.cwd(), ".pi", "settings.json");
    if (fs.existsSync(sPath)) {
      const s = JSON.parse(fs.readFileSync(sPath, "utf-8"));
      if (s.name) return s.name;
    }
  } catch { /* fall through */ }
  const base = path.basename(process.cwd()) || `pi-${process.pid}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}_${suffix}`;
}

/** Reject with `timed out after Nms` when `promise` outlives `ms`; the timer never holds the loop open. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
/** All reachable peers (sockets present in xferDir, defaulting to XFER_DIR, excluding myself). */
export function listPeers(myName: string, xferDir: string = XFER_DIR): PeerInfo[] {
  try {
    fs.mkdirSync(xferDir, { recursive: true, mode: 0o700 });
    const peers = new Map<string, PeerInfo>();
    for (const file of fs.readdirSync(xferDir).filter(f => f.endsWith(".sock"))) {
      const xferName = nameForStem(file.slice(0, -".sock".length), xferDir);
      if (xferName === myName || peers.has(xferName)) continue;
      peers.set(xferName, {
        xferName,
        endpoint: path.join(xferDir, file),
        ...readPeerMetadata(xferName, xferDir),
      });
    }
    return [...peers.values()].sort((a, b) => a.xferName.localeCompare(b.xferName));
  } catch { return []; }
}
