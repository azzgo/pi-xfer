import { listPeers } from "./utils.js";
import type { PeerInfo, PeerSendConfig, Settings } from "./types.js";

/** A remote peer from settings.json (send-template based). */
export interface PeerSendEntry {
  name: string;
  send: string;
  timeoutMs?: number;
  note?: string;
}

/** Map a `peers.<name>` settings entry to its PeerSendEntry form, dropping unset optionals. */
function toPeerSendEntry(name: string, entry: PeerSendConfig): PeerSendEntry {
  return {
    name,
    send: entry.send,
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  };
}

/** All remote peers from `settings.peers`, sorted by name. */
export function listRemotePeers(settings: Settings): PeerSendEntry[] {
  return Object.entries(settings.peers ?? {})
    .map(([name, entry]) => toPeerSendEntry(name, entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up one remote peer by name; undefined when absent. */
export function getRemotePeer(settings: Settings, name: string): PeerSendEntry | undefined {
  const entry = settings.peers?.[name];
  return entry === undefined ? undefined : toPeerSendEntry(name, entry);
}

/**
 * Everything `/xfer list` and command completions surface: local unix-socket peers plus
 * remote settings peers. utils.listPeers already excludes the calling agent via its
 * `myName` argument, so self-exclusion is reused rather than re-implemented. The two
 * namespaces stay separate — a local and a remote peer may share a name unmerged.
 */
export function listAllPeers(settings: Settings, myName: string): { local: PeerInfo[]; remote: PeerSendEntry[] } {
  return { local: listPeers(myName), remote: listRemotePeers(settings) };
}
