import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import type * as net from "node:net";
import { XFER_DIR } from "./constants.js";
import { createServer, listenServer } from "./server.js";
import { XferState } from "./state.js";
import type { XferNotifyMessage } from "./types.js";
import { deriveName, endpointForName, metadataForName } from "./utils.js";

/** Host/port + server handle of a running bridge listener. */
export interface BridgeListener {
  host: string;
  port: number;
  server: net.Server;
}

/** `server.address()` narrowed to a TCP endpoint; throws on unbound or pipe-bound servers. */
function tcpListenerInfo(server: net.Server): BridgeListener {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("bridge listener is not bound to a TCP address");
  }
  return { host: address.address, port: address.port, server };
}

/**
 * Orchestrates the xfer listener lifecycle: session start, rename,
 * and shutdown. Owns the inbound socket + its delivery into the session.
 */
export class XferController {
  private readonly pi: ExtensionAPI;
  readonly state: XferState;

  /** Bridge-side TCP listener, when running; independent of `state.identity`. */
  private bridgeServer: net.Server | null = null;

  constructor(pi: ExtensionAPI, state: XferState) {
    this.pi = pi;
    this.state = state;
  }

  /** Route one inbound frame into the session — shared by the unix + bridge listeners. */
  private deliverInbound(msg: XferNotifyMessage): void {
    const { pi, state } = this;
    const isIdle = state.isRuntimeIdle();
    pi.sendMessage({
      customType: "xfer-inbound",
      content:
        `📨 [Xfer from **${msg.from}**]\n\n` +
        `**Request**: ${msg.summary}\n\n` +
        `**Doc**: \`${msg.file}\`\n\n` +
        `Read the doc and handle the request.` +
        `\n\nXfer is one-way — only reply if you have meaningful new information to communicate back.`,
      display: true,
    }, isIdle
      ? { deliverAs: "followUp", triggerTurn: true }
      : { deliverAs: "steer" });
  }

  /** Inbound socket server that routes `xfer-notify` into the session. */
  private createInboundServer(): net.Server {
    return createServer({ deliver: (msg) => this.deliverInbound(msg) });
  }

  private async listen(ctx: ExtensionContext): Promise<void> {
    const identity = this.state.identity;
    if (!identity?.server) throw new Error("xfer server not initialised");
    await listenServer({
      server: identity.server,
      endpoint: { kind: "unix", path: identity.endpoint },
      name: identity.name,
      notifyError: (message) => ctx.ui.notify(message, "error"),
      setStatus: (text) => ctx.ui.setStatus("xfer", text),
      onListening: () => this.state.writeMetadata(true),
    });
  }

  /** Bridge transport: the same frame protocol over 127.0.0.1 TCP for the bridge's lifetime.
   *  Never called from `start()`/`session_start` — the bridge owns this listener. */
  async startBridgeListener(): Promise<BridgeListener> {
    if (this.bridgeServer) return tcpListenerInfo(this.bridgeServer);
    const server = this.createInboundServer();
    try {
      await listenServer({
        server,
        endpoint: { kind: "tcp", host: "127.0.0.1", port: 0 },
        name: "xfer-bridge",
        notifyError: (message) => this.state.runtimeContext?.ui.notify(message, "error"),
        setStatus: () => { /* status display stays owned by the bridge task */ },
        onListening: () => { /* metadata tracks the unix identity only */ },
      });
    } catch (error) {
      if (server.listening) server.close();
      throw error;
    }
    this.bridgeServer = server;
    return tcpListenerInfo(server);
  }

  /** Close the bridge listener and release its port; a no-op when not running. */
  async stopBridgeListener(): Promise<void> {
    const server = this.bridgeServer;
    this.bridgeServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** `session_start`: derive name, start the socket, begin metadata polling. */
  async start(ctx: ExtensionContext): Promise<void> {
    const name = deriveName(this.pi);
    fs.mkdirSync(XFER_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(XFER_DIR, 0o700); } catch { /* best effort */ }
    const endpoint = endpointForName(name);
    const metadata = metadataForName(name);
    try { fs.unlinkSync(endpoint); } catch { /* ok */ }
    try { fs.unlinkSync(metadata); } catch { /* ok */ }

    const state = this.state;
    state.runtimeContext = ctx;
    state.currentModel = ctx.model?.id ?? "unknown";
    state.currentStatus = "idle";
    state.markDirty();
    state.identity = {
      name,
      cwd: ctx.cwd || process.cwd(),
      endpoint,
      metadata,
      server: this.createInboundServer(),
      startedAt: Date.now(),
    };
    state.startMetadataPolling();

    try {
      await this.listen(ctx);
    } catch (error) {
      ctx.ui.notify(`❌ Failed to start xfer listener: ${error instanceof Error ? error.message : String(error)}`, "error");
      state.stopMetadataPolling();
      state.runtimeContext = null;
      state.identity = null;
    }
  }

  /** `/xfer name <new>`: re-socket under a new name. */
  async rename(ctx: ExtensionContext, newName: string): Promise<void> {
    const state = this.state;
    const ident = state.identity;
    if (!ident) return;

    const oldEndpoint = ident.endpoint;
    const oldMetadata = ident.metadata;
    try { ident.server?.close(); } catch { /* ok */ }
    try { fs.unlinkSync(oldEndpoint); } catch { /* ok */ }
    try { fs.unlinkSync(oldMetadata); } catch { /* ok */ }

    ident.name = newName;
    ident.endpoint = endpointForName(newName);
    ident.metadata = metadataForName(newName);
    try { fs.unlinkSync(ident.endpoint); } catch { /* ok */ }
    try { fs.unlinkSync(ident.metadata); } catch { /* ok */ }

    ident.server = this.createInboundServer();
    state.markDirty();
    try {
      await this.listen(ctx);
    } catch (error) {
      ident.server = null;
      ctx.ui.notify(`❌ Failed to rename xfer: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    ctx.ui.setStatus("xfer", `📡 ${newName}`);
    ctx.ui.notify(`✅ Renamed to "${newName}"`, "info");
  }

  /** `session_shutdown`: close socket, remove endpoint + metadata, stop polling. */
  shutdown(): void {
    const state = this.state;
    state.stopMetadataPolling();
    if (state.identity) {
      try { state.identity.server?.close(); } catch { /* ok */ }
      try { fs.unlinkSync(state.identity.endpoint); } catch { /* ok */ }
      try { fs.unlinkSync(state.identity.metadata); } catch { /* ok */ }
    }
    state.runtimeContext = null;
    state.identity = null;
  }
}
