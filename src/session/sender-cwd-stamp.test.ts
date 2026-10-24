/**
 * sender-cwd-stamp.test.ts — the P1-D cwd anchor: doc stamp formatting/parsing,
 * `.git/HEAD` branch resolution, bounded doc-head reads, and the envelope line.
 *
 * Hermetic: every fixture path is synthetic (`/srv/...` literals) or lives in a
 * fresh `os.tmpdir()` sandbox; hostnames are fake. Never touches a real repo.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  formatSenderCwdStamp,
  parseSenderCwdStamp,
  readGitBranch,
  readSenderCwdStamp,
  senderCwdInstruction,
  senderCwdStampFor,
  stampDocument,
  type SenderCwdStamp,
} from "./sender-cwd-stamp.ts";

let sandbox: string;
before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-stamp-test-")); });
after(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

const STAMP: SenderCwdStamp = { cwd: "/srv/app", project: "app", machine: "alpha", branch: "main" };

function writeFixture(name: string, content: string): string {
  const file = path.join(sandbox, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

describe("sender-cwd stamp: format + parse", () => {
  it("renders cwd, project, machine, and branch on one line", () => {
    assert.equal(
      formatSenderCwdStamp(STAMP),
      "<!-- xfer:sender-cwd cwd=/srv/app project=app machine=alpha branch=main -->",
    );
  });

  it("omits branch when the sender is not on one", () => {
    const { branch: _branch, ...withoutBranch } = STAMP;
    assert.equal(
      formatSenderCwdStamp(withoutBranch),
      "<!-- xfer:sender-cwd cwd=/srv/app project=app machine=alpha -->",
    );
  });

  it("round-trips through parse", () => {
    assert.deepEqual(parseSenderCwdStamp(formatSenderCwdStamp(STAMP) + "\n# Doc\n"), STAMP);
  });

  it("round-trips a cwd containing spaces", () => {
    const spaced: SenderCwdStamp = { cwd: "/srv/my apps/app", project: "app", machine: "alpha", branch: "feat/x" };
    assert.deepEqual(parseSenderCwdStamp(formatSenderCwdStamp(spaced) + "\n# Doc\n"), spaced);
  });

  it("returns null for an unstamped doc, a stamp that is not first, and junk", () => {
    assert.equal(parseSenderCwdStamp("# Doc\n\nbody\n"), null);
    assert.equal(parseSenderCwdStamp(`# Doc\n${formatSenderCwdStamp(STAMP)}\n`), null);
    assert.equal(parseSenderCwdStamp("<!-- xfer:sender-cwd cwd=/srv/app -->\n"), null);
    assert.equal(parseSenderCwdStamp(""), null);
  });
});

describe("sender-cwd stamp: document stamping", () => {
  it("prepends the stamp as the doc's first line", () => {
    const stamped = stampDocument("# Doc\n\nbody\n", STAMP);
    assert.equal(stamped, `${formatSenderCwdStamp(STAMP)}\n# Doc\n\nbody\n`);
    assert.deepEqual(parseSenderCwdStamp(stamped), STAMP);
  });

  it("re-stamps an already stamped doc in place instead of stacking", () => {
    const first = stampDocument("# Doc\n", { cwd: "/srv/a", project: "a", machine: "alpha" });
    const second = stampDocument(first, STAMP);
    assert.equal(second, `${formatSenderCwdStamp(STAMP)}\n# Doc\n`);
    assert.equal(second.match(/xfer:sender-cwd/g)?.length, 1);
  });
});

describe("sender-cwd stamp: git branch by file read", () => {
it("reads the branch from a plain checkout .git/HEAD", () => {
    const cwd = path.join(sandbox, "plain");
    writeFixture(path.join("plain", ".git", "HEAD"), "ref: refs/heads/feature/login\n");
    assert.equal(readGitBranch(cwd), "feature/login");
  });

  it("follows a worktree .git pointer file into the parent repo gitdir", () => {
    const worktree = path.join(sandbox, "wt");
    const gitdir = path.join(sandbox, "repo", ".git", "worktrees", "wt-1");
    writeFixture(path.join("wt", ".git"), `gitdir: ${gitdir}\n`);
    writeFixture(path.join("repo", ".git", "worktrees", "wt-1", "HEAD"), "ref: refs/heads/wt-branch\n");
    assert.equal(readGitBranch(worktree), "wt-branch");
  });

  it("returns null for non-git trees, detached HEAD, and broken pointers", () => {
    assert.equal(readGitBranch(path.join(sandbox, "plain-none")), null);
    const detached = path.join(sandbox, "detached");
    writeFixture(path.join("detached", ".git", "HEAD"), "9f1c0de\n");
    assert.equal(readGitBranch(detached), null);
    const broken = path.join(sandbox, "broken");
    writeFixture(path.join("broken", ".git"), "gitdir: /nonexistent/gitdir\n");
    assert.equal(readGitBranch(broken), null);
  });
});

describe("sender-cwd stamp: builder", () => {
  it("derives project from the basename and attaches the branch", () => {
    const cwd = path.join(sandbox, "plain");
    writeFixture(path.join("plain", ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.deepEqual(senderCwdStampFor(cwd, "alpha"), {
      cwd,
      project: path.basename(cwd),
      machine: "alpha",
      branch: "main",
    });
  });

  it("falls back to the full cwd as project label when there is no basename", () => {
    assert.deepEqual(senderCwdStampFor("/", "alpha"), { cwd: "/", project: "/", machine: "alpha" });
  });
});

describe("sender-cwd stamp: reading a doc from disk", () => {
  it("parses the stamp of a stamped doc", () => {
    const file = writeFixture("doc.md", stampDocument("# Doc\n", STAMP));
    assert.deepEqual(readSenderCwdStamp(file), STAMP);
  });

  it("parses the head of a doc larger than one read chunk", () => {
    const file = writeFixture("big.md", stampDocument("# Doc\n\n" + "filler line\n".repeat(2000), STAMP));
    assert.deepEqual(readSenderCwdStamp(file), STAMP);
  });

  it("returns null for a missing or unstamped doc", () => {
    assert.equal(readSenderCwdStamp(path.join(sandbox, "absent.md")), null);
    assert.equal(readSenderCwdStamp(writeFixture("plain.md", "# Doc\n")), null);
  });
});

describe("sender-cwd instruction line", () => {
  it("anchors local senders on the path alone", () => {
    assert.equal(
      senderCwdInstruction(STAMP, { local: true }),
      "**Sender cwd**: `/srv/app` (project app on machine alpha) — " +
      "make all file edits here unless the doc says otherwise.",
    );
  });

  it("adds the locate-the-project fallback for non-local senders", () => {
    const line = senderCwdInstruction(STAMP, { local: false });
    assert.match(line, /^\*\*Sender cwd\*\*: `\/srv\/app`/);
    assert.match(line, /does not exist on this machine, locate the project/);
    assert.match(line, /worktree\/branch if given/);
    assert.match(line, /ask the user only if ambiguous\.$/);
  });
});