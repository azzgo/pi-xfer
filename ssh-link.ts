/**
 * ssh-link.ts — peer-to-peer ssh transport (ADR-0021).
 *
 * A **Link** is the local endpoint of an ssh-forwarded remote Node: a
 * `<name>.sock` in the top-level xfer dir plus a `.json` marked
 * `{ via: "ssh", host, pid }`. `/xfer ssh up <user@host>` spawns one
 * `ssh -N` process in exactly one direction, chosen by the caller:
 *
 *   -L  (`out`) one entry per remote sock found at probe time (snapshot)
 *   -R  (`in`)  this pi's real name, landing in the remote's xfer dir
 *
 * The direction is never a middle value: each half has a different
 * precondition — -R needs this pi's socket (always there), -L needs the
 * remote's socks (only a probe knows). Asserting both at once would assume a
 * symmetric situation the workflow never guarantees.
 *
 * The ssh process is a child of the extension process, so pi's death tears
 * the tunnel down and the Link sockets vanish — autodispose with no cleanup
 * hooks. The `.json` is both the `/xfer list` source marker and the ledger:
 * `up` idempotence and `down` read it instead of a separate registry file.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeAgentName, metadataForName } from "./utils.ts";

/** Which half of the tunnel to open. Always explicit — a half tunnel is a real choice. */
export type LinkDirection = "in" | "out";

/** Options read by every ssh-link operation (tests inject these). */
export interface SshLinkOptions {
  /** Local xfer dir holding the Link sockets; defaults to XFER_DIR via the caller. */
  xferDir: string;
  /** This pi's xfer name (the -R landing point on the remote). */
  myName: string;
  /** Optional identity file passed to every ssh invocation (-i). */
  keyPath?: string;
  /**
   * Required by `sshUp`, ignored by `listLinks`/`sshDown`. `in` is -R only: the
   * remote can reach this pi, but its nodes do not appear locally. `out` is -L
   * only: this pi reaches the remote's nodes, but none can initiate a send back.
   */
  direction?: LinkDirection;
}

/** One live ssh Link, as recorded in its `<name>.json`. */
export interface LinkInfo {
  /** The Link name: the remote Node's xfer name, as it appears in `/xfer list`. */
  name: string;
  host: string;
  pid: number;
}

/** Result of `sshUp` — what was created, and what got torn down to do it. */
export interface SshUpResult {
  host: string;
  pid: number;
  /** Remote node names now reachable via -L (the snapshot). */
  forwardNames: string[];
  /** Pre-existing Links that were killed and rebuilt (e.g. remote snapshot changed). */
  rebuilt: string[];
}

function linkJsonPath(name: string, opts: SshLinkOptions): string {
  return metadataForName(name, opts.xferDir);
}

/** All Link records in `xferDir` whose recorded pid is still alive. */
export function listLinks(opts: SshLinkOptions): LinkInfo[] {
  try {
    return fs.readdirSync(opts.xferDir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(opts.xferDir, f), "utf-8")) as Record<string, unknown>;
          if (raw.via !== "ssh" || typeof raw.host !== "string" || typeof raw.pid !== "number") return null;
          return { name: f.slice(0, -".json".length), host: raw.host, pid: raw.pid };
        } catch { return null; }
      })
      .filter((v): v is LinkInfo => v !== null);
  } catch { return []; }
}

function killLink(link: LinkInfo, opts: SshLinkOptions): void {
  try { process.kill(link.pid, "SIGTERM"); } catch { /* already gone */ }
  try { fs.unlinkSync(path.join(opts.xferDir, `${link.name}.sock`)); } catch { /* best effort */ }
  try { fs.unlinkSync(linkJsonPath(decodeStem(link.name), opts)); } catch { /* best effort */ }
}

function decodeStem(stem: string): string {
  try { return decodeURIComponent(stem); } catch { return stem; }
}

/**
 * Build the ssh argv common to probe and tunnel. `BatchMode=yes` is mandatory:
 * the spawned ssh has no TTY, so an interactive password prompt can only hang
 * or fail. Key/agent auth is the supported path; a failure now reports ssh's
 * own stderr instead of a bare exit code.
 */
function sshBaseArgs(keyPath?: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...(keyPath ? ["-i", keyPath] : []),
  ];
}

