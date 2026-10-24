import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { loadMeshConfig, resolveMeshConfig, type MeshConfig } from "./mesh-config.ts";
import {
  deriveMeshNodeState,
  findMeshNode,
  listMeshState,
  meshSendFailureFields,
  preflightMeshSend,
  type MeshEngine,
  type MeshHandoffMessage,
  type MeshListing,
  type MeshNodeInfo,
  type MeshNodeState,
  type MeshPreflight,
  type RivetEngineOptions,
} from "./mesh-engine.ts";
import { MESH_LOG_PATH, logMeshEvent } from "./mesh-log.ts";
import type { XferNotifyMessage } from "../core/types.ts";
import { msgId } from "../core/utils.ts";

/** Name of the committed esbuild bundle hosting the rivetkit runtime. */
export const MESH_RUNTIME_BUNDLE = "mesh-runtime.cjs";

/**
 * Load the committed rivetkit runtime bundle (mesh-runtime.cjs, built by
 * `npm run build`). Throws with recovery guidance when missing.
 */
export const MESH_RUNTIME_DIR = path.resolve(import.meta.dirname, "../..");
export async function loadMeshRuntimeBundle(dir = MESH_RUNTIME_DIR): Promise<any> {
  const bundleUrl = url.pathToFileURL(path.join(dir, MESH_RUNTIME_BUNDLE)).href;
  try {
    const mod = await import(bundleUrl);
    if (typeof mod?.createRivetEngine !== "function") throw new Error("bundle does not export createRivetEngine");
    return mod;
  } catch (err) {
    throw new Error(
      `mesh runtime bundle unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
      `run \`npm run build\` in the xfer extension directory to rebuild ${MESH_RUNTIME_BUNDLE}`,
    );
  }
}

export interface MeshNodeOptions {
  /** Where mesh.config.json lives; defaults to XFER_DIR via the caller. */
  configPath: string;
  /** Already-parsed config override (adapter daemon flags); wins over configPath. */
  config?: MeshConfig;
  /** Route an inbound mesh handoff into the session (the local deliver pipeline). */
  deliver: (msg: XferNotifyMessage) => void;
  /** Where mesh lifecycle events are appended; defaults to MESH_LOG_PATH. */
  logPath?: string;
  /** Engine factory override for tests; receives the inbound-handoff sink. */
  engineFactory?: (
    config: MeshConfig,
    onHandoff: (message: MeshHandoffMessage, selfKey: string) => void,
    options?: RivetEngineOptions,
  ) => MeshEngine | Promise<MeshEngine>;
}

export type MeshStatus =
  | { online: false }
  | { online: true; name: string };

/**
 * Lifecycle + messaging for this instance's mesh node. One instance per pi
 * process; opt-in via `/xfer mesh up`, torn down via `/xfer mesh down`.
 */
export class MeshNode {
  private readonly configPath: string;
  private readonly configOverride?: MeshConfig;
  private readonly deliver: (msg: XferNotifyMessage) => void;
  private readonly engineFactory: NonNullable<MeshNodeOptions["engineFactory"]>;
  private readonly logPath: string;
  private engine: MeshEngine | null = null;
  private nodeName: string | null = null;

  constructor(options: MeshNodeOptions) {
    this.configPath = options.configPath;
    this.configOverride = options.config;
    this.deliver = options.deliver;
    this.logPath = options.logPath ?? MESH_LOG_PATH;
    this.engineFactory = options.engineFactory ?? (async (config, onHandoff, engineOptions) => {
      const bundle = await loadMeshRuntimeBundle();
      return bundle.createRivetEngine(config, onHandoff, {}, engineOptions);
    });
  }

  status(): MeshStatus {
    return this.engine && this.nodeName ? { online: true, name: this.nodeName } : { online: false };
  }

  /**
   * The pool this host's runner joins, and the engine it points at.
   *
   * Deliberately **unresolved**: a `$VAR` or `!command` token stays in
   * `tokenExpression` and is never evaluated or spawned, because every caller of
   * this is a display path (`/xfer mesh list`, `/xfer mesh status`) that reads
   * `pool` and `endpoint`. Anything that talks to the engine calls
   * {@link resolveMeshConfig} itself.
   */
  config(): MeshConfig {
    return this.configOverride ?? loadMeshConfig(this.configPath);
  }

  /** Live engine listing of all mesh nodes (no cache). */
  async list(): Promise<MeshNodeInfo[]> {
    return this.requireEngine().listNodes();
  }

