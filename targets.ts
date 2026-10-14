import * as fs from "node:fs";
import * as path from "node:path";
import { XFER_DIR } from "./constants.ts";
import type { TargetInfo } from "./types.ts";
import { decodeAgentName } from "./utils.ts";

/** Metadata-less fields used when the sibling `<name>.json` is absent or unreadable. */
type SiblingMetadata = Pick<TargetInfo, "sessionName" | "cwd" | "status" | "description">;

const NULL_METADATA: SiblingMetadata = { sessionName: null, cwd: null, status: null };

/**
 * Best-effort read of `sessionName`/`cwd`/`status` from one `<name>.json` sibling,
 * mirroring utils.readPeerMetadata's tolerant parsing: any I/O or JSON error,
 * non-object body, or wrong-typed field degrades to null instead of throwing —
 * a filesystem scan must never fail on a peer's stale metadata.
 */
function readSiblingMetadata(metadataPath: string): SiblingMetadata {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NULL_METADATA;
    const value = raw as Record<string, unknown>;
    return {
      sessionName: typeof value.sessionName === "string" ? value.sessionName : null,
      cwd: typeof value.cwd === "string" ? value.cwd : null,
      status: typeof value.status === "string" ? value.status : null,
      ...(typeof value.description === "string" && value.description.trim() !== "" ? { description: value.description } : {}),
    };
  } catch {
    return NULL_METADATA;
  }
}

/**
 * Live local target scan: one entry per `*.sock` file in `xferDir`, sorted by name.
 * Read-only — unlike utils.listPeers it never mkdirs the directory; a missing or
 * unreadable dir yields []. The sibling `<name>.json` (same base name as the socket,
 * no re-encoding round trip) is merged in best-effort. `status`/`cwd`/`sessionName`
 * are honest filesystem facts only: whatever the metadata file last wrote, null when
 * absent — no socket connectivity is probed.
 */
export function listTargets(xferDir: string = XFER_DIR): TargetInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(xferDir);
  } catch {
    return [];
  }
  return entries
    .filter((file) => file.endsWith(".sock"))
    .map((sockFile): TargetInfo => {
      const base = sockFile.replace(/\.sock$/, "");
      return { name: decodeAgentName(base), ...readSiblingMetadata(path.join(xferDir, `${base}.json`)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-target description lookup; resolve undefined when unknown or unreachable. */
export type TargetDescriber = (name: string) => Promise<string | undefined>;

/**
 * {@link listTargets} plus a best-effort description per target — the one place
 * the picker send flow gets them without an extra round-trip. A describe that
 * rejects (offline actor, engine down, no mesh configured) just omits the field:
 * the target listing itself must never fail because of it.
 */
export async function listTargetsWithDescriptions(
  xferDir: string = XFER_DIR,
  describe?: TargetDescriber,
): Promise<TargetInfo[]> {
  const targets = listTargets(xferDir);
  if (!describe) return targets;
  return Promise.all(
    targets.map(async (target): Promise<TargetInfo> => {
      let description: string | undefined;
      try {
        description = await describe(target.name);
      } catch {
        description = undefined;
      }
      const trimmed = description?.trim();
      return trimmed ? { ...target, description: trimmed } : target;
    }),
  );
}