/** Turn ssh's stderr into one line of advice a user can act on. */
function explainSshFailure(host: string, stderr: string): string {
  const text = stderr.trim();
  if (/Permission denied|publickey/i.test(text)) {
    return `ssh ${host}: authentication failed — this runs without a TTY, so it needs key-based auth ` +
      `(put your public key in the remote's ~/.ssh/authorized_keys, or start ssh-agent and ssh-add). ` +
      `A password prompt cannot be answered from here.`;
  }
  if (/Could not resolve hostname|Name or service not known/i.test(text)) {
    return `ssh ${host}: host not found — check the Host alias in ~/.ssh/config or the hostname`;
  }
  if (/Connection refused|timed out|No route to host/i.test(text)) {
    return `ssh ${host}: cannot reach the host — ${text.split("\n")[0]}`;
  }
  return text ? `ssh ${host}: ${text.split("\n").slice(-3).join(" ")}` : `ssh ${host}: failed (no stderr)`;
}

/** `ssh <host>` one-shot command, stdout captured, 15s cap. */
function sshCapture(host: string, remoteCommand: string, keyPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", [...sshBaseArgs(keyPath), host, remoteCommand], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(explainSshFailure(host, stderr)));
      else resolve(stdout);
    });
  });
}

/** Detect the remote xfer dir and snapshot its existing socks in one round trip. */
export async function probeRemote(host: string, keyPath?: string): Promise<{ dir: string; names: string[] }> {
  // XFER_DIR cannot travel via SendEnv/SetEnv (sshd AcceptEnv defaults don't
  // allow it), so the whole expression runs under a shell-level export that
  // reads an env file the caller may have staged — otherwise the default.
  const out = await sshCapture(host,
    'if [ -r ~/.pi/xfer-ssh-env ]; then . ~/.pi/xfer-ssh-env; fi; '
    + 'echo "${XFER_DIR:-$HOME/.pi/xfer}" && ls "${XFER_DIR:-$HOME/.pi/xfer}"/*.sock 2>/dev/null || true',
    keyPath);
  const lines = out.split("\n").filter(l => l.trim() !== "");
  const dir = lines.shift()?.trim();
  if (!dir) throw new Error(`ssh ${host}: empty probe output`);
  const names = lines
    .map(l => l.trim().split("/").pop() ?? "")
    .filter(n => n.endsWith(".sock"))
    .map(n => decodeStem(n.slice(0, -".sock".length)));
  return { dir, names };
}

export interface SshUpPlan {
  host: string;
  remoteDir: string;
  remoteNames: string[];
}

/**
 * Probe the remote and validate the name plan without starting anything.
 * Rejects on name collisions (ADR-0021: refuse, never auto-rename).
 */
export async function planSshUp(host: string, opts: SshLinkOptions): Promise<SshUpPlan> {
  const { dir, names } = await probeRemote(host, opts.keyPath);
  const existingLinks = listLinks(opts);
  const existingStems = new Set(fs.existsSync(opts.xferDir)
    ? fs.readdirSync(opts.xferDir).filter(f => f.endsWith(".sock")).map(f => decodeStem(f.slice(0, -".sock".length)))
    : []);

  if (names.includes(opts.myName)) {
    throw new Error(`remote ${host} already has a node named "${opts.myName}" — rename one side before linking`);
  }
  // NB: no check against this pi's own local socket. -R lands on the REMOTE
  // (`remote/<myName>.sock` forward to `local/<myName>.sock`), so the local
  // file is the forwarding TARGET and must exist — it is this pi's listener.
  for (const name of names) {
    if (opts.direction === "in") break; // no -L, so remote nodes never land locally
    const existingLink = existingLinks.find(l => l.name === encodeAgentName(name));
    if (existingStems.has(name) && !existingLink) {
      throw new Error(`remote node "${name}" collides with an existing local socket — rename one side before linking`);
    }
  }
  return { host, remoteDir: dir, remoteNames: names };
}

/**
 * Bring a Link up: kill any previous Link to the same host, spawn `ssh -N`
 * with the one requested direction, write each Link `.json`. Sockets are
 * created by ssh itself, which is what makes them discoverable to `listPeers`.
 */
