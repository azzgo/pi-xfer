import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { loadMeshConfig, type MeshConfig } from "./mesh-config.ts";
import type { MeshEngine, MeshHandoffMessage, MeshNodeInfo } from "./mesh-engine.ts";
import type { XferNotifyMessage } from "./types.ts";
import { msgId } from "./utils.ts";

/** Name of the committed esbuild bundle hosting the rivetkit runtime. */
export const MESH_RUNTIME_BUNDLE = "mesh-runtime.cjs";

/**
 * Load the committed rivetkit runtime bundle (mesh-runtime.cjs, built by
 * `npm run build`). Throws with recovery guidance when missing.
 */
export async function loadMeshRuntimeBundle(dir = import.meta.dirname): Promise<any> {
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
  /** Route an inbound mesh handoff into the session (the local deliver pipeline). */
  deliver: (msg: XferNotifyMessage) => void;
  /** Engine factory override for tests; defaults to loading the committed mesh-runtime.cjs bundle. */
  engineFactory?: (config: MeshConfig) => MeshEngine | Promise<MeshEngine>;
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
  private readonly deliver: (msg: XferNotifyMessage) => void;
  private readonly engineFactory: (config: MeshConfig) => MeshEngine | Promise<MeshEngine>;
  private engine: MeshEngine | null = null;
  private nodeName: string | null = null;

  constructor(options: MeshNodeOptions) {
    this.configPath = options.configPath;
    this.deliver = options.deliver;
    this.engineFactory = options.engineFactory ?? (async (config) => {
      const bundle = await loadMeshRuntimeBundle();
      return bundle.createRivetEngine(config, (message: MeshHandoffMessage, selfKey: string) => this.onHandoff(message, selfKey));
    });
  }

  status(): MeshStatus {
    return this.engine && this.nodeName ? { online: true, name: this.nodeName } : { online: false };
  }

  /** Live engine listing of all mesh nodes (no cache). */
  async list(): Promise<MeshNodeInfo[]> {
    return this.requireEngine().listNodes();
  }

  /**
   * Bring this instance online as `name`. Refuses when a node with the same
   * key already exists on the engine (same key would silently route to the
   * pre-existing actor).
   */
  async up(name: string): Promise<void> {
    const current = this.status();
    if (current.online) throw new Error(`mesh is already online as "${current.name}" — /xfer mesh down first`);
    const config = loadMeshConfig(this.configPath);
    const engine = await this.engineFactory(config);
    const existing = await engine.listNodes();
    const conflict = existing.find((node) => node.name === name);
    if (conflict) {
      throw new Error(`mesh node "${name}" already exists on the engine (actor ${conflict.actorId}) — pick another name via /xfer name`);
    }
    await engine.ensureNode(name);
    this.engine = engine;
    this.nodeName = name;
  }

  /** Take this instance offline: destroy its actor, then disconnect. */
  async down(): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.nodeName) throw new Error("mesh is not online");
    const name = this.nodeName;
    this.engine = null;
    this.nodeName = null;
    try {
      const nodes = await engine.listNodes();
      const mine = nodes.find((node) => node.name === name);
      if (mine) await engine.destroyNode(mine.actorId);
    } finally {
      await engine.stop();
    }
  }

  /** Fire-and-forget inline handoff to another mesh node. */
  async send(target: string, params: { summary: string; document: string }): Promise<{ id: string }> {
    const id = msgId();
    const from = this.nodeName;
    if (!this.engine || !from) throw new Error("mesh is not online — run /xfer mesh up first");
    const message: MeshHandoffMessage = { id, from, to: target, summary: params.summary, document: params.document };
    await this.engine.queueSend(target, message);
    return { id };
  }

  async shutdown(): Promise<void> {
    if (!this.engine) return;
    try { await this.down(); } catch { /* best effort on process exit */ }
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
   * otherwise sees a successful send while the message never arrives.
   */
  private onMisroute(message: MeshHandoffMessage, selfKey: string): void {
    const detail =
      `mesh misroute: handoff ${message.id} from "${message.from}" was addressed to ` +
      `"${message.to}" but reached "${selfKey || "<unknown>"}" — refusing to deliver it here`;
    console.warn(`[xfer] ${detail}`);
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
