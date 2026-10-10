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
import { MESH_CONFIG_PATH } from "./constants.js";
import { MeshNode } from "./mesh.js";
import { XferState } from "./state.js";
import { listPeers, msgId } from "./utils.js";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("xfer", {
    description: "Override xfer agent name (default: current directory name)",
    type: "string",
    default: undefined,
  });

  const state = new XferState();
  const controller = new XferController(pi, state);
  const mesh = new MeshNode({
    configPath: MESH_CONFIG_PATH,
    deliver: (msg) => controller.deliverInbound(msg, "mesh"),
  });

  // ── Startup: register socket ──
  pi.on("session_start", async (_event, ctx) => {
    await controller.start(ctx);
  });

  // ── xfer_to availability: keep the ~1KB tool description out of the prompt
  // whenever there is no peer to talk to. Re-checked each turn since peers
  // appear/disappear dynamically (socket files in XFER_DIR).
  /** A peer counts only if its recorded pid is alive — zombie sockets must not
   * keep the tool resident. */
  function hasLivePeer(): boolean {
    if (!state.identity) return false;
    return listPeers(state.identity.name).some((peer) => {
      if (peer.pid === undefined) return false;
      try { process.kill(peer.pid, 0); return true; } catch { return false; }
    });
  }

  function syncXferToolAvailability(): void {
    const hasPeers = state.identity !== null && hasLivePeer();
    const active = pi.getActiveTools();
  }

  pi.on("before_agent_start", async () => {
    syncXferToolAvailability();
  });
  // ── /xfer command ──
  registerXferCommand(pi, controller, { mesh });

  // ── xfer_to tool (one-way, no wait) ──
  pi.registerTool({
    name: "xfer_to",
    label: "Transfer to Pi",
    description:
      "Send a one-way handoff markdown document to another Pi agent over its xfer socket; returns immediately with a handoff_id (no reply wait). Use /xfer list for target names. One-way channel: never send acknowledgements; only xfer when you have meaningful new information to communicate.",

    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

    parameters: Type.Object({
      target: Type.String({ description: "Target agent name (see /xfer list)." }),
      summary: Type.String({ description: "One-sentence summary of the request." }),
      handoff_document: Type.String({ description: "Full markdown handoff doc: context, problem, specific request, relevant files, suggested skills, notes." }),
    }),

    outputSchema: Type.Object({
      handoff_id: Type.String(),
      target: Type.String(),
      document: Type.String(),
      status: Type.String(),
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
        const notFound = /not found/.test(String(err?.message));
        throw new Error(
          `xfer: failed to notify "${target}" — ${err.message}` +
          (notFound
            ? ` — if this handoff arrived from the web picker, that sender is a browser userscript, not an xfer agent: do not xfer back; query the page via the broker page-tool CLI instead (see the doc's "Follow-up channel")`
            : ""),
        );
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
        structuredContent: { handoff_id: mid, target, document: tmpFile, status: "sent" },
      };
    },
  });

  // ── xfer_mesh_to tool (mesh transport, one-way, inline doc) ──
  pi.registerTool({
    name: "xfer_mesh_to",
    label: "Transfer to Mesh Node",
    description:
      "Send a one-way handoff markdown document to another Pi agent over the xfer mesh (cross-machine RivetKit transport); returns immediately with a handoff_id (no reply wait). Use /xfer mesh list for node names; the mesh must be online (/xfer mesh up). The document is sent inline. One-way channel: never send acknowledgements; only xfer when you have meaningful new information to communicate.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    parameters: Type.Object({
      target: Type.String({ description: "Target mesh node name (see /xfer mesh list)." }),
      summary: Type.String({ description: "One-sentence summary of the request." }),
      handoff_document: Type.String({ description: "Full markdown handoff doc: context, problem, specific request, relevant files, suggested skills, notes." }),
    }),
    outputSchema: Type.Object({
      handoff_id: Type.String(),
      target: Type.String(),
      status: Type.String(),
    }),
    async execute(_callId, params, _signal, onUpdate, _ctx) {
      const { target, summary, handoff_document } = params as any;
      if (onUpdate) {
        onUpdate({ content: [{ type: "text", text: `📨 Sending to mesh node "${target}"...` }], details: {} });
      }
      try {
        const { id } = await mesh.send(target, { summary, document: handoff_document });
        return {
          content: [{
            type: "text",
            text: `✅ Sent to mesh node "${target}" (handoff_id: ${id})\n\nOne-way handoff — reply via /xfer mesh if needed.`,
          }],
          details: { target, handoff_id: id, status: "sent" },
          structuredContent: { handoff_id: id, target, status: "sent" },
        };
      } catch (err: any) {
        throw new Error(`xfer mesh: failed to send to "${target}" — ${err.message}`);
      }
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
    await mesh.shutdown();
    controller.shutdown();
  });
}
