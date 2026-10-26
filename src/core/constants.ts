import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMeshConfigPath } from "../mesh/mesh-guard.ts";

/** Root directory for xfer peer sockets + peer metadata. */
export const XFER_DIR = path.join(os.homedir(), ".pi", "xfer");

/** Mesh engine config (endpoint/namespace/token) for the opt-in mesh transport. */
export const MESH_CONFIG_PATH = resolveMeshConfigPath(path.join(XFER_DIR, "mesh.config.json"));

/** Download cache for the mesh native runtime binary (never in git). */
export const MESH_CACHE_DIR = path.join(XFER_DIR, "cache");

export const CONNECT_TIMEOUT_MS = 5_000;
export const ACK_TIMEOUT_MS = 5_000;
export const METADATA_POLL_MS = 1_000;
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Deadline for a mesh engine query (node listing) before the engine counts as unreachable. */
export const MESH_PROBE_TIMEOUT_MS = 2_500;

/**
 * The pi-xfer version this process was loaded from (package.json at the
 * extension root). Undefined outside the install layout — a repo checkout with
 * a missing/garbled package.json is a broken install, not a version.
 */
export function readPackageVersion(extensionRoot: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf-8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version !== "" ? raw.version : null;
  } catch {
    return null;
  }
}
