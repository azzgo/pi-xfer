import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { XFER_DIR } from "./constants.ts";
import { readSenderCwdStamp, senderCwdInstruction } from "./sender-cwd-stamp.ts";
import { DEFAULT_HANDOFF_KIND, readHandoffKind } from "./handoff-kind.ts";
import { createServer, listenServer } from "./server.ts";
import { XferState } from "./state.ts";
import type { XferNotifyMessage } from "./types.ts";
import { claimEndpoint } from "./endpoint-claim.ts";
import { deriveName, endpointForName, metadataForName } from "./utils.ts";
import { FROM_WEB_PICKER } from "./wire.ts";

/**
 * Tell a Link receiver whether a reply can physically reach the sender.
 *
 * The answer is decided locally: the sender's `out` Link landed a socket named
 * after it in THIS machine's xfer dir, and a reply is just a connect to that
 * socket. No socket ⇒ no route, and saying so up front is what stops an agent
 * from hunting for a return path that does not exist. A wrong guess here is
 * cheap to correct; a silent one sends conclusions into the void.
 */
function sshReturnChannelNote(sender: string, xferDir: string): string {
  const reachable = fs.existsSync(endpointForName(sender, xferDir));
  return reachable
    ? `\n\nThis arrived over an **ssh Link**. The return channel exists: this machine has ` +
      `\`${sender}.sock\`, so \`xfer_to\` with target \`${sender}\` reaches the sender.`
    : `\n\nThis arrived over an **ssh Link**, and **there is no verified return channel**: ` +
      `this machine has no \`${sender}.sock\`, so \`xfer_to\` to \`${sender}\` will most likely ` +
      `fail with "peer not found". That is the tunnel's shape (the sender opened \`in\` only), not the ` +
      `sender disappearing. Do not search this machine for a route and do not retry xfer_to: ` +
      `report the conclusion in your own session, or ask the human to open the reverse Link ` +
      `(\`/xfer ssh out\` on the other machine, or \`/xfer ssh in\` here).`;
}

/**
 * Orchestrates the xfer listener lifecycle: session start, rename,
 * and shutdown. Owns the inbound socket + its delivery into the session.
 */
export class XferController {
  private readonly pi: ExtensionAPI;
  readonly state: XferState;
  /** Where peer sockets live; overridable so tests never touch the real dir. */
  private readonly xferDir: string;

  constructor(pi: ExtensionAPI, state: XferState, xferDir: string = XFER_DIR) {
    this.pi = pi;
    this.state = state;
    this.xferDir = xferDir;
  }

  /** Route one inbound frame into the session. */
  /**
   * Route one inbound frame into the session. `transport` labels non-local
   * paths ("mesh"). A frame carrying `document` instead of `file` (an ssh Link
   * always does — the sender's tmp path is unreachable here) is materialised
   * into a local tmp file first, so everything downstream reads a real path.
   */
  deliverInbound(msg: XferNotifyMessage, transport?: "mesh" | "ssh"): void {
    const { pi, state } = this;
    if (msg.document !== undefined && !msg.file) {
      const local = path.join(os.tmpdir(), `pi-xfer-${msg.msg_id}.md`);
      try {
        fs.writeFileSync(local, msg.document, { encoding: "utf-8", mode: 0o600 });
        msg = { ...msg, file: local };
      } catch { /* fall through: the body is still quoted below */ }
    }
    msg = { ...msg, file: msg.file ?? "" };
    const transportLabel = transport ?? (msg.via === "ssh" ? "ssh" : undefined);
    const isIdle = state.isRuntimeIdle();
    const via = transportLabel ? ` · ${transportLabel}` : "";
    // Agent senders stamp their cwd into the doc (P1-D); web-picker senders have
    // none — a browser has no working directory to anchor edits to.
    const stamp = msg.from === FROM_WEB_PICKER || !msg.file ? null : readSenderCwdStamp(msg.file);
    const isLocalSender = stamp !== null && transportLabel === undefined && stamp.machine === os.hostname();
    const cwdLine = stamp ? `\n${senderCwdInstruction(stamp, { local: isLocalSender })}\n` : "";
    // The envelope's own declaration wins: the body may not have survived
    // (a Link without an inline document, a missing file), and "the sender
    // said nothing" is not the same claim as "the sender said notification".
    const kind = msg.kind ?? (msg.file ? readHandoffKind(msg.file) : DEFAULT_HANDOFF_KIND);
    // Never print an empty path or the literal "undefined": a receiver that
    // sees no doc must be told so plainly, or it starts hunting the filesystem
    // for something that was never here (ADR-0021).
    const docLine = msg.file
      ? `**Doc**: \`${msg.file}\`\n${cwdLine}\nRead the doc and handle the request.`
      : `**Doc**: (none — the sender's document did not arrive)\n\n` +
        `Handle the request from the summary above. Do not search this machine for the ` +
        `document: it was never written here.`;
    const body =
      `**Handoff**: \`${msg.msg_id}\` — kind: ${kind}\n\n` +
      `**Request**: ${msg.summary}\n\n` +
      docLine;
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
              ? `\n\nThis handoff is a **Task**: it asks you for output. Send exactly one reverse handoff to \`${msg.from}\` once you have a conclusion, and declare its kind deliberately — \`notification\` when it carries that conclusion, which closes the exchange, or \`task\` when you are blocked and need something further from \`${msg.from}\`. A bare acknowledgement is not a conclusion.`
              : `\n\nThis handoff is a **Notification**: it asks you for nothing. Do not reply. Send a reverse handoff only if you are missing information you need, or if the document conflicts with fact — declare it \`task\` when you need something back.`) +
            (transportLabel === "ssh" ? sshReturnChannelNote(msg.from, this.xferDir) : "")
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
    return createServer({ deliver: (msg) => this.deliverInbound(msg, msg.via === "ssh" ? "ssh" : undefined) });
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
    try {
      await claimEndpoint(name, XFER_DIR);
    } catch (error) {
      ctx.ui.notify(
        `❌ xfer could not start: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

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

    if (newName !== ident.name) {
      // Claim the new name before releasing the old one. A failed rename must leave the
      // session exactly as it was — otherwise the agent goes silent under neither name.
      try {
        await claimEndpoint(newName, XFER_DIR);
      } catch (error) {
        ctx.ui.notify(
          `❌ Failed to rename xfer: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
    }

    const oldEndpoint = ident.endpoint;
    const oldMetadata = ident.metadata;
    try { ident.server?.close(); } catch { /* ok */ }
    try { fs.unlinkSync(oldEndpoint); } catch { /* ok */ }
    try { fs.unlinkSync(oldMetadata); } catch { /* ok */ }

    ident.name = newName;
    ident.endpoint = endpointForName(newName);
    ident.metadata = metadataForName(newName);

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
