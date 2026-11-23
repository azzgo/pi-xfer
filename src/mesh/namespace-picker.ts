/**
 * The namespace picker's decisions, kept apart from its rendering so they can be
 * tested without a terminal (the TUI component lives in
 * `namespace-picker-ui.ts`, which is a thin shell over this).
 *
 * The two outcomes are the whole point: **Enter** applies a namespace to this
 * process only, **ctrl+s** writes it as the Default namespace. A listing that
 * fails must not block the switch — a scoped token is a normal deployment — so
 * the only escape hatch is a row that exists solely while the listing failed.
 */

import { isNamespaceSlug } from "./mesh-config.ts";

/** Marker value of the "use what I typed" row; never a real namespace. */
export const NAMESPACE_ESCAPE_VALUE = "\0typed";

/** One selectable row, in the order the picker shows it. */
export interface NamespaceRow {
  value: string;
  label: string;
  description?: string;
  /** `escape` rows exist only when the engine listing could not be read. */
  kind: "namespace" | "escape";
}

/**
 * A row is only offered when the name could actually be selected. The authored
 * `namespace` may be an expression (`$MESH_NS`), which is named in the header but
 * is not a namespace anyone can switch to.
 */
export interface NamespaceRowInput {
  /** Namespaces the engine listed, already sorted. Ignored when `listingError` is set. */
  names: string[];
  /** The Effective namespace of this process. */
  current: string;
  /** The Default namespace from the config. */
  defaultName: string;
  /** Why the listing could not be read, or `null` when it could. */
  listingError: string | null;
  /** What the user has typed so far, for the escape row's label. */
  typed: string;
}

/**
 * Rows for one picker opening: current first (the cursor lands there), then the
 * Default namespace when it differs, then the rest in engine order. While the
 * listing is unavailable there is nothing to order, so the rows are current,
 * default, and the escape hatch.
 */
export function namespaceRows(input: NamespaceRowInput): NamespaceRow[] {
  const rows: NamespaceRow[] = [];
  const push = (name: string, description?: string) => {
    if (!isNamespaceSlug(name)) return;
    if (rows.some((row) => row.value === name)) return;
    rows.push({ value: name, label: name, ...(description ? { description } : {}), kind: "namespace" });
  };
  push(input.current, "current");
  push(input.defaultName, "default");
  if (input.listingError !== null) {
    rows.push(escapeRow(input.typed));
    return rows;
  }
  for (const name of input.names) push(name);
  return rows;
}

/** The one escape row: labelled with what the user typed, so the label is the confirmation. */
export function escapeRow(typed: string): NamespaceRow {
  const name = typed.trim();
  return {
    value: NAMESPACE_ESCAPE_VALUE,
    label: name === "" ? "use the typed namespace (not listed — unverified)" : `use "${name}" (not listed — unverified)`,
    description: "unverified",
    kind: "escape",
  };
}

/**
 * Apply the filter ourselves (case-insensitive substring) instead of leaving it
 * to `SelectList`, which only matches a **prefix** — a filter that ignores
 * "stag" inside a longer name is a worse filter than no filter. `SelectList`
 * is then always given its own empty filter, so its rule cannot drop a row this
 * one kept. Escape rows survive every filter: they are the action, not a
 * candidate.
 */
export function filterRows(rows: NamespaceRow[], typed: string): NamespaceRow[] {
  const needle = typed.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) => row.kind === "escape" || row.value.toLowerCase().includes(needle));
}

/**
 * What to say when the filter matched nothing while the engine listing *did*
 * work: that is a typo, not a permission problem — so there is no escape row,
 * and the text says which typed name matched nothing.
 */
export function emptyMatchNotice(typed: string, listingError: string | null, rows: NamespaceRow[]): string | null {
  if (listingError !== null) return null;
  const name = typed.trim();
  if (name === "") return null;
  const needle = name.toLowerCase();
  if (rows.some((row) => row.kind === "namespace" && row.value.toLowerCase().includes(needle))) return null;
  return `no namespace matches "${name}" on this engine`;
}

/** Header line: which engine and which listing state the rows came from. */
export function pickerHeader(current: string, defaultName: string): string {
  const suffix = defaultName !== current ? ` (default: ${defaultName})` : "";
  return `Mesh namespace — now: ${current}${suffix}`;
}
