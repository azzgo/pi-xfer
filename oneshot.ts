import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { interpolate, type InterpolationVars } from "./settings.js";
import type { PeerSendConfig, XferNotifyMessage } from "./types.js";
import type { PeerSendEntry } from "./peers.js";
import { msgId } from "./utils.js";

/** Fire-and-forget outcome of a one-shot send: only the exit code really matters. */
export interface SendResult {
  ok: boolean;
  code: number | null;
  stderrHead: string;
}

/** Options for `sendPeerHandoff`. */
export interface SendPeerHandoffOptions {
  /** Sender's xfer name — the frame `from` field and the `%n` var. */
  from: string;
  /** One-sentence summary carried in the notify frame. */
  summary: string;
  /** Full markdown handoff document body. */
  document: string;
  /** Extra interpolation vars (e.g. `%p`); merged over the `%n`/`%peer` defaults. */
  vars?: InterpolationVars;
}

/** Resolved outcome of a peer handoff: doc path, message id and the send result. */
export interface SendPeerHandoffResult {
  handoff_id: string;
  docPath: string;
  result: SendResult;
}

/** Optional injection point so component tests can fake the send mechanism. */
export type SendFrameFn = typeof sendViaCommand;

/**
 * Write `document` to a 0600 temp file (`/tmp/pi-xfer-<id>.md`), then deliver it to the
 * remote settings peer `peer` via `send` (default: the real `sendViaCommand`). The frame
 * is the same `xfer-notify` shape the local socket path uses; vars default to `%n` =
 * `opts.from` and `%peer` = `peer.name`, merged under `opts.vars`.
 *
 * A template referencing an unprovided var (e.g. `%p`) makes `interpolate` throw — that
 * is the documented contract for send-command authors. On any failure — a thrown send or
 * a non-ok result — the temp doc is removed, and a non-ok result surfaces as a thrown
 * `Error` naming the exit code and the captured stderr head (exit code is the only result
 * of a one-way send).
 */
export async function sendPeerHandoff(
  peer: PeerSendEntry,
  opts: SendPeerHandoffOptions,
  send: SendFrameFn = sendViaCommand,
): Promise<SendPeerHandoffResult> {
  const mid = msgId();
  const docPath = path.join(os.tmpdir(), `pi-xfer-${mid}.md`);
  fs.writeFileSync(docPath, opts.document, { encoding: "utf-8", mode: 0o600 });
  try {
    const frame: XferNotifyMessage = {
      type: "xfer-notify",
      msg_id: mid,
      from: opts.from,
      file: docPath,
      summary: opts.summary,
    };
    const result = await send(peer, frame, { n: opts.from, peer: peer.name, ...opts.vars });
    if (!result.ok) {
      const stderr = result.stderrHead ? ` — ${result.stderrHead}` : "";
      throw new Error(`xfer: send command for peer "${peer.name}" failed (exit code ${result.code})${stderr}`);
    }
    return { handoff_id: mid, docPath, result };
  } catch (err) {
    try { fs.unlinkSync(docPath); } catch { /* best effort */ }
    throw err;
  }
}

/** Default cap on how long the spawned command may run. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Grace period between SIGTERM and SIGKILL when a timed-out child ignores TERM. */
const KILL_GRACE_MS = 2_000;
/** Length cap for the `stderrHead` field of `SendResult`. */
const STDERR_HEAD_CHARS = 500;

/**
 * Deliver `frame` to a remote peer by running the peer's one-shot `send` command.
 *
 * The serialized frame (`JSON.stringify(frame) + "\n"`) is staged in a 0600 temp file
 * under the mktemp pattern `/tmp/xfer-frame-*`. When the raw template references
 * `%msgfile` the command runs with stdin closed and is expected to read the staged file
 * itself; otherwise the frame bytes are piped to the child's stdin and the template must
 * not mention `%msgfile`. Either way the command runs under `sh -c` and its `stderr` is
 * captured.
 *
 * Resolves with the exit code (`null` when the child was killed or failed to spawn) —
 * throws only for config errors surfacing from `interpolate` (unknown token, undefined
 * var). The temp file is removed in a `finally`, best-effort.
 */
export async function sendViaCommand(
  peer: PeerSendConfig,
  frame: XferNotifyMessage,
  vars: InterpolationVars = {},
): Promise<SendResult> {
  const payload = Buffer.from(JSON.stringify(frame) + "\n", "utf-8");
  const tmpPath = createTempFrameFile();
  try {
    fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    // Branch on the raw template: `%msgfile` means the command reads the staged file itself.
    const readsFrameFile = peer.send.includes("%msgfile");
    const cmd = interpolate(peer.send, { ...vars, msgfile: tmpPath });
    const child = spawn("sh", ["-c", cmd], {
      stdio: readsFrameFile ? ["ignore", "ignore", "pipe"] : ["pipe", "ignore", "pipe"],
    });

    if (!readsFrameFile && child.stdin) {
      // The child may exit (or be killed) before draining stdin; the exit code decides, not EPIPE.
      child.stdin.on("error", () => { /* exit code still decides the result */ });
      child.stdin.write(payload);
      child.stdin.end();
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= STDERR_HEAD_CHARS) return;
      stderr += chunk.toString("utf-8");
    });

    const code = await waitExit(child, peer.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ok: code === 0, code, stderrHead: stderr.slice(0, STDERR_HEAD_CHARS) };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

/** Create an empty 0600 temp file matching the `/tmp/xfer-frame-*` mktemp pattern. */
function createTempFrameFile(): string {
  for (;;) {
    const suffix = Math.random().toString(36).slice(2, 8).padStart(6, "0");
    const candidate = path.join(os.tmpdir(), `xfer-frame-${suffix}`);
    try {
      // `wx` fails with EEXIST if the name is taken (however unlikely); retry with a new name.
      const fd = fs.openSync(candidate, "wx", 0o600);
      fs.closeSync(fd);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/**
 * Wait for `child` to exit, enforcing `timeoutMs`: on timeout SIGTERM, then — after a
 * grace period — SIGKILL, and keep waiting until the process is actually reaped.
 * Resolves with the exit code, or `null` when the child was killed or failed to spawn.
 */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(code);
    };

    const termTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code));
  });
}
