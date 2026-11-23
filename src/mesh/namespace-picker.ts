import { isNamespaceSlug } from "./mesh-config.ts";

export const NAMESPACE_ESCAPE_VALUE = "\0typed";

export interface NamespaceRow {
  value: string;
  label: string;
  description?: string;
  kind: "namespace" | "escape";
}

export interface NamespaceRowInput {
  names: string[];
  current: string;
  defaultName: string;
  listingError: string | null;
  typed: string;
}

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

export function escapeRow(typed: string): NamespaceRow {
  const name = typed.trim();
  return {
    value: NAMESPACE_ESCAPE_VALUE,
    label: name === "" ? "use the typed namespace (not listed — unverified)" : `use "${name}" (not listed — unverified)`,
    description: "unverified",
    kind: "escape",
  };
}

export function filterRows(rows: NamespaceRow[], typed: string): NamespaceRow[] {
  const needle = typed.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) => row.kind === "escape" || row.value.toLowerCase().includes(needle));
}

export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((current + delta) % length + length) % length;
}

export function emptyMatchNotice(typed: string, listingError: string | null, rows: NamespaceRow[]): string | null {
  if (listingError !== null) return null;
  const name = typed.trim();
  if (name === "") return null;
  const needle = name.toLowerCase();
  if (rows.some((row) => row.kind === "namespace" && row.value.toLowerCase().includes(needle))) return null;
  return `no namespace matches "${name}" on this engine`;
}

export function pickerHeader(current: string, defaultName: string): string {
  const suffix = defaultName !== current ? ` (default: ${defaultName})` : "";
  return `Mesh namespace — now: ${current}${suffix}`;
}
