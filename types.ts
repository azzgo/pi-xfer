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
  /** SSH Link marker (ADR-0021): present only on a Link's `.json`, never on a Peer's. */
  via?: "ssh";
  host?: string;
  /** Which half of the tunnel this Link is — decides whether a reply has a route. */
  direction?: "in" | "out";
}

/** `xfer-notify` frame sent over the peer socket (one-way handoff). */
export interface XferNotifyMessage {
  type: "xfer-notify";
  msg_id: string;
  from: string;
  /**
   * Absolute path on the SENDER's machine. Absent when the frame carries
   * `document` instead (a Link always does — the receiver cannot open the
   * sender's filesystem, ADR-0021).
   */
  file?: string;
  /** Inline document body, used when `file` is not a valid receiver-side path. */
  document?: string;
  summary: string;
  /**
   * The sender's declaration, carried in the envelope rather than only in the
   * document body. Reading it back off the body silently downgraded every
   * handoff whose document did not survive (ADR-0021): a lost `kind: task` line
   * is not the same claim as a sender who never said task.
   */
  kind?: "task" | "notification";
  /** Set when the socket itself is an ssh Link, so the receiver knows the
   *  reverse channel may not exist. */
  via?: "ssh";
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