  /**
   * Live listing plus the runner side of the same engine round, for surfaces
   * that must say whether a node can actually receive (`/xfer mesh list`).
   * Works without an engine of our own: listing is an observer operation, so it
   * answers with or without `up`.
   */
  async state(): Promise<MeshListing> {
    if (this.engine) return this.engine.state();
    return listMeshState(await resolveMeshConfig(this.configOverride ?? loadMeshConfig(this.configPath)));
  }

  /** One node's verdict, joined against its pool's live runners. */
  async nodeState(target: string): Promise<{ node: MeshNodeInfo | null; state: MeshNodeState; listing: MeshListing }> {
    const listing = await this.state();
    const node = findMeshNode(listing.nodes, target);
    return { node, state: node ? deriveMeshNodeState(node, listing.envoys) : "Unknown", listing };
  }

  /** Pre-send check for a target; rejects with MeshPreflightError when it cannot receive. */
  async preflight(target: string): Promise<MeshPreflight> {
    if (this.engine) return this.engine.preflight(target);
    const config = await resolveMeshConfig(this.configOverride ?? loadMeshConfig(this.configPath));
    return preflightMeshSend(config, target);
  }
  /**
   * Bring this instance online as `name`, adopting a same-name actor that is
   * not currently Running (Sleeping / Idle / Crashed / Pending). Adoption
   * re-resolves the existing actor in this process so the run loop belongs here
   * and durable actor state (the node description) is preserved; it never destroys.
   *
   * A Running actor means another host owns the name right now — refusing is the
   * only safe answer, because the same key would silently route this process's
   * traffic to that host.
   */
  async up(name: string): Promise<void> {
    const current = this.status();
    if (current.online) throw new Error(`mesh is already online as "${current.name}" — /xfer mesh down first`);
    const config = await resolveMeshConfig(this.configOverride ?? loadMeshConfig(this.configPath));
    const session = {
      node: name,
      endpoint: config.endpoint,
      namespace: config.namespace ?? "default",
      pool: config.pool ?? "(default)",
      nativeLogLevel: process.env.RIVET_LOG_LEVEL ?? "silent",
    };
    const engine = await this.engineFactory(
      config,
      (message, selfKey) => this.onHandoff(message, selfKey),
      { logPath: this.logPath },
    );
    const existing = await engine.listNodes();
    const conflict = existing.find((node) => node.name === name);
    if (conflict?.status === "Running") {
      logMeshEvent(this.logPath, "error", "mesh up refused — node is Running elsewhere", {
        ...session,
        owner: conflict.pool ?? "(default)",
      });
      throw new Error(
        `mesh node "${name}" is already Running on another host — run /xfer mesh down there first (先在那边 /xfer mesh down)`,
      );
    }
    if (conflict) this.assertPoolMatch(name, conflict.pool, config.pool);
    try {
      await engine.ensureNode(name);
    } catch (err) {
      try { await engine.stop(); } catch { /* best effort */ }
      logMeshEvent(this.logPath, "error", "mesh up failed", {
        ...session,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    this.engine = engine;
    this.nodeName = name;
    logMeshEvent(this.logPath, "info", "mesh up", {
      ...session,
      adopted: conflict ? (conflict.status ?? "unknown") : "no",
    });
  }

  /**
   * Take this instance offline: destroy its actor, then disconnect. This is the
   * only path that destroys — status-aware up() adopts a non-Running actor
   * without destroying it.
   */
  async down(): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.nodeName) throw new Error("mesh is not online");
    const name = this.nodeName;
    this.engine = null;
    this.nodeName = null;
    let actorId: string | undefined;
    try {
      const nodes = await engine.listNodes();
      const mine = nodes.find((node) => node.name === name);
      if (mine) {
        actorId = mine.actorId;
        await engine.destroyNode(mine.actorId);
      }
    } finally {
      await engine.stop();
    }
    logMeshEvent(this.logPath, "info", "mesh down", { node: name, actor: actorId ?? "(not found)" });
  }

  /**
   * Per-node describe: this node's own capability note. The only built-in read
   * path — listings stay names-only, so consumers loop this and cache locally.
   */
  async describe(target: string): Promise<{ name: string; description: string }> {
    return { name: target, description: await this.requireEngine().getDescription(target) };
  }

  /** Set this node's description (trimmed, capped by the actor). "" clears it. */
  async setDescription(text: string): Promise<string> {
    return this.requireEngine().setDescription(text);
  }

  /**
   * Fire-and-forget inline handoff to another mesh node.
   *
   * A failure throws a `MeshSendError`, whose `kind` is the triage of the
   * enqueue — "not-delivered" (the engine refused it), "unknown" (we stopped
   * waiting, so it may still arrive) or "failed". Passing `id` re-sends the same
   * handoff under the original id, which is the recovery probe the receiver's
   * dedupe window covers; minting a fresh id instead would read as a new handoff.
   */
  async send(
    target: string,
    params: { summary: string; document: string },
    id: string = msgId(),
  ): Promise<{ id: string; warning: string | null }> {
    const from = this.nodeName;
    if (!this.engine || !from) throw new Error("mesh is not online — run /xfer mesh up first");
    const message: MeshHandoffMessage = { id, from, to: target, summary: params.summary, document: params.document };
    let warning: string | null = null;
    try {
      const verified = await this.engine.preflight(target);
      warning = verified.warning;
      await this.engine.queueSend(target, message, verified);
    } catch (err) {
      logMeshEvent(this.logPath, "error", "mesh send failed", {
        from,
        to: target,
        id,
        bytes: params.document.length,
        ...meshSendFailureFields(err),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    logMeshEvent(this.logPath, "info", "mesh send", { from, to: target, id, bytes: params.document.length });
    return { id, warning };
  }

  async shutdown(): Promise<void> {
    if (!this.engine) return;
    try { await this.down(); } catch { /* best effort on process exit */ }
  }

  /**
   * An adopted actor keeps its original pool placement — `getOrCreate` with a
   * different `poolName` does not move it. Detecting the mismatch here turns a
   * silent "migration succeeded but the actor still lives on the old pool"
   * into an actionable error, including the restart-pi caveat: a pre-pool
   * extension build cannot fix this on its own.
   */
  private assertPoolMatch(name: string, actorPool: string | undefined, configPool: string | undefined): void {
    const actor = actorPool || undefined;
    const config = configPool || undefined;
    if (actor === config) return;
    const desired = config ? `"${config}"` : "the default pool";
    const actual = actor ? `"${actor}"` : "the default pool";
    logMeshEvent(this.logPath, "error", "mesh up refused — actor pool mismatch", { node: name, actorPool: actual, configPool: desired });
    throw new Error(
      `mesh node "${name}" was placed in ${actual} but this config targets ${desired} — ` +
      `an existing actor cannot change pools. Run "/xfer mesh down" (this destroys the old actor, ` +
      `dropping its queued handoffs and description) then "/xfer mesh up" in this session — no name argument — ` +
      `in a freshly restarted pi process (an older extension build without pool support must not perform the migration)`,
    );
  }

  /**
   * Inbound queue message → tmp doc on this machine → local deliver pipeline.
   *
   * `selfKey` is the actor key this process actually owns. A message addressed
   * to a different node means the transport misrouted it; delivering it here
   * would silently hand the wrong agent a handoff, so it is refused and
   * reported instead. Messages without `to` predate this check and are
   * delivered for compatibility.
   */
  private onHandoff(message: MeshHandoffMessage, selfKey: string): void {
    if (message.to !== undefined && message.to !== selfKey) {
      this.onMisroute(message, selfKey);
      return;
    }
    const docPath = path.join(os.tmpdir(), `pi-xfer-${message.id}.md`);
    fs.writeFileSync(docPath, message.document, { encoding: "utf-8", mode: 0o600 });
    logMeshEvent(this.logPath, "info", "mesh inbound", {
      id: message.id,
      from: message.from,
      to: message.to ?? "(unaddressed)",
      bytes: message.document.length,
      doc: docPath,
    });
    this.deliver({
      type: "xfer-notify",
      msg_id: message.id,
      from: message.from,
      file: docPath,
      summary: message.summary,
    });
  }

  /**
   * A handoff addressed elsewhere reached this node: the mesh transport
   * misrouted it. Surface it rather than dropping it silently — the sender
   * otherwise sees a successful send while the message never arrives. Surfaced
   * through the deliver pipeline only: this runs inside the host process, where
   * a console line lands on the TUI rather than in a log.
   */
  private onMisroute(message: MeshHandoffMessage, selfKey: string): void {
    const detail =
      `mesh misroute: handoff ${message.id} from "${message.from}" was addressed to ` +
      `"${message.to}" but reached "${selfKey || "<unknown>"}" — refusing to deliver it here`;
    logMeshEvent(this.logPath, "warn", "mesh misroute", {
      id: message.id,
      from: message.from,
      to: message.to ?? "(unaddressed)",
      reached: selfKey || "(unknown)",
    });
    this.deliver({
      type: "xfer-notify",
      msg_id: message.id,
      from: message.from,
      file: "(refused — misrouted)",
      summary: `⚠️ ${detail}`,
    });
  }

  private requireEngine(): MeshEngine {
    if (!this.engine) throw new Error("mesh is not online — run /xfer mesh up first");
    return this.engine;
  }
}
