import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Board, parseBoardEntryBlock, registerBoard } from "./board.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xfer-board-"));
}

test("Board: create assigns sequential ids and slugifies titles", () => {
  const dir = tempDir();
  const board = new Board(dir);
  const a = board.create("Why Tab Completion Eats Tokens!", "dotfiles");
  const b = board.create("second", "codex");
  assert.equal(a.id, "c-0001");
  assert.equal(b.id, "c-0002");
  assert.ok(fs.existsSync(path.join(dir, "c-0001-why-tab-completion-eats-tokens.md")));
  assert.equal(a.createdBy, "dotfiles");
});

test("Board: append grows the entry sequence and round-trips through read", () => {
  const dir = tempDir();
  const board = new Board(dir);
  board.create("topic", "dotfiles", { type: "question", author: "dotfiles", at: "2026-01-01T00:00:00.000Z", text: "why?" });
  board.append("c-0001", "answer", "because", "codex");
  const card = board.read("c-0001")!;
  assert.equal(card.entries.length, 2);
  assert.deepEqual(
    card.entries.map((e) => [e.id, e.type, e.author]),
    [["e-0001", "question", "dotfiles"], ["e-0002", "answer", "codex"]],
  );
  assert.equal(card.entries[1].text, "because");
});

test("Board: read by id or file path, null for unknown", () => {
  const dir = tempDir();
  const board = new Board(dir);
  board.create("topic", "dotfiles");
  assert.ok(board.read("c-0001"));
  assert.ok(board.read(board.list()[0] && path.join(dir, fs.readdirSync(dir)[0])));
  assert.equal(board.read("c-9999"), null);
});

test("Board: del removes one card, clean removes all", () => {
  const dir = tempDir();
  const board = new Board(dir);
  board.create("a", "x");
  board.create("b", "y");
  assert.ok(board.del("c-0001"));
  assert.equal(board.del("c-0001"), null);
  assert.equal(board.list().length, 1);
  assert.equal(board.clean().length, 1);
  assert.equal(board.list().length, 0);
});

test("parseBoardEntryBlock: extracts title/type/text and rejects malformed replies", () => {
  const good = parseBoardEntryBlock(" preamble\n```board-entry\ntitle: T\ntype: answer\n---\nbody here\n```\n");
  assert.deepEqual(good, { title: "T", type: "answer", text: "body here" });
  const noTitle = parseBoardEntryBlock("```board-entry\ntype: note\n---\njust text\n```");
  assert.deepEqual(noTitle, { title: undefined, type: "note", text: "just text" });
  assert.equal(parseBoardEntryBlock("no block at all"), null);
  assert.equal(parseBoardEntryBlock("```board-entry\ntype: note\n```"), null);
  assert.equal(parseBoardEntryBlock("```board-entry\ntype: note\n---\n```"), null);
});

function boardHarness(dir: string) {
  const notifications: { message: string; type?: string }[] = [];
  let agentEndHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) => {
      if (event === "agent_end") agentEndHandler = handler;
    },
  };
  const ctx = { ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } };
  const api = registerBoard(pi as never, { boardDir: dir, getAuthor: () => "test-agent" });
  return {
    api,
    notifications,
    agentEnd: (reply: string) => agentEndHandler!({ messages: [{ role: "assistant", content: reply }] }, ctx),
    last: () => notifications[notifications.length - 1],
  };
}

test("two-phase write: pending entry is appended on agent_end with a board-entry block", async () => {
  const dir = tempDir();
  const h = boardHarness(dir);
  h.api.board.create("topic", "dotfiles");
  h.api.board.setPending({ cardId: "c-0001", isNew: false });
  await h.agentEnd("```board-entry\ntype: finding\n---\nthe root cause\n```");
  const card = h.api.board.read("c-0001")!;
  assert.equal(card.entries.length, 1);
  assert.equal(card.entries[0].type, "finding");
  assert.equal(card.entries[0].author, "test-agent");
  assert.equal(h.last().type, "info");
  assert.equal(h.api.board.getPending(), null);
});

test("two-phase write: new card gets its title from the agent", async () => {
  const dir = tempDir();
  const h = boardHarness(dir);
  h.api.board.setPending({ cardId: null, isNew: true });
  await h.agentEnd("```board-entry\ntitle: Agent Chosen Title\ntype: question\n---\nwhat?\n```");
  const cards = h.api.board.list();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "Agent Chosen Title");
  assert.equal(h.api.board.read("c-0001")!.entries[0].text, "what?");
});

test("two-phase write: a reply without a block aborts cleanly and clears pending", async () => {
  const dir = tempDir();
  const h = boardHarness(dir);
  h.api.board.create("topic", "dotfiles");
  h.api.board.setPending({ cardId: "c-0001", isNew: false });
  await h.agentEnd("sorry, I rambled instead");
  assert.equal(h.api.board.read("c-0001")!.entries.length, 0);
  assert.equal(h.last().type, "warning");
  assert.equal(h.api.board.getPending(), null);
});

test("agent_end without pending is a no-op", async () => {
  const dir = tempDir();
  const h = boardHarness(dir);
  await h.agentEnd("```board-entry\ntype: note\n---\nstray\n```");
  assert.equal(h.notifications.length, 0);
});
