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

export function endpointForName(name: string, xferDir: string = XFER_DIR): string {
  return path.join(xferDir, `${encodeAgentName(name)}.sock`);
}

export function metadataForName(name: string, xferDir: string = XFER_DIR): string {
  return path.join(xferDir, `${encodeAgentName(name)}.json`);
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

export function readPeerMetadata(xferName: string, xferDir: string = XFER_DIR): Partial<PeerInfo> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(xferDir, `${encodeAgentName(xferName)}.json`), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const value = raw as Record<string, unknown>;
    return {
      ...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    };
  } catch {
    return {};
  }
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
    const names = fs.readdirSync(xferDir)
      .filter(f => f.endsWith(".sock"))
      .map(f => decodeAgentName(f.replace(/\.sock$/, "")))
      .filter(n => n !== myName);
    return [...new Set(names)]
      .map((xferName): PeerInfo => ({
        xferName,
        endpoint: endpointForName(xferName),
        ...readPeerMetadata(xferName, xferDir),
      }))
      .sort((a, b) => a.xferName.localeCompare(b.xferName));
  } catch { return []; }
}
