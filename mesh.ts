import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMeshConfig, type MeshConfig } from "./mesh-config.ts";
import { createRivetEngine, type MeshEngine, type MeshHandoffMessage, type MeshNodeInfo } from "./mesh-engine.ts";
import type { XferNotifyMessage } from "./types.ts";
import { msgId } from "./utils.ts";

export interface MeshNodeOptions {
  /** Where mesh.config.json lives; defaults to XFER_DIR via the caller. */
  configPath: string;
  /** Route an inbound mesh handoff into the session (the local deliver pipeline). */
  deliver: (msg: XferNotifyMessage) => void;
  /** Engine factory override for tests. */
  engineFactory?: (config: MeshConfig) => MeshEngine;
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
  private readonly engineFactory: (config: MeshConfig) => MeshEngine;
  private engine: MeshEngine | null = null;
  private nodeName: string | null = null;

  constructor(options: MeshNodeOptions) {
    this.configPath = options.configPath;
    this.deliver = options.deliver;
    this.engineFactory = options.engineFactory ?? ((config) => createRivetEngine(config, (message) => this.onHandoff(message)));
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
    const engine = this.engineFactory(config);
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
    const message: MeshHandoffMessage = { id, from, summary: params.summary, document: params.document };
    await this.engine.queueSend(target, message);
    return { id };
  }

  async shutdown(): Promise<void> {
    if (!this.engine) return;
    try { await this.down(); } catch { /* best effort on process exit */ }
  }

  /** Inbound queue message → tmp doc on this machine → local deliver pipeline. */
  private onHandoff(message: MeshHandoffMessage): void {
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

  private requireEngine(): MeshEngine {
    if (!this.engine) throw new Error("mesh is not online — run /xfer mesh up first");
    return this.engine;
  }
}
