/**
 * web-picker-offline-doc.test.ts — the picker-side offline handoff composer
 * (web-picker.src/offline-doc.js). Pure string building, so it runs under plain
 * `npm test`; the DOM half of the userscript stays manual (per AGENTS.md).
 *
 * The load-bearing property is what the offline document must NOT contain: a
 * follow-up page-tool channel that cannot exist without a broker link.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
// @ts-expect-error — plain-JS userscript module, no ambient types
import { renderOfflineHandoffDoc } from "./web-picker.src/offline-doc.js";

/** Every .js file under web-picker.src/ (banner included — it is documentation of the same contract). */
function listSources(dirUrl: URL): string[] {
  const dir = fileURLToPath(dirUrl);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(new URL(name + "/", dirUrl)));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const PAGE = { url: "https://example.test/checkout", title: "Checkout — Example", ts: 1_700_000_000_000 };

const PICK = {
  selector: "button.primary",
  xpath: "/html/body/div[2]/button[1]",
  textPreview: "Pay now",
  rect: { x: 12, y: 340, w: 180, h: 42 },
  note: "fails after the coupon field",
  attributes: { "data-testid": "pay", hidden: "" },
  source: { framework: "react", component: "PayButton", file: "src/pay.tsx", line: 88, column: 2 },
  ts: PAGE.ts,
  group: "g1",
};

const RECORD = {
  id: "rec-1",
  start: 1_700_000_000_000,
  end: 1_700_000_004_200,
  url0: "https://example.test/cart",
  url1: "https://example.test/checkout",
  events: [
    { seq: 1, t: 0, kind: "click", sel: "#coupon", text: "apply" },
    { seq: 2, t: 900, kind: "input", sel: "#coupon", value: "SAVE10" },
    { seq: 3, t: 2100, kind: "nav", to: "https://example.test/checkout" },
    { seq: 4, t: 3200, kind: "click", sel: "button.primary", ref: 1 },
  ],
  console: [{ level: "error", text: "TypeError: cannot read properties of null" }],
  net: [{ method: "POST", url: "/api/pay", status: 500, durationMs: 812 }],
};

describe("offline handoff doc", () => {
  it("renders request, page, and one section per pick", () => {
    const doc = renderOfflineHandoffDoc({ prompt: "why does pay fail?", page: PAGE, picks: [PICK] });
    assert.match(doc, /^# Web annotation handoff\n/);
    assert.match(doc, /## Request\n\nwhy does pay fail\?/);
    assert.match(doc, /- url: https:\/\/example\.test\/checkout/);
    assert.match(doc, /- title: Checkout — Example/);
    assert.match(doc, /### 1\. button\.primary/);
    assert.match(doc, /- note: fails after the coupon field/);
    assert.match(doc, /- attrs: data-testid="pay" hidden/);
    assert.match(doc, /- group: g1/);
    assert.match(doc, /- source: src\/pay\.tsx:88/);
    assert.ok(doc.endsWith("\n"));
  });

  it("numbers picks and tolerates sparse records", () => {
    const doc = renderOfflineHandoffDoc({
      prompt: "p",
      page: PAGE,
      picks: [PICK, { selector: "#x" }, null],
    });
    assert.match(doc, /### 2\. #x/);
    assert.match(doc, /### 3\. \(no selector\)/);
    assert.match(doc, /- rect: x=0 y=0 w=0 h=0/);
  });

  it("renders the record timeline with console and network slices", () => {
    const doc = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [PICK], record: RECORD });
    assert.match(doc, /## Operation timeline/);
    assert.match(doc, /- record: rec-1/);
    assert.match(doc, /- url: https:\/\/example\.test\/cart → https:\/\/example\.test\/checkout/);
    assert.match(doc, /- \+`900ms` `input` `#coupon` value=`SAVE10`/);
    assert.match(doc, /- \+`2100ms` `nav` → https:\/\/example\.test\/checkout/);
    assert.match(doc, /\(pick #1\)/);
    assert.match(doc, /### Console \(window slice\)/);
    assert.match(doc, /- \[error\] TypeError: cannot read properties of null/);
    assert.match(doc, /### Network \(window slice\)/);
    assert.match(doc, /- POST \/api\/pay → 500 812ms/);
  });

  it("omits the timeline section when there is no record", () => {
    const doc = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [PICK] });
    assert.doesNotMatch(doc, /Operation timeline/);
  });

  it("never promises the reverse page-tool channel", () => {
    const doc = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [PICK], record: RECORD, target: "alpha" });
    assert.doesNotMatch(doc, /Follow-up channel/);
    assert.doesNotMatch(doc, /page-tool/);
    assert.doesNotMatch(doc, /dom\.query|page\.request/);
    assert.match(doc, /no way to query this page later/);
    assert.doesNotMatch(doc, /node \S+ page-tool/, "no runnable reverse command either");
    assert.match(doc, /composed offline in the tab/);
  });

  it("lists the last used target as a hint, and omits it when unknown", () => {
    const withTarget = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [PICK], target: "alpha" });
    assert.match(withTarget, /- expected receiver: alpha/);
    const without = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [PICK], target: "" });
    assert.doesNotMatch(without, /expected receiver/);
  });

  it("says so plainly when nothing was picked", () => {
    const doc = renderOfflineHandoffDoc({ prompt: "p", page: PAGE, picks: [] });
    assert.match(doc, /_No elements were picked on this page\._/);
  });
});
/**
 * Trusted Types regression guard: on sites with `require-trusted-types-for`
 * (YouTube) a bare `el.innerHTML = …` throws and takes the whole userscript
 * down before any wiring. All markup writes must go through `setHTML`.
 */
