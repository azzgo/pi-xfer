import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import type { XferController } from "./controller.js";
import { getRemotePeer, listRemotePeers, type PeerSendEntry } from "./peers.js";
import { DEFAULT_SETTINGS_PATH, loadSettings } from "./settings.js";
import { endpointForName, listPeers, peerDescription } from "./utils.js";

/** Options for `registerXferCommand`. */
export interface XferCommandOptions {
  /** Remote-peer settings file; defaults to `~/.pi/xfer/settings.json` (tests inject a temp path). */
  settingsPath?: string;
}

/** One-line description of a remote peer: its note, or the head of its send template. */
function remotePeerDescription(peer: PeerSendEntry): string {
  if (peer.note) return peer.note;
  const head = peer.send.replace(/\s+/g, " ").trim();
  return head.length > 60 ? `send: ${head.slice(0, 57)}…` : `send: ${head}`;
}

/** Register the `/xfer` slash command. */
export function registerXferCommand(pi: ExtensionAPI, controller: XferController, options: XferCommandOptions = {}): void {
  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;

  pi.registerCommand("xfer", {
    description:
      "Xfer: one-way handoff to another Pi.\n" +
      "  /xfer <target> <request>  — generate doc and send\n" +
      "  /xfer list               — list peers\n" +
      "  /xfer peer <name> <req>  — send via remote peer (settings.json)\n" +
      "  /xfer name [<name>]      — show or set name",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // `/xfer peer <TAB>` completes remote settings peers only.
      if (prefix.startsWith("peer ")) {
        const namePrefix = prefix.slice("peer ".length).replace(/^\s+/, "");
        let remote: PeerSendEntry[] = [];
        try {
          remote = listRemotePeers(loadSettings(settingsPath));
        } catch {
          remote = [];
        }
        const items: AutocompleteItem[] = remote
          .filter(peer => peer.name.startsWith(namePrefix))
          .map(peer => ({ value: peer.name, label: peer.name, description: remotePeerDescription(peer) }));
        return items.length > 0 ? items : null;
      }

      const peers = listPeers(controller.state.identity?.name ?? "");
      const all: AutocompleteItem[] = [
        { value: "list", label: "list", description: "List available peers" },
        { value: "name", label: "name", description: "Show or set this agent's name" },
        { value: "peer", label: "peer", description: "Send to a remote peer from settings.json" },
        ...peers.map(peer => ({
          value: peer.xferName,
          label: peer.xferName,
          description: peerDescription(peer),
        })),
      ];
      const filtered = all.filter(i => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const state = controller.state;
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0];

      // ── help ──
      if (!cmd || cmd === "help") {
        ctx.ui.notify(
          "📡 /xfer <target> <request> — generate handoff doc\n" +
          "   /xfer list               — list peers\n" +
          "   /xfer peer <name> <req>  — send via remote peer (settings.json)\n" +
          "   /xfer name [<name>]      — show or set name\n" +

          "\n" +
          "💡 One-way, no wait. Reply via /xfer.",
          "info",
        );
        return;
      }

      // ── list ──
      if (cmd === "list") {
        const peers = listPeers(state.identity?.name ?? "");
        let text = peers.length
          ? `📡 Peers:\n\n${peers.map(peer => `  ${peer.xferName}\n    ${peerDescription(peer)}`).join("\n\n")}`
          : "📡 No peers found";

        let remote: PeerSendEntry[] = [];
        let settingsError: string | undefined;
        try {
          remote = listRemotePeers(loadSettings(settingsPath));
        } catch (err) {
          settingsError = err instanceof Error ? err.message : String(err);
        }
        text += `\n\n📡 Remote peers (settings.json):\n` + (remote.length
          ? remote.map(peer => `  ${peer.name}\n    ${remotePeerDescription(peer)}`).join("\n")
          : "  (none)");
        if (settingsError) text += `\n\n⚠️ Failed to load remote peers from ${settingsPath}: ${settingsError}`;

        ctx.ui.notify(text, "info");
        return;
      }

      // ── name (show or set) ──
      if (cmd === "name") {
        const newName = parts[1];
        if (!newName) {
          // show current xfer name + session name, and copy xfer name to clipboard
          if (!state.identity) return;
          const currentSessionName = state.sessionName();
          try {
            await copyToClipboard(state.identity.name);
            ctx.ui.notify(
              `📡 Xfer name: ${state.identity.name}\n` +
              `   Session name: ${currentSessionName ?? "(unnamed)"} (copied xfer name to clipboard)`,
              "info",
            );
          } catch {
            ctx.ui.notify(
              `📡 Xfer name: ${state.identity.name}\n` +
              `   Session name: ${currentSessionName ?? "(unnamed)"}`,
              "info",
            );
          }
          return;
        }
        await controller.rename(ctx, newName);
        return;
      }

      // ── /xfer peer <name> <requirement...> (remote settings peers) ──
      if (cmd === "peer") {
        const name = parts[1];
        const request = parts.slice(2).join(" ");
        if (!name || !request) {
          ctx.ui.notify(
            `Usage: /xfer peer <name> <request>\n` +
            `   Remote peers come from ${settingsPath} — see /xfer list`,
            "error",
          );
          return;
        }

        let peer: PeerSendEntry | undefined;
        try {
          peer = getRemotePeer(loadSettings(settingsPath), name);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`❌ Failed to load ${settingsPath} — ${message}`, "error");
          return;
        }
        if (!peer) {
          ctx.ui.notify(`❌ Remote peer "${name}" not found in ${settingsPath} — see /xfer list`, "error");
          return;
        }
        if (!state.identity) {
          ctx.ui.notify("❌ Xfer is not initialised", "error");
          return;
        }

        pi.sendUserMessage(
          `## Handoff Request (one-way, remote peer)\n\n` +
          `**Target**: ${name} (remote, via its settings.json send command)\n` +
          `**From**: ${state.identity.name}\n` +
          `**Request**: ${request}\n\n` +
          `Based on chat context, write a markdown handoff doc ` +
          `and call \`xfer_peer_to\` to send it to ${name} — ` +
          `use xfer_peer_to, not xfer_to (this target is a remote settings peer, not a local xfer socket).\n\n` +
          `Handoff doc must include:\n` +
          `- Context summary\n` +
          `- Problem to solve\n` +
          `- Specific requirements\n` +
          `- Relevant files/code references\n` +
          `- **Suggested skills**: Skills from the agent's repertoire that would help complete the task.\n` +
          `- **Return address**: from=\`${state.identity.name}\`. Only reply back if you have new information to share.\n` +
          `- Notes\n\n` +
          `Note: xfer_peer_to is one-way fire-and-forget (no reply wait); ` +
          `ok only means the peer's send command exited 0.`,
          { deliverAs: "followUp", triggerTurn: true },
        );
        return;
      }

      // ── /xfer <target> <requirement...> ──
      const target = cmd;
      const requirement = parts.slice(1).join(" ");
      if (!requirement) {
        ctx.ui.notify(`Usage: /xfer ${target} <request>`, "error");
        return;
      }

      if (!state.identity) {
        ctx.ui.notify("❌ Xfer is not initialised", "error");
        return;
      }
      const targetEndpoint = endpointForName(target);
      if (!fs.existsSync(targetEndpoint)) {
        ctx.ui.notify(`❌ Peer "${target}" not found — use /xfer list`, "error");
        return;
      }

      pi.sendUserMessage(
        `## Handoff Request (one-way)\n\n` +
        `**Target**: ${target}\n` +
        `**From**: ${state.identity.name}\n` +
        `**Request**: ${requirement}\n\n` +
        `Based on chat context, write a markdown handoff doc ` +
        `and call \`xfer_to\` to send it to ${target}.\n\n` +
        `Handoff doc must include:\n` +
        `- Context summary\n` +
        `- Problem to solve\n` +
        `- Specific requirements\n` +
        `- Relevant files/code references\n` +
        `- **Suggested skills**: Skills from the agent's repertoire that would help complete the task.\n` +
        `- **Return address**: from=\`${state.identity.name}\`. Only reply back if you have new information to share.\n` +
        `- Notes\n\n` +
        `Note: xfer is one-way, no reply wait. Returns handoff_id upon delivery.`,
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });
}
