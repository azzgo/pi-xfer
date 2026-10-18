/**
 * The one place a mesh node's delivery verdict becomes words. Both surfaces
 * (`/xfer mesh list`, `/xfer mesh status`, the admin console) render from here,
 * so the CLI and the browser can never disagree about what `○` means.
 *
 * Vocabulary, fixed by ADR 0013 and P0-A: `●` running, `◐` sleeping, `○` no
 * runner in the pool, `⚠` the actor record and `/envoys` disagree, `·` pending,
 * `✗` crashed, `?` unknown (the engine did not answer). "Offline" is never one
 * of these words: a node listed by the engine is a node the engine knows about,
 * and a missing `/envoys` answer is ignorance, not absence.
 */
import {
  deriveMeshNodeState,
  meshPoolName,
  type MeshListing,
  type MeshNodeInfo,
  type MeshNodeState,
} from "./mesh-engine.ts";

/** Glyph + short label per state, in the order a reader scans them. */
export const MESH_STATE_ORDER: MeshNodeState[] = ["Running", "Sleeping", "NoRunner", "Mismatch", "Pending", "Crashed", "Unknown"];

export const MESH_STATE_MARKS: Record<MeshNodeState, { glyph: string; label: string }> = {
  Running: { glyph: "●", label: "running" },
  Sleeping: { glyph: "◐", label: "sleeping" },
  NoRunner: { glyph: "○", label: "no runner" },
  Mismatch: { glyph: "⚠", label: "mismatch" },
  Pending: { glyph: "·", label: "pending" },
  Crashed: { glyph: "✗", label: "crashed" },
  Unknown: { glyph: "?", label: "unknown" },
};

export interface MeshRowView {
  name: string;
  state: MeshNodeState;
  glyph: string;
  label: string;
  pool: string;
  /** A runner exists in this node's pool. */
  poolHasRunner: boolean;
  isSelf: boolean;
}

/** A pool's display name: the engine's default pool reads "(default)", matching the older surfaces. */
export function poolLabel(pool: string | undefined): string {
  const name = meshPoolName(pool);
  return name === "default" ? "(default)" : name;
}

/** One row per listed node, with this node marked. */
export function meshRows(listing: MeshListing, selfName: string | null): MeshRowView[] {
  return listing.nodes.map((node) => toRow(node, listing, selfName));
}

function toRow(node: MeshNodeInfo, listing: MeshListing, selfName: string | null): MeshRowView {
  const state = deriveMeshNodeState(node, listing.envoys);
  const pool = poolLabel(node.pool);
  const mark = MESH_STATE_MARKS[state];
  return {
    name: node.name,
    state,
    glyph: mark.glyph,
    label: mark.label,
    pool,
    poolHasRunner: (listing.envoys ?? []).some((envoy) => envoy.pool === meshPoolName(node.pool)),
    isSelf: selfName !== null && node.name === selfName,
  };
}

/** Why a row reads the way it does, pinned to the pool rather than the node. */
function rowReason(row: MeshRowView, envoysKnown: boolean): string {
  if (!envoysKnown) return "the engine did not answer /envoys — its pool's runners are unknown";
  switch (row.state) {
    case "NoRunner":
      return `no runner in pool "${row.pool}"`;
    case "Mismatch":
      return `pool "${row.pool}" has a runner, but the actor record still reads idle`;
    case "Running":
      return `running in pool "${row.pool}"`;
    case "Sleeping":
      return `asleep in pool "${row.pool}" — wakes on delivery`;
    case "Pending":
      return `waiting for an allocation in pool "${row.pool}"`;
    default:
      return "";
  }
}

