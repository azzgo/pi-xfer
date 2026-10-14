import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { XFER_DIR } from "./constants.ts";
import { readSenderCwdStamp, senderCwdInstruction } from "./sender-cwd-stamp.ts";
import { readHandoffKind } from "./handoff-kind.ts";
import { createServer, listenServer } from "./server.ts";
import { XferState } from "./state.ts";
import type { XferNotifyMessage } from "./types.ts";
import { deriveName, endpointForName, metadataForName } from "./utils.ts";
import { FROM_WEB_PICKER } from "./wire.ts";

/**
 * Orchestrates the xfer listener lifecycle: session start, rename,
 * and shutdown. Owns the inbound socket + its delivery into the session.
 */
export class XferController {
  private readonly pi: ExtensionAPI;
  readonly state: XferState;

  constructor(pi: ExtensionAPI, state: XferState) {
    this.pi = pi;
    this.state = state;
  }

  /** Route one inbound frame into the session. */
  /** Route one inbound frame into the session. `transport` labels non-local paths ("mesh"). */
  deliverInbound(msg: XferNotifyMessage, transport?: "mesh"): void {
    const { pi, state } = this;
    const isIdle = state.isRuntimeIdle();
    const via = transport ? ` · ${transport}` : "";
    // Agent senders stamp their cwd into the doc (P1-D); web-picker senders have
    // none — a browser has no working directory to anchor edits to.
    const stamp = msg.from === FROM_WEB_PICKER ? null : readSenderCwdStamp(msg.file);
    const isLocalSender = stamp !== null && transport !== "mesh" && stamp.machine === os.hostname();
    const cwdLine = stamp ? `\n${senderCwdInstruction(stamp, { local: isLocalSender })}\n` : "";
    const kind = readHandoffKind(msg.file);
    const body =
      `**Handoff**: \`${msg.msg_id}\` — kind: ${kind}\n\n` +
      `**Request**: ${msg.summary}\n\n` +
      `**Doc**: \`${msg.file}\`\n${cwdLine}\n` +
      "Read the doc and handle the request.";
    const content =
      msg.from === FROM_WEB_PICKER
        ? (
            // Web-picker senders are not xfer peers: steer the agent to the
            // page-tool pull channel instead of a doomed xfer_to reply.
            `📨 [Xfer from **${FROM_WEB_PICKER}** (browser userscript)]\n\n` +
            body +
            `\n\nThe sender is the Web Picker userscript, NOT an agent: it has no xfer socket and cannot answer. ` +
            `Do NOT call xfer_to with target "${FROM_WEB_PICKER}" — it fails with "peer not found".\n\n` +
            `To query the page back, run the broker page-tool CLI (full op table in the doc's "Follow-up channel" section), e.g.:\n` +
            `\`node ${path.join(import.meta.dirname, "broker-main.ts")} page-tool ${state.identity?.name ?? "<own-name>"} dom.query '{"selector":"button","maxCount":5}'\``
          )
        : (
            `📨 [Xfer from **${msg.from}**${via}]\n\n` +
            body +
            (kind === "task"
              ? `\n\nThis handoff is a **Task**: it asks you for output. Once you have a conclusion — done, blocked, or needing input — send exactly one reverse handoff to \`${msg.from}\`. That handoff carries the conclusion; a bare acknowledgement is not one.`
              : `\n\nThis handoff is a **Notification**: it asks you for nothing. Do not reply. Send a reverse handoff only if you are missing information you need, or if the document conflicts with fact.`)
          );
    pi.sendMessage({
      customType: "xfer-inbound",
      content,
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
      path: identity.endpoint,
      name: identity.name,
      notifyError: (message) => ctx.ui.notify(message, "error"),
      setStatus: (text) => ctx.ui.setStatus("xfer", text),
      onListening: () => this.state.writeMetadata(true),
    });
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
