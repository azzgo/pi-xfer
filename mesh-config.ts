import * as fs from "node:fs";

/** Mesh engine config, stored at ~/.pi/xfer/mesh.config.json. */
export interface MeshConfig {
  endpoint: string;
  namespace?: string;
  token?: string;
}

/** Single actor type hosting one mesh node per pi instance. */
export const XFER_INSTANCE_ACTOR = "xfer-instance";

/** Queue carrying inline handoff payloads between mesh nodes. */
export const HANDOFF_QUEUE = "handoff";

/**
 * Parse + validate a mesh config object. Accepts namespace/token inline in the
 * endpoint via URL auth (`https://ns:token@host`) when the explicit fields are
 * absent. Throws with a human-readable message when malformed.
 */
export function parseMeshConfig(raw: unknown): MeshConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mesh config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || obj.endpoint.trim() === "") {
    throw new Error('mesh config needs a non-empty "endpoint"');
  }
  const config: MeshConfig = { endpoint: obj.endpoint.trim() };
  if (typeof obj.namespace === "string" && obj.namespace !== "") config.namespace = obj.namespace;
  if (typeof obj.token === "string" && obj.token !== "") config.token = obj.token;
  return withUrlAuth(config);
}

/** Fill namespace/token from URL auth syntax when not set explicitly. */
function withUrlAuth(config: MeshConfig): MeshConfig {
  try {
    const url = new URL(config.endpoint);
    if (!config.namespace && url.username) config.namespace = decodeURIComponent(url.username);
    if (!config.token && url.password) config.token = decodeURIComponent(url.password);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      config.endpoint = url.toString();
    }
  } catch { /* endpoint stays as-is; rivetkit validates it */ }
  return config;
}

/** Read + parse the mesh config file; throws when missing or malformed. */
export function loadMeshConfig(configPath: string): MeshConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`mesh not configured — create ${configPath} ({ endpoint, namespace?, token? })`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`mesh config is not valid JSON: ${configPath} — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMeshConfig(raw);
}

/**
 * Serialize an actor key the way the engine does (`/`-joined with escaping) so
 * REST list results can be matched against an expected key. Mirrors rivetkit's
 * serializeActorKey for the shapes mesh keys use (non-empty string parts).
 */
export function serializeMeshKey(key: string[]): string {
  if (key.length === 0) return "/";
  return key
    .map((part) =>
      part === "" ? "\\0" : part.replace(/\\/g, "\\\\").replace(/\//g, "\\/"),
    )
    .join("/");
}

export function deserializeMeshKey(serialized: string | undefined): string[] {
  if (serialized === undefined || serialized === null || serialized === "/" || serialized === "") return [];
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of serialized) {
    if (escaped) {
      current += ch === "0" ? "" : ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "/") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}
