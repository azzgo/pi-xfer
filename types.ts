import type * as net from "node:net";

/** What one agent knows about another (from its `<name>.json` metadata). */
export interface PeerInfo {
  xferName: string;
  endpoint: string;
  sessionName?: string;
  cwd?: string;
  model?: string;
  status?: string;
  pid?: number;
  startedAt?: number;
  description?: string;
}

/** `xfer-notify` frame sent over the peer socket (one-way handoff). */
export interface XferNotifyMessage {
  type: "xfer-notify";
  msg_id: string;
  from: string;
  file: string;
  summary: string;
}


/**
 * Where one Handoff came to rest, as far as the network can honestly tell (ADR-0020).
 * Transport-time only — never "was it read": `pi.sendMessage` returns void and
 * ADR-0015 kept no durable archive.
 *
 * Both transports use the same four values and each reaches only the subset it can
 * support: mesh has a durable queue so it can say `queued`, local has none so it can
 * say `delivered`. `unknown` must never be presented as a reason to retry — a second
 * send is what turns an ambiguity into a real duplicate.
 */
export type XferNotifyOutcome = "queued" | "delivered" | "unknown" | "not-delivered";

/** This agent's identity for the current session. */
export interface Identity {
  name: string;
  cwd: string;
  endpoint: string;
  metadata: string;
  server: net.Server | null;
  startedAt: number;
}

/** One live local target from targets.listTargets: a `*.sock` plus best-effort sibling metadata (null when absent). */
export interface TargetInfo {
  name: string;
  sessionName: string | null;
  cwd: string | null;
  status: string | null;
  /**
   * Self-declared mesh capability note, when one could be read for this target.
   * Absent whenever the lookup did not run or the target's mesh actor was
   * unreachable — never an empty-string placeholder, so consumers can tell
   * "no description" from "no idea".
   */
  description?: string;
}
