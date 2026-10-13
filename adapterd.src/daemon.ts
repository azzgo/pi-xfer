import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { MESH_CONFIG_PATH, XFER_DIR } from "../constants.ts";
import { MeshNode, type MeshNodeOptions } from "../mesh.ts";
import type { MeshConfig } from "../mesh-config.ts";
import { createRivetEngine } from "../mesh-engine.ts";
import { createServer } from "../server.ts";
import type { XferNotifyMessage } from "../types.ts";
import { endpointForName, metadataForName } from "../utils.ts";
import { appendInbox, inboxPathForName, type InboxRecord } from "./inbox.ts";

/** Where an inbound handoff goes, one step at a time (first = always). */
export type DeliverTransport = "local" | "mesh";

/** Optional mesh join for `up`: config from a file, a parsed override, or tests. */
export interface AdapterdMeshOptions {
  /** Path to mesh.config.json; used when `config` is absent. */
  configPath?: string;
  /** Pre-parsed config (CLI --engine/--namespace/--token fallback). */
  config?: MeshConfig;
  /** Engine factory override for tests. */
  engineFactory?: NonNullable<MeshNodeOptions["engineFactory"]>;
}

export interface AdapterdOptions {
  /** Node name; defaults to an `agent-` prefixed name at the CLI layer. */
  name: string;
  /** Socket/metadata/inbox directory; defaults to XFER_DIR. */
  dir?: string;
  /** Agent Host kind recorded in peer metadata (cursor / generic / …). */
  host?: string;
  /** Extra deliver strategy: run `<cmd>` with the handoff JSON on stdin. */
  onHandoff?: string;
  /** Exit after the first delivered handoff (smoke / single-shot hosts). */
  once?: boolean;
  /** Invoked after a `once` shutdown completes; the CLI exits the process here. */
  onOnce?: () => void;
  /** Join the mesh as this daemon's name after the local listener is up. */
  mesh?: AdapterdMeshOptions;
}


export interface AdapterdHandle {
  name: string;
  endpoint: string;
  metadataPath: string;
  inboxPath: string;
  /** True when this daemon joined the mesh. */
  meshOnline: boolean;
  /** Resolves when every spawned `--on-handoff` command has exited. */
  pendingHandoffs(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Start an Adapter Daemon: a local Unix-socket listener that speaks the same
 * `xfer-notify`/ack JSONL protocol as the pi extension, plus an append-only
 * Inbox owned by this name. Delivery is inbox-first and best-effort beyond it:
 * a failing deliver strategy must never take the daemon down.
 */
export async function startAdapterd(options: AdapterdOptions): Promise<AdapterdHandle> {
  const name = options.name;
  const dir = options.dir ?? XFER_DIR;
  const endpoint = endpointForName(name, dir);
  const metadataPath = metadataForName(name, dir);
  const inboxPath = inboxPathForName(name, dir);
  const startedAt = Date.now();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  for (const stale of [endpoint, metadataPath]) {
    try { fs.unlinkSync(stale); } catch { /* absent is fine */ }
  }

  const handoffChildren = new Set<Promise<void>>();
  let closed = false;

  const writeMetadata = (): void => {
    const metadata = {
      xferName: name,
      sessionName: `${options.host ?? "generic"} adapter`,
      cwd: process.cwd(),
      model: "adapterd",
      status: "idle",
      pid: process.pid,
      startedAt,
      kind: "adapterd",
      host: options.host ?? "generic",
      inbox: inboxPath,
    };
    const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
    const temp = `${metadataPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, serialized, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temp, metadataPath);
      try { fs.chmodSync(metadataPath, 0o600); } catch { /* best effort */ }
    } catch {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  };

  /**
   * Extra deliver strategy `url` (POST the handoff to an HTTP endpoint) is
   * deferred pending research; no flag is reserved for it here.
   */
  const spawnHandoff = (record: InboxRecord): void => {
    if (!options.onHandoff) return;
    let child;
    try {
      child = spawn(options.onHandoff, {
        shell: true,
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          ...process.env,
          XFER_HANDOFF_ID: record.id,
          XFER_HANDOFF_FROM: record.from,
          XFER_HANDOFF_FILE: record.file,
        },
      });
    } catch (err) {
      console.error(`[xfer-adapterd] --on-handoff failed to spawn: ${errorText(err)}`);
      return;
    }
    const done = new Promise<void>((resolve) => {
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    }).then(() => { handoffChildren.delete(done); });
    handoffChildren.add(done);
    child.stdin?.on("error", () => { /* command may ignore stdin */ });
    try {
      child.stdin?.end(JSON.stringify(record));
    } catch (err) {
      console.error(`[xfer-adapterd] --on-handoff stdin failed: ${errorText(err)}`);
    }
  };

  const delivered = (msg: XferNotifyMessage, transport: DeliverTransport): void => {
    let document: string | null = null;
    try { document = fs.readFileSync(msg.file, "utf-8"); } catch { document = null; }
    const record: InboxRecord = {
      id: msg.msg_id,
      from: msg.from,
      to: name,
      summary: msg.summary,
      file: msg.file,
      document,
      transport,
      received_at: new Date().toISOString(),
    };
    try {
      appendInbox(record, inboxPath);
    } catch (err) {
      console.error(`[xfer-adapterd] inbox append failed for ${record.id}: ${errorText(err)}`);
      return;
    }
    spawnHandoff(record);
    if (options.once && !closed) {
      closed = true;
      setImmediate(() => { void close().then(() => options.onOnce?.()); });
    }
  };

  const server = createServer({ deliver: (msg) => delivered(msg, "local") });
  await listen(server, endpoint);
  writeMetadata();

  let meshNode: MeshNode | null = null;
  if (options.mesh) {
    meshNode = new MeshNode({
      configPath: options.mesh.configPath ?? MESH_CONFIG_PATH,
      config: options.mesh.config,
      deliver: (msg) => delivered(msg, "mesh"),
      engineFactory: options.mesh.engineFactory ?? ((config, onHandoff) => createRivetEngine(config, onHandoff)),
    });
    try {
      await meshNode.up(name);
    } catch (err) {
      meshNode = null;
      try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* not listening */ }
      try { fs.unlinkSync(endpoint); } catch { /* already gone */ }
      try { fs.unlinkSync(metadataPath); } catch { /* already gone */ }
      throw err;
    }
  }
  const meshOnline = meshNode !== null;

  const close = async (): Promise<void> => {
    if (!closed) closed = true;
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* not listening */ }
    // Sockets opened before close can keep the callback waiting; force them shut.
    try { server.closeAllConnections?.(); } catch { /* older node */ }
    try { fs.unlinkSync(endpoint); } catch { /* already gone */ }
    try { fs.unlinkSync(metadataPath); } catch { /* already gone */ }
    if (meshNode) {
      const joined = meshNode;
      meshNode = null;
      try { await joined.shutdown(); } catch { /* best effort on exit */ }
    }
    await Promise.all([...handoffChildren]);
  };

  return {
    name,
    endpoint,
    metadataPath,
    inboxPath,
    meshOnline,
    pendingHandoffs: () => Promise.all([...handoffChildren]).then(() => undefined),
    close,
  };
}

/** Bind + chmod the socket, rejecting on a bind error. */
function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      try { fs.chmodSync(endpoint, 0o600); } catch { /* best effort */ }
      resolve();
    });
    server.listen(endpoint);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default daemon name: always `agent-` prefixed (explicit names are used as-is). */
export function defaultAdapterName(cwd: string = process.cwd()): string {
  const base = path.basename(cwd).trim() || "host";
  return `agent-${base}`;
}
