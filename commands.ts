import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { AdminManager, DEFAULT_ADMIN_PORT } from "./admin-manager.ts";
import { registerBoard, renderCard } from "./board.ts";
import type { XferController } from "./controller.ts";
import { BrokerManager } from "./broker-manager.ts";
import { doctorSeverity, formatDoctorReport, runDoctor } from "./doctor.ts";
import { collectGarbage } from "./gc.ts";
import { MESH_CONFIG_PATH } from "./constants.ts";
import type { MeshNode } from "./mesh.ts";
import { ensureRunnerPool, listMeshNodes } from "./mesh-engine.ts";
import { meshLegendLine, meshSelfAdvice, meshSelfStatus, meshStatusLines, meshTableLines, meshUnreachableLines } from "./mesh-status.ts";
import { loadMeshConfig, resolveMeshConfig } from "./mesh-config.ts";
import { XFER_DIR } from "./constants.ts";
import { endpointForName, listPeers, peerDescription } from "./utils.ts";
import { linkStatus, listLinks, listOwnLinks, planSshUp, probeRemote, sshDown, sshUp, type LinkInfo, type SshLinkOptions, type SshUpPlan, type SshUpResult } from "./ssh-link.ts";
import { cachedHosts, cachedRemoteNames, listSshHosts, rememberRemoteNames } from "./ssh-hosts.ts";

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
  /** Admin daemon lifecycle manager; defaults to a real AdminManager (tests inject a stub). */
  adminManager?: AdminManager;
  /** Mesh engine config read by `/xfer doctor`; defaults to <xferDir>/mesh.config.json via MESH_CONFIG_PATH. */
  meshConfigPath?: string;
  /** Mesh transport node; when absent the `/xfer mesh` command group is unavailable. */
  mesh?: MeshNode;
  /** Override for ssh-link operations (tests stub this instead of spawning real ssh). */
  sshLink?: SshLinkOperations;
}

/** What `/xfer ssh` needs from the link layer — tests stub this instead of spawning real ssh. */
export interface SshLinkOperations {
  /** Every Link in the xfer dir, whoever owns it. */
  list(): LinkInfo[];
  /** Only the Links this pi process created — what `down` acts on. */
  own(): LinkInfo[];
  /** Bring a host's Link up (or extend it with more imported names). */
  up(host: string, names?: string[]): Promise<SshUpResult>;
  down(ident: string | undefined): Promise<{ torn: LinkInfo[] }>;
  plan(host: string, names?: string[]): Promise<SshUpPlan>;
  /** Read-only remote probe (the `in` candidate list): creates no tunnel. */
  probe(host: string): Promise<{ dir: string; names: string[] }>;
  status(link: LinkInfo): "up" | "dead" | "foreign";
}

/** Decode a Link's socket-file stem back into its remote node name. */
function decodeLinkName(stem: string): string {
  try { return decodeURIComponent(stem); } catch { return stem; }
}

/** Listener summary shared by `/xfer list` and `/xfer status`. */
function listenerSection(controller: XferController): string {
  const identity = controller.state.identity;
  let text = "\n\n📡 Listener:";
  text += `\n  unix socket: ${identity ? `${identity.endpoint} — name "${identity.name}"` : "(not initialised)"}`;
  return text;
}

