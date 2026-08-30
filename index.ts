/**
 * Xfer — unidirectional cross-project handoff extension (folder plugin).
 *
 * Generate a markdown handoff doc via /handoff-style prompt, send it via
 * Unix socket to another Pi instance. One-way only, no wait.
 *
 * Usage: see README.md in this directory.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sendNotify } from "./client.js";
import { registerXferCommand } from "./commands.js";
import { XferController } from "./controller.js";
import { getRemotePeer, type PeerSendEntry } from "./peers.js";
import { sendPeerHandoff } from "./oneshot.js";
import { DEFAULT_SETTINGS_PATH, loadSettings } from "./settings.js";
import { XferState } from "./state.js";
import { msgId } from "./utils.js";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("xfer", {
    description: "Override xfer agent name (default: current directory name)",
    type: "string",
    default: undefined,
  });

  const state = new XferState();
  const controller = new XferController(pi, state);

  // ── Startup: register socket ──
  pi.on("session_start", async (_event, ctx) => {
    await controller.start(ctx);
  });

  // ── /xfer command ──
  registerXferCommand(pi, controller);

  // ── xfer_to tool (one-way, no wait) ──
  pi.registerTool({
    name: "xfer_to",
    label: "Transfer to Pi",
    description:
      "Send a handoff markdown document to another Pi agent (unidirectional, no reply waiting).\n\n" +
      "Steps:\n" +
      "1. Compose a comprehensive markdown handoff document\n" +
      "2. Call xfer_to with: target name, one-sentence summary, full document body\n" +
      "3. The tool saves the doc to /tmp/ and sends a socket notification to the target\n" +
      "4. Returns immediately with a handoff_id — no reply waiting\n\n" +
      "IMPORTANT: One-way handoff. Do NOT reply with acknowledgements or " +
      "unnecessary follow-ups. Only xfer back if you have meaningful new " +
      "information to share.\n\n" +
      "Example:\n" +
      "  User: /xfer proj-b investigate API timeout\n" +
      "  → LLM generates handoff doc → calls xfer_to(target='proj-b', ...)",

    parameters: Type.Object({
      target: Type.String({
        description: "Target agent name (use /xfer list to see available targets).",
      }),
      summary: Type.String({
        description: "One-sentence summary of what you need from the target.",
      }),
      handoff_document: Type.String({
        description:
          "Full markdown handoff document. Include: context, problem, " +
          "specific request for the target, relevant files/code, " +
          "suggested skills for the target agent, and notes.",
      }),
    }),

    async execute(_callId, params, _signal, onUpdate, ctx) {
      const { target, summary, handoff_document } = params as any;
      if (!state.identity) throw new Error("xfer not initialised");
      const senderName = state.identity.name;

      const mid = msgId();
      const tmpFile = path.join(os.tmpdir(), `pi-xfer-${mid}.md`);

      // 1. write handoff doc to tmp
      fs.writeFileSync(tmpFile, handoff_document, { encoding: "utf-8", mode: 0o600 });

      // 2. notify target
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `📨 Sending to "${target}"...` }],
          details: {},
        });
      }

      try {
        await sendNotify(target, {
          type: "xfer-notify",
          msg_id: mid,
          from: senderName,
          file: tmpFile,
          summary,
        });
      } catch (err: any) {
        try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
        throw new Error(`xfer: failed to notify "${target}" — ${err.message}`);
      }

      // 3. done, return immediately (no wait)
      return {
        content: [{
          type: "text",
          text: `✅ Sent to "${target}" (handoff_id: ${mid})\n\nDoc: ${tmpFile}\n\n` +
                `One-way handoff — reply via /xfer if needed.`,
        }],
        details: {
          target,
          handoff_id: mid,
          document: tmpFile,
          status: "sent",
        },
      };
    },
  });

  // ── xfer_peer_to tool (remote settings peers, one-way fire-and-forget) ──
  pi.registerTool({
    name: "xfer_peer_to",
    label: "Transfer to Remote Peer",
    description:
      "Send a handoff markdown document to a REMOTE peer configured in ~/.pi/xfer/settings.json " +
      "(unidirectional, fire-and-forget).\n\n" +
      "Unlike xfer_to (local Pi instances over unix sockets), xfer_peer_to reaches peers in the " +
      "`peers.<name>` section of the xfer settings file by running their `send` command template. " +
      "Only the command's exit code is checked — ingestion on the remote side is the command author's concern.\n\n" +
      "Steps:\n" +
      "1. Compose a comprehensive markdown handoff document\n" +
      "2. Call xfer_peer_to with: target name, one-sentence summary, full document body\n" +
      "3. The tool saves the doc to /tmp/ and runs the peer's send command\n" +
      "4. Returns immediately with a handoff_id — no reply waiting\n\n" +
      "IMPORTANT: One-way handoff. Do NOT reply with acknowledgements or " +
      "unnecessary follow-ups. Only xfer back if you have meaningful new " +
      "information to share.",

    parameters: Type.Object({
      target: Type.String({
        description: "Remote peer name from ~/.pi/xfer/settings.json (use /xfer list to see configured peers).",
      }),
      summary: Type.String({
        description: "One-sentence summary of what you need from the target.",
      }),
      handoff_document: Type.String({
        description:
          "Full markdown handoff document. Include: context, problem, " +
          "specific request for the target, relevant files/code, " +
          "suggested skills for the target agent, and notes.",
      }),
    }),

    async execute(_callId, params, _signal, onUpdate, _ctx) {
      const { target, summary, handoff_document } = params as any;
      if (!state.identity) throw new Error("xfer not initialised");
      const senderName = state.identity.name;

      const peer: PeerSendEntry | undefined = getRemotePeer(loadSettings(), target);
      if (!peer) {
        throw new Error(
          `xfer: remote peer "${target}" not found in ${DEFAULT_SETTINGS_PATH} — ` +
          `add peers."${target}".send there (use /xfer list to see configured peers)`,
        );
      }

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `📨 Sending to "${target}" via command...` }],
          details: {},
        });
      }

      const { handoff_id, docPath } = await sendPeerHandoff(peer, {
        from: senderName,
        summary,
        document: handoff_document,
      });

      return {
        content: [{
          type: "text",
          text: `✅ Sent to "${target}" via command (handoff_id: ${handoff_id})\n\nDoc: ${docPath}\n\n` +
                `One-way fire-and-forget — the send command exited 0; ingestion on the ` +
                `remote side is that command's concern. No reply waiting.`,
        }],
        details: {
          target,
          handoff_id,
          document: docPath,
          status: "sent",
          transport: "command",
        },
      };
    },
  });

  // ── Status tracking → peer metadata ──
  pi.on("agent_start", () => state.setStatus("thinking"));
  pi.on("tool_execution_start", (event) => state.setStatus(`tool:${event.toolName}`));
  pi.on("tool_execution_end", () => state.setStatus("thinking"));
  pi.on("agent_end", () => state.setStatus("idle"));
  pi.on("model_select", (event) => {
    state.currentModel = event.model.id;
    state.writeMetadata();
  });

  // ── Cleanup ──
  pi.on("session_shutdown", async () => {
    controller.shutdown();
  });
}
