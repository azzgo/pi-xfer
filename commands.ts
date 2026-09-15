import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerBoard, renderCard } from "./board.js";
import type { XferController } from "./controller.js";
import { BrokerManager } from "./broker-manager.js";
import { collectGarbage } from "./gc.js";
import { XFER_DIR } from "./constants.js";
import { endpointForName, listPeers, peerDescription } from "./utils.js";

/** Options for `registerXferCommand`. */
export interface XferCommandOptions {
  /** Broker lifecycle manager; defaults to a real BrokerManager (tests inject a stub). */
  brokerManager?: BrokerManager;
  /** Directory holding broker.log; defaults to the broker manager's xferDir (XFER_DIR). */
  brokerXferDir?: string;
  /** Directory scanned by `/xfer gc` for zombie peer sockets; defaults to XFER_DIR. */
  xferDir?: string;
  /** Board directory; defaults to ~/.pi/xfer/board. */
  boardDir?: string;
}

/** Listener summary shared by `/xfer list` and `/xfer status`. */
function listenerSection(controller: XferController): string {
  const identity = controller.state.identity;
  let text = "\n\n📡 Listener:";
  text += `\n  unix socket: ${identity ? `${identity.endpoint} — name "${identity.name}"` : "(not initialised)"}`;
  return text;
}

/** How many trailing broker.log lines `/xfer broker logs` shows. */
const LOG_TAIL_LINES = 50;

/** Tail of <xferDir>/broker.log — last ~50 non-empty lines, or an explanatory note. */
function brokerLogTail(xferDir: string, lines = LOG_TAIL_LINES): string {
  const logPath = path.join(xferDir, "broker.log");
  try {
    const tail = fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-lines);
    return tail.length > 0 ? tail.join("\n") : `(empty) ${logPath}`;
  } catch {
    return `broker.log unavailable at ${logPath}`;
  }
}