/** Display width in terminal columns: the verdict glyphs are East-Asian ambiguous (1 or 2 cells). */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/** One line per node, aligned: glyph, name, verdict, pool, reason. */
export function meshTableLines(listing: MeshListing, selfName: string | null): string[] {
  const rows = meshRows(listing, selfName);
  const envoysKnown = listing.envoys !== null;
  const labelled = rows.map((row) => ({
    row,
    name: row.isSelf ? `${row.name} (this node)` : row.name,
    pool: `pool ${row.pool}`,
    reason: rowReason(row, envoysKnown),
  }));
  const nameWidth = Math.max(0, ...labelled.map((entry) => entry.name.length));
  const labelWidth = Math.max(0, ...labelled.map((entry) => entry.row.label.length));
  const poolWidth = Math.max(0, ...labelled.map((entry) => entry.pool.length));
  return labelled.map(({ row, name, pool, reason }) => {
    const head = `  ${row.glyph} ${pad(name, nameWidth)}  ${pad(row.label, labelWidth)}  ${pad(pool, poolWidth)}`;
    return reason ? `${head}  — ${reason}` : head.trimEnd();
  });
}

/** The legend printed under a table, so the glyphs are never folklore. */
export function meshLegendLine(): string {
  return `  ${MESH_STATE_ORDER.map((state) => `${MESH_STATE_MARKS[state].glyph} ${MESH_STATE_MARKS[state].label}`).join(" · ")}`;
}

export interface MeshSelfStatus {
  online: boolean;
  name: string | null;
  pool: string;
  poolHasRunner: boolean;
  actorState: MeshNodeState | null;
  envoysKnown: boolean;
  runnerCount: number;
  nodeCount: number;
}

export function meshSelfStatus(
  listing: MeshListing,
  self: { online: boolean; name: string | null },
  configuredPool: string | undefined,
): MeshSelfStatus {
  const pool = meshPoolName(configuredPool);
  const own = self.name === null ? null : listing.nodes.find((node) => node.name === self.name) ?? null;
  return {
    online: self.online,
    name: self.name,
    pool,
    poolHasRunner: (listing.envoys ?? []).some((envoy) => envoy.pool === pool),
    actorState: own ? deriveMeshNodeState(own, listing.envoys) : null,
    envoysKnown: listing.envoys !== null,
    runnerCount: (listing.envoys ?? []).filter((envoy) => envoy.pool === pool).length,
    nodeCount: listing.nodes.length,
  };
}

/** `/xfer mesh status`: this host's answer to "can anything reach me?". */
export function meshStatusLines(status: MeshSelfStatus, endpoint: string): string[] {
  const runnerDetail = !status.envoysKnown
    ? `the engine did not answer /envoys — whether pool "${status.pool}" has a runner is unknown`
    : status.poolHasRunner
      ? `${status.runnerCount} live runner(s) in pool "${status.pool}" — handoffs sent here are picked up`
      : `no runner in pool "${status.pool}" — this machine cannot receive a handoff`;
  const runnerGlyph = !status.envoysKnown ? "?" : status.poolHasRunner ? "●" : "○";
  const entries: Array<[string, string, string]> = [
    status.online
      ? ["●", "this node", `"${status.name}" — online in this session (actor reachable through the engine)`]
      : ["○", "this node", "not up in this session — nothing runs here until /xfer mesh up (its actor, if any, is not consuming its queue)"],
    ["◐", "engine", endpoint],
    [runnerGlyph, "runner", runnerDetail],
  ];
  if (status.envoysKnown) {
    entries.push(["·", "listing", `${status.nodeCount} node(s) on the engine — /xfer mesh list for all of them`]);
  }
  if (!status.poolHasRunner && status.envoysKnown) {
    entries.push(["→", "fix", `run a runner in pool "${status.pool}" on this machine (open pi here), then retry`]);
  }
  const labelWidth = Math.max(...entries.map(([, label]) => label.length));
  return entries.map(([glyph, label, detail]) => `  ${glyph} ${pad(label, labelWidth)}  ${detail}`);
}

/** Advisory printed with the listing when this host cannot receive. */
export function meshSelfAdvice(status: MeshSelfStatus): string | null {
  if (!status.online || !status.envoysKnown || status.poolHasRunner) return null;
  return `this node's pool "${status.pool}" has no runner — handoffs sent here queue until one appears`;
}
