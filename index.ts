/**
 * Xfer — unidirectional cross-project handoff extension (folder plugin).
 *
 * Generate a markdown handoff doc via /handoff-style prompt, send it via
 * Unix socket to another Pi instance. One-way only, no wait.
 *
 * Usage: see README.md in this directory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sendNotify } from "./client.ts";
import { senderCwdStampFor, stampDocument } from "./sender-cwd-stamp.ts";
import { stampHandoffKind } from "./handoff-kind.ts";
import { registerXferCommand } from "./commands.ts";
import { XferController } from "./controller.ts";
import { MESH_CONFIG_PATH } from "./constants.ts";
import { MeshNode } from "./mesh.ts";
import type { XferNotifyOutcome } from "./types.ts";
import { XferState } from "./state.ts";
import { listPeers, msgId } from "./utils.ts";

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

  /** Working-directory anchor stamped into every handoff doc this session sends (P1-D). */
  function thisCwdStamp() {
    return senderCwdStampFor(state.identity?.cwd || process.cwd(), os.hostname());
  }

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
      "Send a one-way handoff markdown document to another Pi agent over its xfer socket; returns immediately with a handoff_id (no reply wait). Use /xfer list for target names. Declare `kind`: \"task\" asks the target for output and comes back with exactly one conclusion (done, blocked, or needing input); \"notification\" informs and stays silent unless the target lacks information or the document conflicts with fact. Never send a handoff that only acknowledges or confirms. Send only when the user asks for a handoff, or when you are blocked on that specific target and a reverse handoff is what unblocks you. Never send on your own initiative to check on another agent, to keep a thread alive, or to pass work to a third agent.",

    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

    parameters: Type.Object({
      target: Type.String({ description: "Target agent name (see /xfer list)." }),
      summary: Type.String({ description: "One-sentence summary of the request." }),
      handoff_document: Type.String({ description: "Full markdown handoff doc: context, problem, specific request, relevant files, suggested skills, notes." }),
      kind: Type.Union([Type.Literal("task"), Type.Literal("notification")], {
        description: "What this handoff asks of the target. \"task\": the target must produce output and returns one conclusion. \"notification\": it asks for nothing and stays silent. Never send a handoff whose only purpose is to acknowledge or confirm.",
      }),
    }),

    outputSchema: Type.Object({
      handoff_id: Type.String(),
      target: Type.String(),
      document: Type.String(),
      outcome: Type.String({ description: "Where this handoff landed: delivered (handed to the target's session), unknown (cannot say — do not resend), not-delivered (no such peer)." }),
    }),

    async execute(_callId, params, _signal, onUpdate, ctx) {
      const { target, summary, handoff_document, kind } = params as any;
      if (!state.identity) throw new Error("xfer not initialised");
      const senderName = state.identity.name;

      const mid = msgId();
      const tmpFile = path.join(os.tmpdir(), `pi-xfer-${mid}.md`);
      const document = stampHandoffKind(stampDocument(handoff_document, thisCwdStamp()), kind);

      // 1. write handoff doc to tmp
      fs.writeFileSync(tmpFile, document, { encoding: "utf-8", mode: 0o600 });

      // 2. notify target
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `📨 Sending to "${target}"...` }],
          details: {},
        });
      }

      let outcome: XferNotifyOutcome;
      try {
        outcome = await sendNotify(target, {
          type: "xfer-notify",
          msg_id: mid,
          from: senderName,
          file: tmpFile,
          summary,
        });
      } catch (err: any) {
        const absent = /not found/.test(String(err?.message));
        // A `not-delivered` never reached a session, so the doc is safe to drop. An
        // `unknown` may already have arrived and been read — the target's delivery message
        // points at this path, so deleting it would leave a dangling reference.
        if (absent) {
          try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
        }
        if (absent) {
          throw new Error(
            `xfer: not delivered to "${target}" — ${err.message}` +
            ` — if this handoff arrived from the web picker, that sender is a browser userscript, not an xfer agent: do not xfer back; query the page via the broker page-tool CLI instead (see the doc's "Follow-up channel")`,
          );
        }
        // `unknown` never reads as "try again": a second send of the same content is
        // what turns an ambiguity into a real duplicate (ADR-0020).
        throw new Error(
          `xfer: outcome unknown for "${target}" — ${err.message}. The handoff may or may not ` +
          `have arrived; do not resend it. Check with the target before sending again.`,
        );
      }

      // 3. done, return immediately (no wait)
      return {
        content: [{
          type: "text",
          text: `✅ ${outcome} to "${target}" (handoff_id: ${mid})\n\nDoc: ${tmpFile}\n\n` +
                `Delivered means handed to the target's session — not that it has been read.\n\n` +
                (kind === "task"
                  ? `Task handoff — the target returns a conclusion once it has one.`
                  : `Notification handoff — no reply expected unless the target is missing information.`),
        }],
        details: {
          target,
          handoff_id: mid,
          document: tmpFile,
          outcome,
        },
        structuredContent: { handoff_id: mid, target, document: tmpFile, outcome },
      };
    },
  });

  // ── xfer_mesh_to tool (mesh transport, one-way, inline doc) ──
  pi.registerTool({
    name: "xfer_mesh_to",
    label: "Transfer to Mesh Node",
    description:
      "Send a one-way handoff markdown document to another Pi agent over the xfer mesh (cross-machine RivetKit transport); returns immediately with a handoff_id (no reply wait). Use /xfer mesh list for node names; the mesh must be online (/xfer mesh up). The document is sent inline. Declare `kind`: \"task\" asks the target for output and comes back with exactly one conclusion (done, blocked, or needing input); \"notification\" informs and stays silent unless the target lacks information or the document conflicts with fact. Never send a handoff that only acknowledges or confirms. Send only when the user asks for a handoff, or when you are blocked on that specific target and a reverse handoff is what unblocks you. Never send on your own initiative to check on another agent, to keep a thread alive, or to pass work to a third agent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    parameters: Type.Object({
      target: Type.String({ description: "Target mesh node name (see /xfer mesh list)." }),
      summary: Type.String({ description: "One-sentence summary of the request." }),
      handoff_document: Type.String({ description: "Full markdown handoff doc: context, problem, specific request, relevant files, suggested skills, notes." }),
      kind: Type.Union([Type.Literal("task"), Type.Literal("notification")], {
        description: "What this handoff asks of the target. \"task\": the target must produce output and returns one conclusion. \"notification\": it asks for nothing and stays silent. Never send a handoff whose only purpose is to acknowledge or confirm.",
      }),
    }),
    outputSchema: Type.Object({
      handoff_id: Type.String(),
      target: Type.String(),
      outcome: Type.String({ description: "Where this handoff landed: queued (on the engine, waiting for a runner), unknown (cannot say — do not resend), not-delivered (nothing was sent)." }),
    }),
    async execute(_callId, params, _signal, onUpdate, _ctx) {
      const { target, summary, handoff_document, kind } = params as any;
      if (onUpdate) {
        onUpdate({ content: [{ type: "text", text: `📨 Sending to mesh node "${target}"...` }], details: {} });
      }
      try {
        const document = stampHandoffKind(stampDocument(handoff_document, thisCwdStamp()), kind);
        const { id, warning } = await mesh.send(target, { summary, document });
        return {
          content: [{
            type: "text",
            text: `✅ queued on the mesh for "${target}" (handoff_id: ${id})\n\n` +
                  (warning ? `⚠️ ${warning}\n\n` : "") +
                  `Queued means the engine holds it until a runner in the target's pool picks it ` +
                  `up — not that it has been read.\n\n` +
                  (kind === "task"
                    ? `Task handoff — the target returns a conclusion once it has one.`
                    : `Notification handoff — no reply expected unless the target is missing information.`),
          }],
          details: { target, handoff_id: id, outcome: "queued", ...(warning ? { warning } : {}) },
          structuredContent: { handoff_id: id, target, outcome: "queued" },
        };
      } catch (err: any) {
        // An unknown outcome has its own headline in the error text; prefixing it
        // with "failed" here would re-assert what the triage just refused to. A
        // preflight refusal never reached the engine, so it is `not-delivered`.
        if (err?.kind === "not-delivered" || err?.kind === "unknown" || err?.kind === "failed") throw err;
        throw new Error(`xfer mesh: could not send to "${target}" — ${err.message}`);
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
