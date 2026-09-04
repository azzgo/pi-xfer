/**
 * Run via `npm test` in this directory.
 *
 * Golden-string tests for the Wayfinder ticket-007 handoff doc skeleton
 * (goal 027). `renderHandoffDoc` is a pure markdown renderer — no I/O —
 * so fixtures live in code, not on disk.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderHandoffDoc } from "./handoff-doc.js";
import type { HandoffPick, RenderHandoffDocInput } from "./handoff-doc.js";

const PICK_WITH_SOURCE: HandoffPick = {
  selector: "div.card > button.submit",
  xpath: "/html/body/div[2]/button",
  tagName: "button",
  textPreview: "Submit form",
  rect: { x: 120, y: 340, w: 96, h: 32 },
  note: "merge with the button above",
  attributes: { type: "button", "aria-label": "Submit the form", disabled: "" },
  ts: 1725148801000,
  url: "https://example.com/app",
  source: { framework: "react", component: "SubmitButton", file: "src/SubmitButton.tsx", line: 42, column: 6 },
};

const PICK_WITHOUT_SOURCE: HandoffPick = {
  selector: "#legacy-banner",
  xpath: "//*[@id=\"legacy-banner\"]",
  tagName: "div",
  textPreview: "Old banner",
  rect: { x: 0, y: 0, w: 1280, h: 64 },
  note: "",
  source: null,
};

function input(overrides: Partial<RenderHandoffDocInput> = {}): RenderHandoffDocInput {
  return {
    msgId: "m1",
    prompt: "Merge these two buttons",
    page: { url: "https://example.com/app", title: "Example App", ts: 1725148800000 },
    picks: [PICK_WITH_SOURCE, PICK_WITHOUT_SOURCE],
    fromTarget: "dotfiles_q1",
    ...overrides,
  };
}

const GOLDEN = `# Web annotation handoff

## Request

Merge these two buttons

## Page

- url: https://example.com/app
- title: Example App
- ts: 1725148800000 (2024-09-01T00:00:00.000Z)

## Annotations

### div.card > button.submit

- xpath: /html/body/div[2]/button
- text: Submit form
- attrs: type="button" aria-label="Submit the form" disabled
- rect: x=120 y=340 w=96 h=32
- note: merge with the button above
- source: src/SubmitButton.tsx:42

### #legacy-banner

- xpath: //*[@id="legacy-banner"]
- text: Old banner
- rect: x=0 y=0 w=1280 h=64
- note:

## Follow-up channel

The sending browser tab is still online. Collect page data by calling its fixed tool ops via the broker CLI — the command waits and prints the result JSON on stdout:
\`node broker-main.ts page-tool dotfiles_q1 <op> [paramsJSON]\`
Ops (fixed read-only table): page.info · dom.query {selector, maxCount?, styleProps?} · dom.html {selector?, maxLength?, maxDepth?} · console.logs {lastN?, sinceTs?, level?} · network.log {lastN?, urlFilter?} · framework.inspect {selector, props?, maxDepth?}. Example:
\`node broker-main.ts page-tool dotfiles_q1 dom.query '{"selector":"button.primary","maxCount":5}'\`
A timeout or no_tabs exits 1 with an error on stderr — treat the handoff as one-way then. Multiple calls may be issued in parallel.

---

from: web-picker
handoff_id: m1
`;

describe("renderHandoffDoc", () => {
  it("renders the exact ticket-007 skeleton for a two-pick fixture", () => {
    assert.equal(renderHandoffDoc(input()), GOLDEN);
  });

  it("emits the sections in 007 order", () => {
    const doc = renderHandoffDoc(input());
    const offsets = [
      doc.indexOf("## Request"),
      doc.indexOf("## Page"),
      doc.indexOf("## Annotations"),
      doc.indexOf("## Follow-up channel"),
      doc.indexOf("\n---\n"),
      doc.indexOf("from: web-picker"),
      doc.indexOf("handoff_id: m1"),
    ];
    assert.equal(doc.startsWith("# Web annotation handoff\n"), true);
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i] > offsets[i - 1], `section ${i} must come after ${i - 1}: ${offsets.join(", ")}`);
    }
  });

  it("preserves a multiline prompt verbatim, including blank lines and trailing spaces", () => {
    const prompt = "line one\n  line two indented\n\nline four   ";
    const doc = renderHandoffDoc(input({ prompt }));
    const request = doc.slice(
      doc.indexOf("## Request") + "## Request\n\n".length,
      doc.indexOf("\n\n## Page"),
    );
    assert.equal(request, prompt);
  });

  it("renders source file:line when present and omits the field cleanly when absent", () => {
    const doc = renderHandoffDoc(input({ picks: [PICK_WITH_SOURCE] }));
    assert.equal(
      doc.includes("- source: src/SubmitButton.tsx:42\n"),
      true,
      "expected a source file:line field",
    );
    const noSource = renderHandoffDoc(input({ picks: [PICK_WITHOUT_SOURCE] }));
    assert.equal(noSource.includes("- source:"), false);
    // The section must stay well-formed: pick heading followed directly by the
    // next section once the (omitted) source line is gone.
    assert.equal(noSource.includes("### #legacy-banner\n\n- xpath: //*[@id=\"legacy-banner\"]"), true);
  });

  it("renders the shift-group id only on records that carry one (web-picker v1.5)", () => {
    const grouped: HandoffPick = { ...PICK_WITH_SOURCE, note: "these two buttons become one", group: "g1a2b" };
    const doc = renderHandoffDoc(input({ picks: [grouped, PICK_WITHOUT_SOURCE] }));
    assert.equal(doc.includes("- group: g1a2b\n"), true, "expected the group id on the member pick");
    // Solo picks stay group-free: exactly one `- group:` line in the whole doc.
    assert.equal(doc.indexOf("- group:"), doc.lastIndexOf("- group:"));
    // Order within a section: note → group → source.
    const section = doc.slice(doc.indexOf("### div.card > button.submit"), doc.indexOf("### #legacy-banner"));
    assert.ok(
      section.indexOf("- note:") < section.indexOf("- group:") && section.indexOf("- group:") < section.indexOf("- source:"),
      `group line must sit between note and source: ${JSON.stringify(section)}`,
    );
  });

  it("ends with the from/handoff_id footer", () => {
    const doc = renderHandoffDoc(input({ msgId: "kx9-abc123" }));
    assert.equal(doc.endsWith("---\n\nfrom: web-picker\nhandoff_id: kx9-abc123\n"), true);
  });

  it("keeps the follow-up section at or under 10 lines (009 bloat criterion)", () => {
    const doc = renderHandoffDoc(input());
    const section = doc.slice(doc.indexOf("## Follow-up channel"), doc.indexOf("\n---\n"));
    const lineCount = section.split("\n").length;
    assert.ok(lineCount <= 10, `follow-up section has ${lineCount} lines, expected <= 10`);
    assert.equal(
      doc.includes('`node broker-main.ts page-tool dotfiles_q1 <op> [paramsJSON]`'),
      true,
      "expected the page-tool command example",
    );
    assert.equal(doc.includes("prints the result JSON on stdout"), true);
  });

  it("uses fromTarget in the page-tool example, placeholder when absent", () => {
    const withTarget = renderHandoffDoc(input({ fromTarget: "session-a" }));
    assert.equal(withTarget.includes('`node broker-main.ts page-tool session-a <op> [paramsJSON]`'), true);
    const withoutTarget = renderHandoffDoc(input({ fromTarget: undefined }));
    assert.equal(withoutTarget.includes('`node broker-main.ts page-tool <session-socket> <op> [paramsJSON]`'), true);
    assert.equal(withoutTarget.includes("undefined"), false);
  });

  it("embeds the broker CLI absolute path so the agent never has to search for it", () => {
    const doc = renderHandoffDoc(input({ brokerCliPath: "/Users/me/dev/dotfiles/pi/agent/extensions/xfer/broker-main.ts" }));
    assert.equal(
      doc.includes('`node /Users/me/dev/dotfiles/pi/agent/extensions/xfer/broker-main.ts page-tool dotfiles_q1 <op> [paramsJSON]`'),
      true,
      "expected the absolute broker CLI path in the command",
    );
    assert.equal(doc.includes("`node broker-main.ts"), false, "bare filename must not survive when the path is given");
  });

  it("renders zero picks as a well-formed (empty) Annotations section", () => {
    const doc = renderHandoffDoc(input({ picks: [] }));
    assert.equal(doc.includes("### "), false);
    for (const heading of ["## Request", "## Page", "## Annotations", "## Follow-up channel"]) {
      assert.ok(doc.includes(heading), `missing ${heading}`);
    }
    assert.equal(doc.indexOf("## Annotations") < doc.indexOf("## Follow-up channel"), true);
  });
});

describe("renderHandoffDoc purity", () => {
  it("is deterministic: same input, same output", () => {
    const first = renderHandoffDoc(input());
    const second = renderHandoffDoc(input());
    assert.equal(first, second);
  });

  it("does not import node built-ins (no I/O in the renderer)", () => {
    const source = readFileSync(new URL("./handoff-doc.ts", import.meta.url), "utf-8");
    assert.equal(
      /from "node:/.test(source),
      false,
      "handoff-doc.ts must stay a pure renderer — no node: imports",
    );
  });
});
