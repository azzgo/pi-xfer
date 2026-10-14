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
      const n = node as { parent?: { kids: unknown[]; firstChild?: unknown } } | null;
      if (n && n.parent) {
        n.parent.kids = n.parent.kids.filter((k) => k !== n);
        n.parent.firstChild = n.parent.kids[0] ?? null;
      }
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

  it("renders markup via the built-in mini-parser when every platform sink is blocked (Teams)", () => {
    const s = sink({ innerHTMLThrows: true });
    type FakeNode = {
      tag: string;
      ns?: string;
      attrs: Record<string, string>;
      kids: FakeNode[] | { text: string; parent?: FakeNode }[];
      parent: FakeNode | null;
      appendChild(c: FakeNode): void;
      setAttribute(n: string, v: string): void;
      firstChild: FakeNode | { text: string } | null;
    };
    function withFakeDocument<T>(fn: () => T): T {
      const made: unknown[] = [];
      function el(tag: string, ns?: string) {
        const e: FakeNode = {
          tag,
          ns,
          attrs: {},
          kids: [],
          parent: null,
          appendChild(c: FakeNode) {
            if (c.parent) {
              c.parent.kids = (c.parent.kids as FakeNode[]).filter((k) => k !== c);
              c.parent.firstChild = (c.parent.kids as FakeNode[])[0] ?? null;
            }
            c.parent = e;
            (e.kids as FakeNode[]).push(c);
            e.firstChild = (e.kids as FakeNode[])[0] ?? null;
          },
          setAttribute(n: string, v: string) { e.attrs[n] = v; },
          firstChild: null,
        };
        made.push(e);
        return e;
      }
      const g = globalThis as { document?: unknown };
      const saved = g.document;
      g.document = {
        createElement: (t: string) => el(t),
        createElementNS: (ns: string, t: string) => el(t, ns),
        createTextNode: (t: string) => ({ text: t }),
        createDocumentFragment: () => el("#fragment"),
      };
      try { return fn(); } finally { g.document = saved; }
    }
    const markup = `<style>.x{color:red}</style><div id="a" class="c" data-n="2">hi &amp; bye<br><svg viewBox="0 0 24 24"><circle cx="12"/></svg><input type="checkbox" checked></div>`;
    withFakeDocument(() => {
      withFakeDomParser(() => { throw new Error("TT covers DOMParser here"); }, () => {
        setHTML(s, markup);
      });
    });
    assert.equal(s.textContentWrites.length, 0, "must not degrade to text");
    const style = s.appended[0] as Record<string, unknown>;
    assert.equal(style.tag, "style");
    assert.equal(style.kids?.length, 1);
    assert.equal((style.kids?.[0] as { text?: string }).text, ".x{color:red}");
    const div = s.appended[1] as Record<string, unknown> & { kids: Array<Record<string, unknown>> };
    assert.deepEqual({ ...div.attrs }, { id: "a", class: "c", "data-n": "2" });
    assert.equal((div.kids[0] as { text?: string }).text, "hi & bye");
    assert.equal(div.tag, "div");
    const svg = div.kids[2] as Record<string, unknown> & { kids: Array<Record<string, unknown>> };
    assert.equal((div.kids[1] as { tag?: string }).tag, "br");
    assert.equal(svg.tag, "svg");
    assert.equal(svg.ns, "http://www.w3.org/2000/svg");
    assert.equal(svg.attrs.viewBox, "0 0 24 24");
    const circle = svg.kids[0] as Record<string, unknown>;
    assert.equal(circle.tag, "circle");
    assert.equal(circle.ns, "http://www.w3.org/2000/svg");
    const input = div.kids[3] as Record<string, unknown>;
    assert.equal(input.tag, "input");
    assert.deepEqual({ ...input.attrs }, { type: "checkbox", checked: "" });
  });
});
