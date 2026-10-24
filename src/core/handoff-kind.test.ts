/**
 * handoff-kind.test.ts — the sender-declared Kind header line: grammar, the
 * default for an unmarked doc, tool-stamped wins over a hand-written line, and
 * idempotent stamping under the cwd stamp.
 *
 * Hermetic: docs are synthetic strings or live in a fresh `os.tmpdir()`
 * sandbox; nothing here touches a real xfer install.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_HANDOFF_KIND,
  formatHandoffKind,
  parseHandoffKind,
  readHandoffKind,
  stampHandoffKind,
} from "./handoff-kind.ts";
import { formatSenderCwdStamp, stampDocument } from "../session/sender-cwd-stamp.ts";

const STAMP_LINE = "<!-- xfer:sender-cwd cwd=/srv/app project=app machine=alpha -->";
const STAMP = { cwd: "/srv/app", project: "app", machine: "alpha" };

let sandbox: string;
before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-kind-test-")); });
after(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function writeFixture(name: string, content: string): string {
  const file = path.join(sandbox, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

describe("handoff kind: format + parse", () => {
  it("renders the canonical header line", () => {
    assert.equal(formatHandoffKind("task"), "kind: task");
    assert.equal(formatHandoffKind("notification"), "kind: notification");
  });

  it("parses both values, case-insensitively and with stray whitespace", () => {
    assert.equal(parseHandoffKind("kind: task\n# Doc\n"), "task");
    assert.equal(parseHandoffKind("kind: notification\n"), "notification");
    assert.equal(parseHandoffKind("Kind: Task\n"), "task");
    assert.equal(parseHandoffKind("  kind:notification  \n"), "notification");
  });

  it("reads an unmarked doc as the silent default", () => {
    assert.equal(parseHandoffKind("# Doc\n\nbody\n"), DEFAULT_HANDOFF_KIND);
    assert.equal(DEFAULT_HANDOFF_KIND, "notification");
    assert.equal(parseHandoffKind(""), DEFAULT_HANDOFF_KIND);
  });

  it("matches only the header grammar, not a line that merely mentions it", () => {
    assert.equal(parseHandoffKind("kind: maybe\n"), DEFAULT_HANDOFF_KIND);
    assert.equal(parseHandoffKind("the kind: task of it\n"), DEFAULT_HANDOFF_KIND);
  });

  it("does not parse markdown structure — a fenced header line still counts", () => {
    assert.equal(parseHandoffKind("```\nkind: task\n```\n"), "task");
  });

  it("takes the first match, so the tool's line outranks a body line", () => {
    assert.equal(parseHandoffKind("kind: task\n\nkind: notification\n"), "task");
    assert.equal(parseHandoffKind("kind: notification\n\nkind: task\n"), "notification");
  });
});

describe("handoff kind: document stamping", () => {
  it("inserts the line after the cwd stamp, keeping the stamp first", () => {
    const stamped = stampHandoffKind(stampDocument("# Doc\n\nbody\n", STAMP), "task");
    assert.equal(stamped, `${formatSenderCwdStamp(STAMP)}\nkind: task\n# Doc\n\nbody\n`);
  });

  it("prepends the line when the doc carries no cwd stamp", () => {
    assert.equal(stampHandoffKind("# Doc\n\nbody\n", "notification"), "kind: notification\n# Doc\n\nbody\n");
  });

  it("replaces a hand-written line instead of stacking", () => {
    const first = stampHandoffKind("# Doc\n", "notification");
    const second = stampHandoffKind(first, "task");
    assert.equal(second, "kind: task\n# Doc\n");
    assert.equal(second.match(/^kind:/gm)?.length, 1);
  });

  it("drops a conflicting body line so the tool's value is the only one", () => {
    const stamped = stampHandoffKind("# Doc\n\nkind: notification\n\nmore\n", "task");
    assert.equal(stamped.match(/kind:/g)?.length, 1);
    assert.equal(parseHandoffKind(stamped), "task");
  });

  it("is idempotent, stamp and all", () => {
    const once = stampHandoffKind(stampDocument("# Doc\n", STAMP), "task");
    assert.equal(stampHandoffKind(stampDocument(once, STAMP), "task"), once);
  });
});

describe("handoff kind: reading a doc from disk", () => {
  it("reads a marked doc and defaults an unmarked one", () => {
    assert.equal(readHandoffKind(writeFixture("task.md", stampHandoffKind("# Doc\n", "task"))), "task");
    assert.equal(readHandoffKind(writeFixture("plain.md", "# Doc\n")), "notification");
  });

  it("reads the head of a doc larger than one read chunk", () => {
    const file = writeFixture("big.md", stampHandoffKind("# Doc\n\n" + "filler line\n".repeat(2000), "task"));
    assert.equal(readHandoffKind(file), "task");
  });

  it("returns the default for a missing doc", () => {
    assert.equal(readHandoffKind(path.join(sandbox, "absent.md")), DEFAULT_HANDOFF_KIND);
  });

  it("keeps working when a legacy doc carries the cwd stamp only", () => {
    const file = writeFixture("legacy.md", `${STAMP_LINE}\n# Doc\n`);
    assert.equal(readHandoffKind(file), "notification");
  });
});