/** Register the `/xfer` slash command. */
export function registerXferCommand(pi: ExtensionAPI, controller: XferController, options: XferCommandOptions = {}): void {
  const brokerManager = options.brokerManager ?? new BrokerManager();
  const brokerXferDir = options.brokerXferDir ?? XFER_DIR;
  const xferDir = options.xferDir ?? XFER_DIR;
  const board = registerBoard(pi, { boardDir: options.boardDir, getAuthor: () => controller.state.identity?.name ?? "unknown" });

  pi.registerCommand("xfer", {
    description:
      "Xfer: one-way handoff to another Pi.\n" +
      "  /xfer <target> <request>  — generate doc and send\n" +
      "  /xfer list               — list peers\n" +
      "  /xfer name [<name>]      — show or set name\n" +
      "  /xfer board <list|new|read|write|del|clean|open> — async collaboration board\n" +
      "  /xfer gc                 — reap zombie peer sockets (dead pid / no listener)\n" +
      "  /xfer broker <start|status|stop|logs> — broker daemon lifecycle",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // `/xfer board <TAB>` completes board subcommands, then card ids.
      if (prefix.startsWith("board") && (prefix.length === 5 || prefix.startsWith("board "))) {
        return board.completions(prefix.slice(5));
      }
      // `/xfer broker <TAB>` completes the broker subcommand group only.
      if (prefix.startsWith("broker ")) {
        const subPrefix = prefix.slice("broker ".length).replace(/^\s+/, "");
        const items: AutocompleteItem[] = [
          { value: "broker start", label: "start", description: "Start the broker daemon (--port N to pin, 0 = ephemeral; already-running is a no-op)" },
          { value: "broker status", label: "status", description: "Show broker status (port/pid)" },
          { value: "broker stop", label: "stop", description: "Stop the broker daemon" },
          { value: "broker logs", label: "logs", description: "Show the last broker.log lines" },
        ].filter(i => i.label.startsWith(subPrefix));
        return items.length > 0 ? items : null;
      }

      const peers = listPeers(controller.state.identity?.name ?? "");
      const all: AutocompleteItem[] = [
        { value: "list", label: "list", description: "List available peers" },
        { value: "name", label: "name", description: "Show or set this agent's name" },
        { value: "broker", label: "broker", description: "Broker daemon: start / status / stop / logs" },
        { value: "board", label: "board", description: "Async collaboration board: list / new / read / write / del / clean / open" },
        { value: "gc", label: "gc", description: "Reap zombie peer sockets (dead pid / no listener)" },
        { value: "status", label: "status", description: "Show listener status" },
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
          "   /xfer status             — listener status\n" +
          "   /xfer name [<name>]      — show or set name\n" +
          "   /xfer board list|new|read|write|del|clean|open — async collaboration board\n" +
          "   /xfer broker start|status|stop|logs — broker daemon lifecycle\n" +
          "   /xfer gc                 — reap zombie peer sockets\n" +

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
        text += listenerSection(controller);

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

      // ── /xfer broker start|status|stop|logs (broker daemon) ──
      if (cmd === "broker") {
        const sub = parts[1];
        if (sub !== "start" && sub !== "status" && sub !== "stop" && sub !== "logs") {
          ctx.ui.notify("Usage: /xfer broker <start|status|stop|logs> — start 可带 --port N (0 = 临时端口)", "error");
          return;
        }
        if (sub === "start") {
          // Optional `--port N` pins the daemon port for this start (0 =
          // ephemeral). A live broker.pid keeps it a no-op ("already running")
          // regardless of the port — the pid is the source of truth, not the
          // port (broker-main.ts pre-bind pid check).
          let requested: number | undefined;
          const portIdx = parts.indexOf("--port");
          if (portIdx >= 0) {
            requested = Number.parseInt(parts[portIdx + 1] ?? "", 10);
            if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
              ctx.ui.notify("❌ --port needs an integer 0..65535 (0 = ephemeral)", "error");
              return;
            }
          }
          try {
            const result = await brokerManager.start(requested);
            ctx.ui.notify(result === "already running" ? "🟡 Broker already running" : `🟢 ${result}`, "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        if (sub === "status") {
          // status() never rejects (chrome-devtools convention: read the output, not the exit code).
          ctx.ui.notify(await brokerManager.status(), "info");
          return;
        }
        if (sub === "stop") {
          try {
            const result = await brokerManager.stop();
            ctx.ui.notify(result === "broker not running" ? "⭕ Broker not running" : `🛑 ${result}`, "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        // logs — tail <xferDir>/broker.log without touching the daemon.
        ctx.ui.notify(brokerLogTail(brokerXferDir), "info");
        return;
      }

      // ── /xfer board — async collaboration board ──
      if (cmd === "board") {
        const sub = parts[1];
        const author = state.identity?.name ?? "unknown";
        const rest = parts.slice(2);

        if (!sub || sub === "help") {
          ctx.ui.notify(
            "📋 /xfer board list              — list cards\n" +
            "   /xfer board new [title...]   — create a card (title optional — the agent names it)\n" +
            "   /xfer board read <id>        — inject a card into the conversation\n" +
            "   /xfer board write <id> <intent> — the agent composes an entry from your intent\n" +
            "   /xfer board del <id>         — delete a single card\n" +
            "   /xfer board clean            — delete all cards\n" +
            "   /xfer board open             — open the board directory in the file manager",
            "info",
          );
          return;
        }

        if (sub === "list") {
          const cards = board.board.list();
          ctx.ui.notify(
            cards.length
              ? `📋 Board (${cards.length} card(s)):\n\n` + cards.map(c => `  ${c.id} — ${c.title}\n    by ${c.createdBy} · ${c.createdAt}`).join("\n")
              : "📋 Board is empty",
            "info",
          );
          return;
        }

        if (sub === "new") {
          const title = rest.join(" ").trim();
          if (title) {
            const card = board.board.create(title, author);
            ctx.ui.notify(`🆕 ${card.id} — ${card.title}`, "info");
            return;
          }
          // Two-phase: the agent names the card and writes the first entry.
          board.board.setPending({ cardId: null, isNew: true });
          pi.sendUserMessage(
            `## Board Card Request\n\n` +
            `Based on the current conversation, open a new card on the collaboration board: ` +
            `give it a concise title and write the first entry capturing the topic.\n\n` +
            `Reply with ONLY a fenced code block tagged \`board-entry\`, nothing else:\n\n` +
            "```board-entry\n" +
            "title: <concise card title>\n" +
            "type: note | finding | question | answer\n" +
            "---\n" +
            "<markdown body of the first entry>\n" +
            "```",
            { deliverAs: "followUp", triggerTurn: true },
          );
          return;
        }

        if (sub === "read") {
          const id = rest[0];
          const card = id ? board.board.read(id) : null;
          if (!card) {
            ctx.ui.notify(`❌ Card not found: ${id ?? "(no id given)"} — see /xfer board list`, "error");
            return;
          }
          pi.sendUserMessage(
            `## Board Card (read-only injection)\n\n\`${card.id}\` — ${card.title}\n\n` +
            renderCard(card) +
            "\nThe human injected this card for your awareness. Do not take action yet — wait for their instruction.",
            { deliverAs: "followUp", triggerTurn: true },
          );
          return;
        }

        if (sub === "write") {
          const id = rest[0];
          const intent = rest.slice(1).join(" ").trim();
          const card = id ? board.board.read(id) : null;
          if (!card) {
            ctx.ui.notify(`❌ Card not found: ${id ?? "(no id given)"} — see /xfer board list`, "error");
            return;
          }
          if (!intent) {
            ctx.ui.notify("Usage: /xfer board write <id> <intent> — describe what to record", "error");
            return;
          }
          board.board.setPending({ cardId: card.id, isNew: false });
          pi.sendUserMessage(
            `## Board Entry Request\n\n` +
            `Card \`${card.id}\` — ${card.title}\n\n` +
            `Human intent: ${intent}\n\n` +
            `Based on the conversation and this intent, compose one entry for the card.\n\n` +
            `Reply with ONLY a fenced code block tagged \`board-entry\`, nothing else:\n\n` +
            "```board-entry\n" +
            "type: note | finding | question | answer\n" +
            "---\n" +
            "<markdown body of the entry>\n" +
            "```",
            { deliverAs: "followUp", triggerTurn: true },
          );
          return;
        }

        if (sub === "del") {
          const id = rest[0];
          const card = id ? board.board.read(id) : null;
          if (!card) {
            ctx.ui.notify(`❌ Card not found: ${id ?? "(no id given)"} — see /xfer board list`, "error");
            return;
          }
          const ok = await ctx.ui.confirm("Delete card", `Delete ${card.id} — ${card.title}?`);
          if (!ok) return;
          board.board.del(card.id);
          ctx.ui.notify(`🗑️ Deleted ${card.id}`, "info");
          return;
        }

        if (sub === "clean") {
          const cards = board.board.list();
          if (cards.length === 0) {
            ctx.ui.notify("📋 Board is already empty", "info");
            return;
          }
          const ok = await ctx.ui.confirm("Clean board", `Delete all ${cards.length} card(s)? This cannot be undone.`);
          if (!ok) return;
          const removed = board.board.clean();
          ctx.ui.notify(`🧹 Removed ${removed.length} card(s)`, "info");
          return;
        }

        if (sub === "open") {
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
          import("node:child_process").then(({ spawn }) => {
            spawn(opener, [board.board.dir], { detached: true, stdio: "ignore" }).unref();
          });
          ctx.ui.notify(`📂 ${board.board.dir}`, "info");
          return;
        }

        ctx.ui.notify(`Usage: /xfer board <list|new|read|write|del|clean|open>`, "error");
        return;
      }

      // ── /xfer gc (reap zombie peer sockets) ──
      if (cmd === "gc") {
        const report = await collectGarbage(xferDir);
        if (report.zombies.length === 0) {
          ctx.ui.notify(`🧹 No zombie sockets — ${report.alive.length} live peer(s)`, "info");
          return;
        }
        const lines = report.zombies.map((z) => {
          const pid = z.pid !== undefined ? `pid ${z.pid}` : "no metadata";
          return `  ${z.name} — ${z.reason} (${pid})`;
        });
        ctx.ui.notify(
          `🧹 Removed ${report.zombies.length} zombie(s):\n${lines.join("\n")}\n` +
          `kept ${report.alive.length} live peer(s)`,
          "info",
        );
        return;
      }

      // ── /xfer status (listener summary) ──
      if (cmd === "status") {
        ctx.ui.notify(listenerSection(controller).trimStart(), "info");
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
