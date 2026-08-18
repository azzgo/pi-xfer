import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { XFER_DIR } from "./constants.js";
import type { PeerInfo } from "./types.js";

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

export function endpointForName(name: string): string {
  return path.join(XFER_DIR, `${encodeAgentName(name)}.sock`);
}

export function metadataForName(name: string): string {
  return path.join(XFER_DIR, `${encodeAgentName(name)}.json`);
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
  return details.join(" · ");
}

export function readPeerMetadata(xferName: string): Partial<PeerInfo> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(metadataForName(xferName), "utf-8"));
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

/** All reachable peers (sockets present in XFER_DIR, excluding myself). */
export function listPeers(myName: string): PeerInfo[] {
  try {
    fs.mkdirSync(XFER_DIR, { recursive: true, mode: 0o700 });
    const names = fs.readdirSync(XFER_DIR)
      .filter(f => f.endsWith(".sock"))
      .map(f => decodeAgentName(f.replace(/\.sock$/, "")))
      .filter(n => n !== myName);
    return [...new Set(names)]
      .map((xferName): PeerInfo => ({
        xferName,
        endpoint: endpointForName(xferName),
        ...readPeerMetadata(xferName),
      }))
      .sort((a, b) => a.xferName.localeCompare(b.xferName));
  } catch { return []; }
}