/** Best-effort open of a URL in the system browser (fire-and-forget). */
function openUrl(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  import("node:child_process").then(({ spawn }) => {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  }).catch(() => { /* browser open is best-effort */ });
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
  const adminManager = options.adminManager ?? new AdminManager();
  const brokerXferDir = options.brokerXferDir ?? XFER_DIR;
  const xferDir = options.xferDir ?? XFER_DIR;
  const meshConfigPath = options.meshConfigPath ?? MESH_CONFIG_PATH;
  const sshOps: SshLinkOperations = options.sshLink ?? (() => {
    const sshOpts = (names?: string[]): SshLinkOptions =>
      ({ xferDir, myName: controller.state.identity?.name ?? "", names });
    return {
      list: () => listLinks(sshOpts()),
      own: () => listOwnLinks(sshOpts()),
      up: (host, names) => sshUp(host, sshOpts(names)),
      down: (ident) => sshDown(ident, sshOpts()),
      plan: (host, names) => planSshUp(host, sshOpts(names)),
      probe: (host) => probeRemote(host),
      status: (link) => linkStatus(link),
    };
  })();
  const board = registerBoard(pi, { boardDir: options.boardDir, getAuthor: () => controller.state.identity?.name ?? "unknown" });

  pi.registerCommand("xfer", {
    description:
      "Xfer: one-way handoff to another Pi.\n" +
      "  /xfer <target> <request>  — generate doc and send\n" +
      "  /xfer list               — list peers\n" +
      "  /xfer name [<name>]      — show or set name\n" +
      "  /xfer desc [<text>]     — set or clear this node's description (no text clears; synced to mesh when online)\n" +
      "  /xfer board <list|new|read|write|del|clean|open> — async collaboration board\n" +
      "  /xfer gc                 — reap zombie peer sockets (dead pid / no listener)\n" +
      "  /xfer broker <start|status|stop|logs> — broker daemon lifecycle\n" +
      "  /xfer admin [stop]       — local web console (idempotent start + open URL)\n" +
      "  /xfer doctor             — self-check the install (sockets / peers / broker / admin / mesh)",

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
      // `/xfer admin <TAB>` completes the admin subcommand group only.
      if (prefix.startsWith("admin ")) {
        const subPrefix = prefix.slice("admin ".length).replace(/^\s+/, "");
        const items: AutocompleteItem[] = [
          { value: "admin stop", label: "stop", description: "Stop the admin web console daemon" },
        ].filter(i => i.label.startsWith(subPrefix));
        return items.length > 0 ? items : null;
      }

      // `/xfer ssh <TAB>` completes the subcommand, then host aliases from
      // ~/.ssh/config, then that host's remote names (from the probe cache —
      // completion is synchronous and must never run ssh).
      if (prefix.startsWith("ssh ") || prefix === "ssh") {
        if (prefix === "ssh") {
          return [{ value: "ssh", label: "ssh", description: "SSH Link transport (ADR-0021): in / out / list / status / down" }];
        }
        const tokens = prefix.slice("ssh ".length).split(/\s+/);
        const sub = tokens[0];
        const subs: AutocompleteItem[] = [
          { value: "ssh in", label: "in", description: "Open/extend a bidirectional Link: /xfer ssh in <host> [name...]" },
          { value: "ssh list", label: "list", description: "Read-only probe of a host: /xfer ssh list <host>" },
          { value: "ssh status", label: "status", description: "Links this pi maintains, with liveness" },
          { value: "ssh down", label: "down", description: "Tear down a host Link this pi owns: /xfer ssh down [host]" },
        ];

        if (tokens.length === 1) {
          const items = subs.filter(i => i.label.startsWith(sub));
          return items.length > 0 ? items : null;
        }

        const hostToken = tokens[1] ?? "";

        if (sub === "down") {
          const ownLinks = sshOps.own();
          const items: AutocompleteItem[] = ownLinks.map(link => ({
            value: `ssh down ${link.host}`,
            label: link.host,
            description:
              `imports ${link.names.join(", ") || "nothing"} · you appear as "${link.reverseAs}"` +
              ` · ssh pid ${link.pid} · the whole host Link goes together`,
          }));
          if (items.length === 0) {
            return [{ value: "ssh down", label: "(none)", description: "This pi maintains no Links" }];
          }
          const filtered = items.filter(i => i.label.startsWith(hostToken));
          return filtered.length > 0 ? filtered : items;
        }

        const hosts = [...new Set([...listSshHosts(), ...cachedHosts(xferDir)])];
        if (tokens.length === 2) {
          const items = hosts
            .filter(h => h.startsWith(hostToken))
            .map(h => ({ value: `ssh ${sub} ${h}`, label: h, description: "ssh host" }));
          return items.length > 0 ? items : null;
        }

        // Third token onwards: only `in` takes remote names.
        if (sub !== "in") return null;
        const host = hostToken;
        const namePrefix = tokens[tokens.length - 1] ?? "";
        const linked = new Set(listOwnLinks({ xferDir, myName: controller.state.identity?.name ?? "" })
          .filter(l => l.host === host)
          .flatMap(l => l.names));
        const items = cachedRemoteNames(xferDir, host)
          .filter(n => n.startsWith(namePrefix) && !linked.has(n))
          .map(n => ({ value: `ssh in ${host} ${n}`, label: n, description: `remote node on ${host}` }));
        return items.length > 0
          ? items
          : [{ value: `ssh list ${host}`, label: `(probe ${host})`, description: "No cached names yet — run this to fetch them" }];
      }
      const peers = listPeers(controller.state.identity?.name ?? "", xferDir);
      // `/xfer mesh <TAB>` completes the mesh subcommand group.
      if (prefix.startsWith("mesh ") || prefix === "mesh") {
        if (prefix === "mesh") {
          return [{ value: "mesh", label: "mesh", description: "Mesh transport: status / up / down / list / <name> <request>" }];
        }
        const subPrefix = prefix.slice("mesh ".length).replace(/^\s+/, "");
        const items: AutocompleteItem[] = [
          { value: "mesh up", label: "up", description: "Bring this instance online as its xfer name (needs mesh.config.json)" },
          { value: "mesh status", label: "status", description: "This node's mesh state: online, pool, runner in that pool, engine reachability" },
          { value: "mesh down", label: "down", description: "Destroy this node and go offline" },
          { value: "mesh list", label: "list", description: "List mesh nodes (live engine query)" },
          { value: "mesh setup", label: "setup", description: "Verify mesh.config.json works: parse config, ensure the pool's runner-config, query the engine" },
        ].filter(i => i.label.startsWith(subPrefix));
        return items.length > 0 ? items : null;
      }
      const all: AutocompleteItem[] = [
        { value: "list", label: "list", description: "List available peers" },
        { value: "name", label: "name", description: "Show or set this agent's name" },
        { value: "desc", label: "desc", description: "Set or clear this node's description (what requests it handles; synced to mesh when online)" },
        { value: "broker", label: "broker", description: "Broker daemon: start / status / stop / logs" },
        { value: "admin", label: "admin", description: "Local web console: open (idempotent start) / stop" },
        { value: "board", label: "board", description: "Async collaboration board: list / new / read / write / del / clean / open" },
        { value: "gc", label: "gc", description: "Reap zombie peer sockets (dead pid / no listener)" },
        { value: "doctor", label: "doctor", description: "Self-check the install: socket dir / peers / broker / admin / mesh" },
        { value: "status", label: "status", description: "Show listener status" },
        { value: "mesh", label: "mesh", description: "Mesh transport: status / up / down / list / <name> <request>" },
        { value: "ssh", label: "ssh", description: "SSH Link: in <host> [name...] / list <host> / status / down [host]" },
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
          "   /xfer desc [<text>]     — set or clear this node's description (no text clears; synced to mesh when online)\n" +
          "   /xfer board list|new|read|write|del|clean|open — async collaboration board\n" +
          "   /xfer broker start|status|stop|logs — broker daemon lifecycle\n" +
          "   /xfer admin [stop]       — local web console (start is idempotent, opens the URL)\n" +
          "   /xfer mesh [<status|up|down|list|setup|name> <request>] — mesh transport\n" +
          "   /xfer ssh in <host> [name...] | list <host> | status | down — ssh Link (bidirectional)\n" +
          "   /xfer gc                 — reap zombie peer sockets\n" +
          "   /xfer doctor             — self-check the install and print fix hints\n" +

          "\n" +
          "💡 One-way, no wait. Declare the kind — a task comes back, a notification stays silent.",
          "info",
        );
        return;
      }

      // ── list ──
      if (cmd === "list") {
        const peers = listPeers(state.identity?.name ?? "", xferDir);
        const links = sshOps.list().map(l => ({ ...l, name: decodeLinkName(l.name) }));
        const linkNames = new Set(links.map(l => l.name));
        const peerLines = peers
          .filter(peer => !linkNames.has(peer.xferName) || peer.via !== "ssh")
          .map(peer => `  ${peer.xferName}\n    ${peerDescription(peer)}`);
        const linkLines = links
          .filter(l => !peers.some(p => p.xferName === l.name && p.via === "ssh"))
          .map(l => `  ${l.name}\n    remote node via ssh ${l.host} (Link, pid ${l.pid})`);
        const shown = [...peerLines, ...linkLines];
        let text = shown.length
          ? `📡 Peers:\n\n${shown.join("\n\n")}`
          : "📡 No peers found";
        text += listenerSection(controller);

        ctx.ui.notify(text, "info");
        return;
      }

      // ── /xfer ssh in|list|status|down — ssh Link transport (ADR-0021) ──
      if (cmd === "ssh") {
        const sub = parts[1];
        const host = parts[2];
        // names/extra args come AFTER the host; keeping host in `rest` made
        // every `list <host>` look like surplus arguments.
        const rest = parts.slice(3).filter(Boolean);
        const usage =
          "Usage: /xfer ssh in <host> [name...]  — open/extend a Link (bidirectional)\n" +
          "       /xfer ssh list <host>           — what <host> can offer (read-only probe)\n" +
          "       /xfer ssh status                — Links this pi maintains, with liveness\n" +
          "       /xfer ssh down [host|name]      — tear down this pi's Link to a host";

        if (!sub || sub === "help") {
          ctx.ui.notify(
            "🔗 /xfer ssh                       — ssh Link transport\n\n" +
            "   /xfer ssh in <host> [name...]    — import remote nodes into here (-L) AND export\n" +
            "                                      this pi to <host> (-R) in one tunnel\n" +
            "   /xfer ssh list <host>            — read-only: <host>'s xfer dir and its sockets\n" +
            "   /xfer ssh status                 — the Links this pi maintains (+ liveness)\n" +
            "   /xfer ssh down [host|name]       — tear down a whole host Link THIS pi started\n\n" +
            "A Link is always bidirectional: replies have a route by construction, so a `task`\n" +
            "over a Link is as safe as a local one. Running `in` again on the same host keeps\n" +
            "the names already imported and adds the new ones; the tunnel is rebuilt to do it.\n" +
            "Teardown is per host (ssh cannot drop one forward at runtime).",
            "info",
          );
          return;
        }

        if (sub === "list") {
          if (!host || rest.length > 0) {
            ctx.ui.notify("Usage: /xfer ssh list <host> — read-only probe of that machine's xfer dir", "error");
            return;
          }
          try {
            const remote = await sshOps.probe(host);
            const linked = new Set(sshOps.list().find(l => l.host === host)?.names ?? []);
            const nodes = remote.names.length
              ? remote.names.map(n => `  ${n}${linked.has(n) ? "   (already imported)" : ""}`).join("\n")
              : "  (no sockets)";
            ctx.ui.notify(
              `🔗 ${host} — xfer dir ${remote.dir}\n${nodes}\n\n` +
              (remote.names.length
                ? `Import any of them with: /xfer ssh in ${host} ${remote.names[0]}\n` +
                  `(a Link is bidirectional: it also exposes this pi there)`
                : `Nothing to import yet — an agent must be running there with a socket up.`),
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }

        if (sub === "status") {
          if (rest.length > 0) {
            ctx.ui.notify("Usage: /xfer ssh status — the Links this pi maintains", "error");
            return;
          }
          const all = sshOps.list();
          const mine = sshOps.own();
          const others = all.filter(l => !mine.some(m => m.host === l.host));
          const line = (l: LinkInfo, tag: string) => {
            const state = sshOps.status(l);
            const dot = state === "up" ? "🟢" : state === "dead" ? "⚫" : "⚪";
            const names = l.names.length ? l.names.join(", ") : "(nothing imported)";
            return `  ${dot} ${l.host} — imports ${names}; you appear there as "${l.reverseAs}"` +
              ` (ssh pid ${l.pid})${tag}`;
          };
          const sections = [
            mine.length ? `this pi:\n${mine.map(l => line(l, "")).join("\n")}` : "this pi: (none)",
            others.length
              ? `other pi processes (not yours to tear down):\n${others.map(l => line(l, " — foreign")).join("\n")}`
              : "",
          ].filter(Boolean);
          ctx.ui.notify(`🔗 ssh Links\n${sections.join("\n")}`, "info");
          return;
        }

        if (sub === "in") {
          if (!host) {
            ctx.ui.notify(
              `Usage: /xfer ssh in <host> [name...] — remote names to import.\n` +
              `Check what is there first: /xfer ssh list <host>`,
              "error",
            );
            return;
          }
          if (!state.identity) {
            ctx.ui.notify("❌ Xfer is not initialised", "error");
            return;
          }
          try {
            const result = await sshOps.up(host, rest.length > 0 ? rest : undefined);
            const added = result.added.length > 0 ? `\nadded: ${result.added.join(", ")}` : "";
            ctx.ui.notify(
              `🟢 Link to ${host} up (pid ${result.pid})${added}\n` +
              `imports: ${result.names.join(", ")}\n` +
              `this pi is reachable there as "${result.reverseAs}"`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }

        if (sub === "down") {
          if (rest.length > 0) {
            ctx.ui.notify("Usage: /xfer ssh down [host|name] — bare tears down every Link this pi started", "error");
            return;
          }
          const ident = host;
          if (!ident && sshOps.own().length === 0) {
            ctx.ui.notify("⭕ No ssh Links of ours — nothing to tear down", "info");
            return;
          }
          const { torn } = await sshOps.down(ident);
          const foreign = sshOps.list().filter(l => !sshOps.own().some(o => o.host === l.host));
          const notes = [
            foreign.length > 0 ? `${foreign.length} Link(s) belong to another pi process — left alone` : "",
          ].filter(Boolean);
          ctx.ui.notify(
            torn.length
              ? `🛑 Tore down ${torn.length} Link(s): ` +
                torn.map(l => `${l.host} (imports ${l.names.join(", ") || "nothing"})`).join("; ") +
                (notes.length ? `\n${notes.join("\n")}` : "")
              : `${ident ? `⭕ No Link this pi owns matches "${ident}"` : "⭕ No ssh Links of ours"}` +
                (notes.length ? `\n${notes.join("\n")}` : ""),
            "info",
          );
          return;
        }
        ctx.ui.notify(usage, "error");
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

      // ── desc (set or clear this node's description) ──
      // Stored locally in this node's <name>.json so it works without mesh;
      // synced to the mesh actor best-effort when online (and on /xfer mesh up).
      if (cmd === "desc") {
        const text = parts.slice(1).join(" ").trim();
        state.description = text || undefined;
        state.writeMetadata(true);
        const name = state.identity?.name ?? "this node";
        const mesh = options.mesh;
        if (mesh?.status().online) {
          try {
            const stored = await mesh.setDescription(text);
            ctx.ui.notify(
              stored
                ? `🪪 Node description set ("${name}", synced to mesh): ${stored}`
                : `🪪 Node description cleared ("${name}", synced to mesh)`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `⚠️ Saved locally, but mesh sync failed: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        } else {
          ctx.ui.notify(
            text
              ? `🪪 Node description set ("${name}", local only): ${text}`
              : `🪪 Node description cleared ("${name}", local only)`,
            "info",
          );
        }
        return;
      }

      // ── /xfer broker start|status|stop|logs (broker daemon) ──
      if (cmd === "broker") {
        const sub = parts[1];
        if (sub !== "start" && sub !== "status" && sub !== "stop" && sub !== "logs") {
          ctx.ui.notify("Usage: /xfer broker <start|status|stop|logs> — start accepts --port N (0 = ephemeral port)", "error");
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

      // ── /xfer admin [stop] — local web console daemon ──
      if (cmd === "admin") {
        const sub = parts[1];
        if (sub !== undefined && sub !== "stop" && sub !== "open") {
          ctx.ui.notify("Usage: /xfer admin [stop] — bare command starts (idempotently) and opens the console", "error");
          return;
        }
        if (sub === "stop") {
          try {
            const result = await adminManager.stop();
            ctx.ui.notify(result === "admin not running" ? "⭕ Admin not running" : `🛑 ${result}`, "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        try {
          const result = await adminManager.start();
          const info = await adminManager.probe();
          const url = `http://localhost:${info?.port ?? DEFAULT_ADMIN_PORT}`;
          openUrl(url);
          ctx.ui.notify(
            result === "already running" ? `🟡 Admin already running — ${url}` : `🟢 ${result}\n🌐 ${url}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // ── /xfer mesh — opt-in cross-machine transport ──
      if (cmd === "mesh") {
        const mesh = options.mesh;
        if (!mesh) {
          ctx.ui.notify("❌ Mesh transport is not available in this session", "error");
          return;
        }
        const sub = parts[1];
        if (!sub || sub === "help") {
          ctx.ui.notify(
            "🌐 /xfer mesh               — this help\n" +
            "   /xfer mesh status       — this node's state: online, pool, runner in that pool, engine reachability\n" +
            "   /xfer mesh up           — bring this instance online (as its xfer name)\n" +
            "   /xfer mesh down         — destroy this node and go offline\n" +
            "   /xfer mesh list         — every mesh node with its delivery verdict (live engine query)\n" +
            "   /xfer mesh setup        — verify mesh.config.json: config parse, pool runner-config, engine reachability\n" +
            "   /xfer mesh <name> <request> — send a one-way handoff via mesh",
            "info",
          );
          return;
        }
        if (sub === "up") {
          const name = state.identity?.name;
          if (!name) {
            ctx.ui.notify("❌ Xfer is not initialised", "error");
            return;
          }
          try {
            await mesh.up(name);
            if (state.description) {
              try { await mesh.setDescription(state.description); } catch { /* best effort */ }
            }
            ctx.ui.notify(`🟢 Mesh online as "${name}" (engine: ${MESH_CONFIG_PATH})`, "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        if (sub === "down") {
          try {
            await mesh.down();
            ctx.ui.notify("🛑 Mesh offline", "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        if (sub === "list") {
          try {
            const listing = await mesh.state();
            const status = mesh.status();
            const selfName = status.online ? status.name : null;
            const lines = meshTableLines(listing, selfName);
            const advice = meshSelfAdvice(meshSelfStatus(listing, { online: status.online, name: selfName }, mesh.config().pool));
            ctx.ui.notify(
              listing.nodes.length
                ? `🌐 Mesh nodes (${listing.nodes.length}):\n${lines.join("\n")}\n${meshLegendLine()}` +
                  (advice ? `\n⚠️ ${advice}` : "")
                : `🌐 No mesh nodes on the engine (${MESH_CONFIG_PATH}) — bring one up with /xfer mesh up`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        if (sub === "status") {
          const status = mesh.status();
          const shown = [status.online ? `online as "${status.name}"` : "offline in this session"];
          try {
            const listing = await mesh.state();
            const config = mesh.config();
            const selfStatus = meshSelfStatus(listing, { online: status.online, name: status.online ? status.name : null }, config.pool);
            ctx.ui.notify(`🌐 Mesh status — ${shown.join(", ")}\n${meshStatusLines(selfStatus, config.endpoint).join("\n")}`, "info");
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(
              `🌐 Mesh status — ${shown.join(", ")}\n${meshUnreachableLines(MESH_CONFIG_PATH, reason).join("\n")}`,
              "error",
            );
          }
          return;
        }
        if (sub === "setup") {
          try {
            const config = await resolveMeshConfig(loadMeshConfig(MESH_CONFIG_PATH));
            const lines = [`✓ config OK (${MESH_CONFIG_PATH}) — engine ${config.endpoint}`];
            if (config.pool) {
              const { existed } = await ensureRunnerPool(config);
              lines.push(existed ? `✓ runner-config "${config.pool}" already exists` : `✓ created runner-config "${config.pool}"`);
            } else {
              lines.push('ℹ no "pool" set — this host uses the engine default pool');
            }
            const nodes = await listMeshNodes(config);
            lines.push(`✓ engine reachable — ${nodes.length} node(s)`);
            lines.push('Next: /xfer mesh up');
            ctx.ui.notify(lines.join("\n"), "info");
          } catch (err) {
            ctx.ui.notify(`❌ ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        const target = sub;
        const requirement = parts.slice(2).join(" ").trim();
        if (!requirement) {
          ctx.ui.notify(`Usage: /xfer mesh ${target} <request>`, "error");
          return;
        }
        if (!mesh.status().online) {
          ctx.ui.notify("❌ Mesh is offline — run /xfer mesh up first", "error");
          return;
        }
        if (!state.identity) {
          ctx.ui.notify("❌ Xfer is not initialised", "error");
          return;
        }
        pi.sendUserMessage(
          `## Handoff Request (mesh, one-way)\n\n` +
          `**Target**: ${target} (mesh node — use the \`xfer_mesh_to\` tool, not \`xfer_to\`)\n` +
          `**From**: ${state.identity.name}\n` +
          `**Request**: ${requirement}\n\n` +
          `Based on chat context, write a markdown handoff doc ` +
          `and call \`xfer_mesh_to\` to send it to ${target} over the mesh.\n\n` +
          `Handoff doc must include:\n` +
          `- Context summary\n` +
          `- Problem to solve\n` +
          `- Specific requirements\n` +
          `- Relevant files/code references\n` +
          `- **Suggested skills**: Skills from the agent's repertoire that would help complete the task.\n` +
          `- **Kind**: pass \`kind\` to \`xfer_mesh_to\` — 'notification' when the target is only being told something, 'task' when it must produce output. A task returns a conclusion; a notification stays silent.\n` +
          `- **Return address**: from=\`${state.identity.name}\` — the reply target, for a task.\n` +
          `- Notes\n\n` +
          `Note: mesh xfer is one-way, no reply wait. The doc is sent inline (no /tmp path on the other machine).`,
          { deliverAs: "followUp", triggerTurn: true },
        );
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
        const reaped = report.zombies.filter(z => !z.reportOnly);
        const reported = report.zombies.filter(z => z.reportOnly);
        const line = (z: typeof report.zombies[number]): string => {
          const pid = z.pid !== undefined ? `pid ${z.pid}` : "no local pid";
          if (z.reportOnly) {
            return `  ${z.name} — a Link endpoint from another machine (${pid})\n` +
              `    left in place: its owner removes it when its Link closes.\n` +
              `    If it is stale, that machine should run /xfer ssh down.`;
          }
          return `  ${z.name} — ${z.reason} (${pid})` +
            (z.reason === "dead-link" && z.linkHost
              ? `\n    ssh tunnel killed; reconnect with /xfer ssh in ${z.linkHost}`
              : "");
        };
        const parts = [
          reaped.length > 0 ? `Removed ${reaped.length}:\n${reaped.map(line).join("\n")}` : "",
          reported.length > 0 ? `Reported ${reported.length} (not ours to delete):\n${reported.map(line).join("\n")}` : "",
        ].filter(Boolean);
        ctx.ui.notify(
          `🧹 ${parts.join("\n\n")}\nkept ${report.alive.length} live peer(s)`,
          "info",
        );
        return;
      }

      // ── /xfer doctor (read-only self-check) ──
      if (cmd === "doctor") {
        const report = await runDoctor({
          xferDir,
          myName: state.identity?.name ?? "",
          brokerManager,
          adminManager,
          meshConfigPath,
        });
        ctx.ui.notify(formatDoctorReport(report), doctorSeverity(report));
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
      const targetEndpoint = endpointForName(target, xferDir);
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
        `- **Kind**: pass \`kind\` to \`xfer_to\` — 'notification' when the target is only being told something, 'task' when it must produce output. A task returns a conclusion; a notification stays silent.\n` +
        `- **Return address**: from=\`${state.identity.name}\` — the reply target, for a task.\n` +
        `- Notes\n\n` +
        `Note: xfer is one-way, no reply wait. Returns handoff_id upon delivery.`,
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });
}
