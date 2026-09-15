import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default board location: machine-local, shared across projects. */
export const DEFAULT_BOARD_DIR = path.join(os.homedir(), ".pi", "xfer", "board");

const ENTRY_HEADER_RE = /^### (e-\d+) · (\S+) · (\S+) · (\S+)/;
const ENTRY_BLOCK_RE = /```board-entry\s*\n([\s\S]*?)```/;
const BLOCK_SEP = "---";

export interface CardHeader {
  id: string;
  title: string;
  createdBy: string;
  createdAt: string;
}

export interface Card extends CardHeader {
  file: string;
  body: string;
  entries: Entry[];
}

export interface Entry {
  id: string;
  type: string;
  author: string;
  at: string;
  text: string;
}

export interface ParsedEntryBlock {
  title?: string;
  type: string;
  text: string;
}

/** What a two-phase write is waiting for: a new card, or an entry on an existing one. */
export interface PendingWrite {
  cardId: string | null;
  isNew: boolean;
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "card";
}

function listCardFiles(boardDir: string): string[] {
  try {
    return fs
      .readdirSync(boardDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(boardDir, f))
      .sort();
  } catch {
    return [];
  }
}

function nextCardId(boardDir: string): string {
  let max = 0;
  for (const file of listCardFiles(boardDir)) {
    const m = path.basename(file).match(/^c-(\d+)-/);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `c-${String(max + 1).padStart(4, "0")}`;
}

function nextEntryId(body: string): string {
  let max = 0;
  for (const m of body.matchAll(/^### e-(\d+) ·/gm)) {
    max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `e-${String(max + 1).padStart(4, "0")}`;
}

function serialize(card: CardHeader, body: string): string {
  return `---\nid: ${card.id}\ntitle: ${card.title}\ncreated_by: ${card.createdBy}\ncreated_at: ${card.createdAt}\n---\n${body}`;
}

function appendEntryText(body: string, entry: Entry): string {
  const section = `### ${entry.id} · ${entry.type} · ${entry.author} · ${entry.at}\n\n${entry.text.trim()}\n`;
  return `${body.replace(/\s+$/, "")}\n\n${section}`;
}

export function renderCard(card: Card): string {
  return `📋 ${card.id} — ${card.title}\n   created_by: ${card.createdBy} · created_at: ${card.createdAt}\n\n${card.body.trim()}\n`;
}

/** Parse the fenced `board-entry` block out of an assistant reply (the two-phase write protocol). */
export function parseBoardEntryBlock(reply: string): ParsedEntryBlock | null {
  const m = reply.match(ENTRY_BLOCK_RE);
  if (!m) return null;
  const content = m[1];
  const sepIdx = content.indexOf(BLOCK_SEP);
  if (sepIdx < 0) return null;
  const text = content.slice(sepIdx + BLOCK_SEP.length).trim();
  if (!text) return null;
  const meta: Record<string, string> = {};
  for (const line of content.slice(0, sepIdx).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { title: meta.title, type: meta.type || "note", text };
}

export class Board {
  readonly dir: string;
  private pending: PendingWrite | null = null;

  constructor(dir: string = DEFAULT_BOARD_DIR) {
    this.dir = dir;
  }

  getPending(): PendingWrite | null {
    return this.pending;
  }

  setPending(p: PendingWrite | null): void {
    this.pending = p;
  }

  list(): CardHeader[] {
    return listCardFiles(this.dir).flatMap((file) => {
      const card = this.read(file);
      return card ? [{ id: card.id, title: card.title, createdBy: card.createdBy, createdAt: card.createdAt }] : [];
    });
  }

  read(fileOrId: string): Card | null {
    const file = fileOrId.endsWith(".md") ? fileOrId : this.findFile(fileOrId);
    if (!file) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!fm) return null;
    const meta: Record<string, string> = {};
    for (const line of fm[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (!meta.id) return null;
    const body = raw.slice(fm[0].length);
    const entries: Entry[] = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ENTRY_HEADER_RE);
      if (!m) continue;
      const rest = lines.slice(i + 1).join("\n");
      const nextIdx = rest.search(/^### e-\d+ · /m);
      entries.push({
        id: m[1],
        type: m[2],
        author: m[3],
        at: m[4],
        text: (nextIdx >= 0 ? rest.slice(0, nextIdx) : rest).trim(),
      });
    }
    const header: CardHeader = {
      id: meta.id,
      title: meta.title ?? "(untitled)",
      createdBy: meta.created_by ?? "?",
      createdAt: meta.created_at ?? "?",
    };
    return { ...header, file, body, entries };
  }

  private findFile(id: string): string | undefined {
    return listCardFiles(this.dir).find((f) => path.basename(f).startsWith(`${id}-`));
  }

  create(title: string, author: string, firstEntry?: Omit<Entry, "id">): Card {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = nextCardId(this.dir);
    const header: CardHeader = { id, title, createdBy: author, createdAt: new Date().toISOString() };
    let body = "";
    const entries: Entry[] = [];
    if (firstEntry) {
      const entry: Entry = { id: "e-0001", ...firstEntry };
      body = appendEntryText(body, entry);
      entries.push(entry);
    }
    fs.writeFileSync(path.join(this.dir, `${id}-${slugify(title)}.md`), serialize(header, body), "utf-8");
    return { ...header, file: path.join(this.dir, `${id}-${slugify(title)}.md`), body, entries };
  }

  append(cardId: string, type: string, text: string, author: string): Entry {
    const card = this.read(cardId);
    if (!card) throw new Error(`card not found: ${cardId}`);
    const entry: Entry = { id: nextEntryId(card.body), type, author, at: new Date().toISOString(), text };
    fs.writeFileSync(card.file, serialize(card, appendEntryText(card.body, entry)), "utf-8");
    return entry;
  }

  del(cardId: string): string | null {
    const card = this.read(cardId);
    if (!card) return null;
    fs.unlinkSync(card.file);
    return card.file;
  }

  clean(): string[] {
    const files = listCardFiles(this.dir);
    for (const f of files) fs.unlinkSync(f);
    return files;
  }
}

export interface BoardOptions {
  boardDir?: string;
  /** Xfer identity of this session — Entry author / card creator. */
  getAuthor?: () => string;
}

export interface BoardCompletion {
  value: string;
  label: string;
  description?: string;
}

export interface BoardApi {
  board: Board;
  completions(prefixAfterBoard: string): BoardCompletion[] | null;
}

const BOARD_SUBS: BoardCompletion[] = [
  { value: "board list", label: "list", description: "List cards on the board" },
  { value: "board new", label: "new", description: "Create a card (title optional — the agent names it)" },
  { value: "board read", label: "read", description: "Inject a card's full content into the conversation" },
  { value: "board write", label: "write", description: "Append an entry — the agent composes it from your intent" },
  { value: "board del", label: "del", description: "Delete a single card (confirm)" },
  { value: "board clean", label: "clean", description: "Delete all cards (confirm)" },
  { value: "board open", label: "open", description: "Open the board directory in the file manager" },
];

/** Wire the board onto pi: the agent_end interceptor for two-phase writes. Returns the API the /xfer command consumes. */
export function registerBoard(pi: ExtensionAPI, options: BoardOptions = {}): BoardApi {
  const board = new Board(options.boardDir);
  const getAuthor = options.getAuthor ?? (() => "unknown");

  pi.on("agent_end", async (event, ctx) => {
    const pending = board.getPending();
    if (!pending) return;
    board.setPending(null);
    const lastAssistant = [...event.messages].reverse().find((msg) => msg.role === "assistant");
    if (!lastAssistant) {
      ctx.ui.notify("⚠️ board write aborted — no reply from the agent", "warning");
      return;
    }
    const content = lastAssistant.content;
    const reply = typeof content === "string" ? content : content.map((b) => ("text" in b ? b.text : "")).join("\n");
    const parsed = parseBoardEntryBlock(reply);
    if (!parsed) {
      ctx.ui.notify("⚠️ board write aborted — reply had no ```board-entry block; nothing written", "warning");
      return;
    }
    try {
      if (pending.isNew) {
        const title = parsed.title ?? "(untitled)";
        const card = board.create(title, getAuthor(), { type: parsed.type, author: getAuthor(), at: new Date().toISOString(), text: parsed.text });
        ctx.ui.notify(`🆕 ${card.id} — ${card.title} (e-0001 appended)`, "info");
      } else if (pending.cardId) {
        const entry = board.append(pending.cardId, parsed.type, parsed.text, getAuthor());
        ctx.ui.notify(`📥 ${entry.id} · ${entry.type} appended to ${pending.cardId}`, "info");
      }
    } catch (err) {
      ctx.ui.notify(`❌ board write failed — ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });

  const completions = (prefix: string): BoardCompletion[] | null => {
    const subPrefix = prefix.replace(/^\s+/, "");
    const idCompleting = subPrefix.match(/^(read|del|write)\s+(.*)$/);
    if (idCompleting) {
      const [, cmd, idPrefix] = idCompleting;
      return board
        .list()
        .filter((c) => c.id.startsWith(idPrefix))
        .map((c) => ({ value: `board ${cmd} ${c.id}`, label: c.id, description: c.title }));
    }
    if (subPrefix === "") return BOARD_SUBS;
    return BOARD_SUBS.filter((s) => s.label.startsWith(subPrefix.split(" ")[0]));
  };

  return { board, completions };
}
