/**
 * Sender-cwd anchoring (P1-D): one HTML comment on the first line of every
 * agent-originated handoff doc, naming the sender's working directory so the
 * receiving agent edits inside the sender's project instead of its own cwd.
 *
 *   <!-- xfer:sender-cwd cwd=/srv/app project=app machine=alpha branch=main -->
 *
 * Written by both send tools (tmp doc for `xfer_to`, inline doc for
 * `xfer_mesh_to`) and read back by `controller.deliverInbound` to build the
 * envelope instruction. Formatting is pure; the only I/O is two bounded file
 * reads (`.git/HEAD`, the head of the doc) — never a subprocess.
 *
 * `project` + `machine` are always present: they are the cross-machine anchor
 * when `cwd` does not exist on the receiver (worktrees of one repo at different
 * paths). Web-picker docs get no stamp — a browser, not a working directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Working-directory anchor carried by a handoff doc. */
export interface SenderCwdStamp {
  /** Absolute sender working directory. */
  cwd: string;
  /** Basename of `cwd` — the human-facing project label. */
  project: string;
  /** Hostname of the sending machine. */
  machine: string;
  /** Current git branch, when `<cwd>/.git/HEAD` names one. */
  branch?: string;
}

/** First-line stamp grammar. `cwd` is non-greedy so paths may contain spaces. */
const STAMP_LINE =
  /^<!--\s*xfer:sender-cwd\s+cwd=(.+?)\s+project=(\S*)\s+machine=(\S*?)(?:\s+branch=(\S*?))?\s*-->$/;

/** Enough head bytes to cover any stamp line; the doc body is never read. */
const HEAD_CHUNK_BYTES = 4096;

/** Render the stamp as a single-line HTML comment (no trailing newline). */
export function formatSenderCwdStamp(stamp: SenderCwdStamp): string {
  const branch = stamp.branch ? ` branch=${stamp.branch}` : "";
  return `<!-- xfer:sender-cwd cwd=${stamp.cwd} project=${stamp.project} machine=${stamp.machine}${branch} -->`;
}

/** Parse the stamp off a doc's first line; null when the doc carries none. */
export function parseSenderCwdStamp(document: string): SenderCwdStamp | null {
  const firstLine = document.split("\n", 1)[0]?.trim() ?? "";
  const match = STAMP_LINE.exec(firstLine);
  if (!match) return null;
  const [, cwd, project, machine, branch] = match;
  return { cwd: cwd!, project: project!, machine: machine!, ...(branch ? { branch } : {}) };
}

/** Read the stamp of a doc on disk; null when unreadable, unstamped, or short. */
export function readSenderCwdStamp(file: string): SenderCwdStamp | null {
  const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, chunk, 0, chunk.length, 0);
    return parseSenderCwdStamp(chunk.subarray(0, read).toString("utf-8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * Prepend the stamp line to a doc. A doc already carrying one is re-stamped in
 * place, so re-sending a quoted handoff never stacks anchor comments.
 */
export function stampDocument(document: string, stamp: SenderCwdStamp): string {
  const line = formatSenderCwdStamp(stamp);
  return parseSenderCwdStamp(document) ? document.replace(/^[^\n]*/, line) : `${line}\n${document}`;
}

/**
 * Branch name from `<cwd>/.git/HEAD` by plain file read. Handles `.git` as a
 * directory (plain checkout) and as a `gitdir:` pointer file (worktrees,
 * submodules); null for non-git trees, detached HEAD, and any read failure.
 */
export function readGitBranch(cwd: string): string | null {
  try {
    const git = path.join(cwd, ".git");
    let headPath = path.join(git, "HEAD");
    if (!fs.statSync(git).isDirectory()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf-8"));
      if (!pointer) return null;
      headPath = path.join(pointer[1]!.trim(), "HEAD");
    }
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(fs.readFileSync(headPath, "utf-8").trim());
    return ref?.[1]!.trim() || null;
  } catch {
    return null;
  }
}

/** Build the stamp for a sending process: cwd + project label + host + branch. */
export function senderCwdStampFor(cwd: string, machine: string): SenderCwdStamp {
  const branch = readGitBranch(cwd);
  return {
    cwd,
    project: path.basename(cwd) || cwd,
    machine,
    ...(branch ? { branch } : {}),
  };
}

/**
 * Envelope line telling the receiver where to edit. Non-local senders (mesh, or
 * a host we cannot match) also get the fallback: the path may not exist here.
 */
export function senderCwdInstruction(stamp: SenderCwdStamp, options: { local: boolean }): string {
  const anchor =
    `**Sender cwd**: \`${stamp.cwd}\` (project ${stamp.project} on machine ${stamp.machine}) — ` +
    `make all file edits here unless the doc says otherwise.`;
  if (options.local) return anchor;
  return (
    anchor +
    ` If that path does not exist on this machine, locate the project` +
    ` (and worktree/branch if given) before editing — ask the user only if ambiguous.`
  );
}