export async function sshUp(host: string, opts: SshLinkOptions): Promise<SshUpResult> {
  const plan = await planSshUp(host, opts);

  const previous = listLinks(opts).filter(l => l.host === host);
  const rebuilt = previous.map(l => decodeStem(l.name));
  for (const link of previous) killLink(link, opts);

  const remoteSock = (name: string) => `${plan.remoteDir}/${encodeAgentName(name)}.sock`;
  const localSock = (name: string) => path.join(opts.xferDir, `${encodeAgentName(name)}.sock`);

  const direction = opts.direction;
  if (!direction) throw new Error("sshUp requires an explicit direction (in | out)");
  const forwards: string[] = [];
  if (direction !== "in") {
    for (const name of plan.remoteNames) {
      forwards.push("-L", `${localSock(name)}:${remoteSock(name)}`);
    }
  }
  if (direction !== "out") {
    forwards.push("-R", `${remoteSock(opts.myName)}:${localSock(opts.myName)}`);
  }

  const child = spawnSsh(host, [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    ...forwards,
  ], opts.keyPath);

  // Wait for the local forwards to appear (and the -R to be accepted —
  // ExitOnForwardFailure makes ssh exit if the remote bind fails), then wait
  // for the -R landing to actually materialize on the remote: sshd creates it
  // asynchronously, and a peer scanning the remote dir before it lands would
  // see this node flap between present and absent.
  await waitForSockets(child, direction === "in" ? [] : plan.remoteNames.map(localSock), host);
  if (direction !== "out") {
    await waitForRemoteSock(host, remoteSock(opts.myName), opts.keyPath);
  }

  // The ledger carries exactly the names that resolve through this tunnel: the
  // remote nodes only when -L exists, and self only when -R does. A `down`
  // then kills the same ssh pid from any entry.
  if (direction !== "in") {
    for (const name of plan.remoteNames) {
      writeLinkJson(name, host, child.pid!, opts);
    }
  }
  if (direction !== "out") {
    writeLinkJson(opts.myName, host, child.pid!, opts);
  }
  return { host, pid: child.pid!, forwardNames: direction === "in" ? [] : plan.remoteNames, rebuilt };
}

function spawnSsh(host: string, args: string[], keyPath?: string) {
  const child = spawn("ssh", [...sshBaseArgs(keyPath), ...args, host], { stdio: ["ignore", "ignore", "pipe"] });
  child.unref();
  return child;
}

function waitForSockets(
  child: { pid?: number; stderr?: NodeJS.ReadableStream | null; on(ev: string, fn: (arg?: any) => void): void; off(ev: string, fn: (arg?: any) => void): void },
  sockPaths: string[],
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const fail = (why: string) => { cleanup(); reject(new Error(why)); };
    const exitFn = (code: number | null) => fail(stderr.trim() ? explainSshFailure(host, stderr) : `ssh ${host} exited early (code ${code})`);
    const errFn = () => fail(`ssh ${host} could not be started — is the ssh client installed and on PATH?`);
    const timer = setTimeout(() => {
      const missing = sockPaths.filter(p => !fs.existsSync(p));
      if (missing.length > 0) fail(`ssh ${host}: forward sockets did not appear: ${missing.join(", ")}`);
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exitFn);
      child.off("error", errFn);
    };
    child.on("exit", exitFn);
    child.on("error", errFn);
    const poll = setInterval(() => {
      if (sockPaths.every(p => fs.existsSync(p))) {
        clearInterval(poll);
        clearTimeout(timer);
        cleanup();
        resolve();
      }
    }, 100);
    // If every forward is -R only there is nothing local to poll — but `up`
    // always has at least the -R check via exit watching, so resolve on first
    // poll once sockets exist or after the exit/timer paths fire.
    if (sockPaths.length === 0) {
      clearInterval(poll);
      clearTimeout(timer);
      cleanup();
      resolve();
    }
  });
}

/** Poll the remote until the -R landing sock exists (sshd creates it asynchronously). */
async function waitForRemoteSock(host: string, sockPath: string, keyPath?: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await sshCapture(host, `[ -S ${JSON.stringify(sockPath)} ]`, keyPath);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`ssh ${host}: -R landing ${sockPath} never appeared`);
}

function writeLinkJson(name: string, host: string, pid: number, opts: SshLinkOptions): void {
  const body = `${JSON.stringify({ via: "ssh", host, pid }, null, 2)}\n`;
  fs.writeFileSync(linkJsonPath(name, opts), body, { encoding: "utf-8", mode: 0o600 });
}

/** Tear down every Link to `host` (or all hosts when omitted). */
export function sshDown(host: string | undefined, opts: SshLinkOptions): LinkInfo[] {
  const targets = listLinks(opts).filter(l => host === undefined || l.host === host);
  for (const link of targets) killLink(link, opts);
  return targets;
}

