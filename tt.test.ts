/**
 * Tests for the tt.js markup-write escalation ladder. Pure node:test with a
 * fake sink: no DOM needed, only the property/ method contract setHTML relies
 * on (innerHTML assignment, appendChild, textContent).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setHTML } from "./web-picker.src/tt.js";

type Sink = {
  innerHTMLWrites: string[];
  appended: unknown[];
  textContentWrites: string[];
  innerHTML: string;
  textContent: string;
  appendChild: (node: unknown) => void;
};

function sink(opts: { innerHTMLThrows?: boolean; appendChildThrows?: boolean; textContentThrows?: boolean } = {}): Sink {
  const s: Sink = {
    innerHTMLWrites: [],
    appended: [],
    textContentWrites: [],
    innerHTML: "",
    textContent: "",
    appendChild(node: unknown) {
      if (opts.appendChildThrows) throw new Error("appendChild blocked");
      s.appended.push(node);
    },
  };
  Object.defineProperty(s, "innerHTML", {
    set(value: string) {
      if (opts.innerHTMLThrows) throw new TypeError("TrustedHTML required");
      s.innerHTMLWrites.push(value);
    },
    get() { return s.innerHTMLWrites.at(-1) ?? ""; },
  });
  Object.defineProperty(s, "textContent", {
    set(value: string) {
      if (opts.textContentThrows) throw new Error("blocked");
      s.textContentWrites.push(value);
    },
    get() { return s.textContentWrites.at(-1) ?? ""; },
  });
  return s;
}

/** Stub DOMParser: node:test runs without it on the tt path's third rung. */
function withFakeDomParser<T>(impl: () => { body: { firstChild: unknown } }, fn: () => T): T {
  const g = globalThis as { DOMParser?: unknown };
  const saved = g.DOMParser;
  g.DOMParser = class { parseFromString(): { body: { firstChild: unknown } } { return impl(); } };
  try { return fn(); } finally { g.DOMParser = saved; }
}

describe("setHTML fallback ladder", () => {
  it("uses plain innerHTML when no policy exists and TT is not enforced", () => {
    const s = sink();
    setHTML(s, "<b>hi</b>");
    assert.deepEqual(s.innerHTMLWrites, ["<b>hi</b>"]);
    assert.equal(s.appended.length, 0);
    assert.equal(s.textContentWrites.length, 0);
  });

  it("falls back to DOMParser adoption when innerHTML throws (Teams-style TT enforcement)", () => {
    const s = sink({ innerHTMLThrows: true });
    const nodes = [{ id: 1 }, { id: 2 }];
    const expected = [...nodes];
    withFakeDomParser(() => ({ body: { get firstChild() { return nodes.shift() ?? null; } } }), () => {
      setHTML(s, "<div>a</div><div>b</div>");
    });
    assert.equal(s.innerHTMLWrites.length, 0);
    assert.deepEqual(s.appended, expected);
  });

  it("degrades to textContent when every markup sink is blocked", () => {
    const s = sink({ innerHTMLThrows: true, appendChildThrows: true });
    withFakeDomParser(() => ({ body: { firstChild: { id: 1 } } }), () => {
      setHTML(s, "<div>a</div>");
    });
    assert.deepEqual(s.textContentWrites, ["<div>a</div>"]);
  });

  it("survives a sink where even textContent throws", () => {
    const s = sink({ innerHTMLThrows: true, appendChildThrows: true, textContentThrows: true });
    withFakeDomParser(() => ({ body: { firstChild: null } }), () => {
      assert.doesNotThrow(() => setHTML(s, "<div>a</div>"));
    });
  });

  it("ignores null targets", () => {
    assert.doesNotThrow(() => setHTML(null, "<div>a</div>"));
  });
});
