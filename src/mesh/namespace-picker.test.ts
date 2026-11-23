import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NAMESPACE_ESCAPE_VALUE,
  emptyMatchNotice,
  escapeRow,
  filterRows,
  namespaceRows,
  pickerHeader,
} from "./namespace-picker.ts";

const base = { current: "current", defaultName: "default", listingError: null, typed: "" };

describe("namespace picker rows", () => {
  it("puts the current namespace first, then the default, then the rest", () => {
    const rows = namespaceRows({ ...base, names: ["alpha", "beta", "current", "default"] });
    assert.deepEqual(rows.map((row) => row.value), ["current", "default", "alpha", "beta"]);
    assert.deepEqual(rows.map((row) => row.description), ["current", "default", undefined, undefined]);
  });

  it("does not repeat a namespace that is both current and default", () => {
    const rows = namespaceRows({ ...base, current: "only", defaultName: "only", names: ["only"] });
    assert.deepEqual(rows.map((row) => row.value), ["only"]);
  });

  it("shows the default even when the engine listing no longer contains it", () => {
    const rows = namespaceRows({ ...base, names: ["alpha"] });
    assert.deepEqual(rows.map((row) => row.value), ["current", "default", "alpha"]);
  });

  it("offers no escape hatch while the listing works — a name it lacks is a typo", () => {
    const rows = namespaceRows({ ...base, names: ["alpha"] });
    assert.equal(rows.some((row) => row.kind === "escape"), false);
  });

  it("offers exactly one escape hatch when the listing failed, labelled with what was typed", () => {
    const rows = namespaceRows({ ...base, names: ["ignored"], listingError: "403 forbidden", typed: " staged " });
    assert.deepEqual(rows.map((row) => row.value), ["current", "default", NAMESPACE_ESCAPE_VALUE]);
    assert.equal(rows.at(-1)?.label, 'use "staged" (not listed — unverified)');
  });

  it("never offers an authored expression as a selectable row — the header names it instead", () => {
    const rows = namespaceRows({ ...base, current: "$MESH_NS", defaultName: "$MESH_NS", names: ["dev", "default"] });
    assert.deepEqual(rows.map((row) => row.value), ["dev", "default"]);
  });

  it("keeps the escape row's promise legible before anything is typed", () => {
    assert.equal(escapeRow("  ").label, "use the typed namespace (not listed — unverified)");
  });
});

describe("namespace picker filtering", () => {
  it("matches anywhere in the name, not only a prefix", () => {
    const rows = namespaceRows({ ...base, names: ["staging", "prod"] });
    assert.deepEqual(filterRows(rows, "agi").map((row) => row.value), ["staging"]);
    assert.deepEqual(filterRows(rows, "STAG").map((row) => row.value), ["staging"]);
  });

  it("keeps the escape row through every filter — it is the action, not a candidate", () => {
    const rows = namespaceRows({ ...base, listingError: "403", typed: "zzz" });
    assert.deepEqual(filterRows(rows, "zzz").map((row) => row.kind), ["escape"]);
  });

  it("returns every row while the filter is empty", () => {
    const rows = namespaceRows({ ...base, names: ["a", "b"] });
    assert.equal(filterRows(rows, "   ").length, rows.length);
  });
});

describe("namespace picker notices", () => {
  it("names what matched nothing when the listing DID work", () => {
    const rows = namespaceRows({ ...base, names: ["staging"] });
    assert.equal(emptyMatchNotice("nope", null, rows), 'no namespace matches "nope" on this engine');
  });

  it("says nothing when a row does match", () => {
    const rows = namespaceRows({ ...base, names: ["staging"] });
    assert.equal(emptyMatchNotice("stag", null, rows), null);
  });

  it("says nothing when the listing itself failed (the header already carries the reason)", () => {
    const rows = namespaceRows({ ...base, listingError: "403 forbidden" });
    assert.equal(emptyMatchNotice("nope", "403 forbidden", rows), null);
  });

  it("says nothing while the filter is empty", () => {
    const rows = namespaceRows({ ...base, names: ["staging"] });
    assert.equal(emptyMatchNotice("  ", null, rows), null);
  });

  it("names both namespaces in the header only when they differ", () => {
    assert.equal(pickerHeader("a", "a"), "Mesh namespace — now: a");
    assert.equal(pickerHeader("a", "b"), "Mesh namespace — now: a (default: b)");
  });
});