describe("trusted types: no direct HTML sinks in userscript sources", () => {
  // TT sinks: under require-trusted-types-for every one of these throws on a
  // plain string. tt.js is the only module allowed to touch them.
  const SINKS = /\b(?:[\w.$\[\]]+)\.(?:innerHTML|outerHTML|insertAdjacentHTML)\s*(?:=|\()|\.srcdoc\s*=/;

  it("routes every markup write through tt.js", () => {
    const srcDir = new URL("./web-picker.src/", import.meta.url);
    const offenders: string[] = [];
    for (const entry of listSources(srcDir)) {
      if (entry.endsWith("/tt.js")) continue;         // the shim itself is the exception
      readFileSync(entry, "utf-8").split("\n").forEach((line, i) => {
        const code = line.replace(/^\s*\/\/.*$/, "");   // comments describe, they do not write
        if (SINKS.test(code)) offenders.push(`${entry.split("/").slice(-2).join("/")}:${i + 1} ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], "markup writes must go through setHTML()/clearHTML() from tt.js");
  });

  it("actually catches a bare innerHTML write (guard self-check)", () => {
    assert.equal(SINKS.test('el.innerHTML = "<b>x</b>";'), true);
    assert.equal(SINKS.test('setHTML(el, "<b>x</b>");'), false);
    assert.equal(SINKS.test("const html = clone.outerHTML;"), false);
  });
});

/**
 * Regression guard for the broker-link request/response table: every pending
 * request kind registered in broker-conn.js must be dispatched by the ACK
 * (and error) branch. A missing branch leaves the promise unresolved, so the
 * caller times out even though the broker answered — the exact bug that made
 * 「暂存到 broker」 report "timeout — broker no response" while the socket
 * trace showed a healthy ack.
 */
describe("broker-conn: every pending kind has an ACK dispatcher", () => {
  it("registers no kind the ACK/error branches ignore", () => {
    const src = readFileSync(new URL("./web-picker.src/broker-conn.js", import.meta.url), "utf-8");
    const registered = new Set(
      [...src.matchAll(/pending\.set\(\s*id\s*,\s*\{\s*kind:\s*'([a-z]+)'/g)].map((m) => m[1]!),
    );
    assert.ok(registered.size >= 5, `expected the request table to be discovered, got ${[...registered].join(",")}`);
    const ackBranch = src.slice(src.indexOf("KIND_ACK"), src.indexOf("KIND_ERROR"));
    const errorBranch = src.slice(src.indexOf("KIND_ERROR"), src.indexOf("KIND_TARGETS_RESULT"));
    for (const kind of registered) {
      // ACK: either an explicit `p.kind === '<kind>'` or, for the array-shaped
      // targets kind, the targets.result frame (asserted separately below).
      const inAck = ackBranch.includes(`p.kind === '${kind}'`);
      assert.ok(inAck || kind === 'targets', `pending kind '${kind}' is never resolved by an ack — it will time out`);
    }
    // The error branch may resolve kinds generically (a trailing else), which is
    // fine as long as it always settles the promise and keeps baglist's shape.
    assert.match(errorBranch, /else\s+p\.resolve\(/, "error frames must settle every pending request");
    assert.match(errorBranch, /p\.kind === 'baglist'/, "a baglist error must still answer with an items array");
  });
});
