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
}

/** `xfer-notify` frame sent over the peer socket (one-way handoff). */
export interface XferNotifyMessage {
  type: "xfer-notify";
  msg_id: string;
  from: string;
  file: string;
  summary: string;
}

/** This agent's identity for the current session. */
export interface Identity {
  name: string;
  cwd: string;
  endpoint: string;
  metadata: string;
  server: net.Server | null;
  startedAt: number;
}

/** `[listen]` section: names the bridge transport that owns the xfer listen socket. */
export interface ListenConfig {
  bridge: string;
}

/** Per-peer `peers.<name>` entry: external command template used to send a handoff. */
export interface PeerSendConfig {
  send: string;
  timeoutMs?: number;
  note?: string;
}

/** Optional `~/.pi/xfer/settings.json` document (loaded by `settings.ts`). */
export interface Settings {
  listen?: ListenConfig;
  peers?: Record<string, PeerSendConfig>;
}
