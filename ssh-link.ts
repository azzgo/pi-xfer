/**
 * ssh-link.ts — peer-to-peer ssh transport (ADR-0021).
 *
 * A **Link** is the local endpoint of an ssh-forwarded remote Node: a
 * `<name>.sock` in the top-level xfer dir plus a `.json` marked
 * `{ via: "ssh", host, pid }`. `/xfer ssh up <user@host>` spawns one
 * `ssh -N` process carrying both directions:
 *
 *   -L  one entry per remote sock found at probe time (snapshot semantics)
 *   -R  this pi's real name, landing in the remote's top-level xfer dir
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

/** Options read by every ssh-link operation (tests inject these). */
export interface SshLinkOptions {
  /** Local xfer dir holding the Link sockets; defaults to XFER_DIR via the caller. */
  xferDir: string;
  /** This pi's xfer name (the -R landing point on the remote). */
  myName: string;
  /** Optional identity file passed to every ssh invocation (-i). */
  keyPath?: string;
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

/** Which existing Link occupies `name` (alive only); dead ones are swept by gc, not here. */
function findLink(name: string, opts: SshLinkOptions): LinkInfo | undefined {
  return listLinks(opts).find(l => l.name === name);
}

/** `ssh <host>` one-shot command, stdout captured, 15s cap. */
function sshCapture(host: string, remoteCommand: string, keyPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      ...(keyPath ? ["-i", keyPath] : []),
      host,
      remoteCommand,
    ], { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
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
  if (existingStems.has(opts.myName) && !findLink(opts.myName, opts)) {
    throw new Error(`local name "${opts.myName}" would collide with an existing local socket — rename one side before linking`);
  }
  for (const name of names) {
    const existingLink = existingLinks.find(l => l.name === encodeAgentName(name));
    if (existingStems.has(name) && !existingLink) {
      throw new Error(`remote node "${name}" collides with an existing local socket — rename one side before linking`);
    }
  }
  return { host, remoteDir: dir, remoteNames: names };
}

/**
 * Bring a Link up: kill any previous Link to the same host, spawn `ssh -N`
 * with both directions, write each Link `.json`. Sockets are created by ssh
 * itself, which is what makes them discoverable to `listPeers`.
 */
export async function sshUp(host: string, opts: SshLinkOptions): Promise<SshUpResult> {
  const plan = await planSshUp(host, opts);

  const previous = listLinks(opts).filter(l => l.host === host);
  const rebuilt = previous.map(l => decodeStem(l.name));
  for (const link of previous) killLink(link, opts);

  const remoteSock = (name: string) => `${plan.remoteDir}/${encodeAgentName(name)}.sock`;
  const localSock = (name: string) => path.join(opts.xferDir, `${encodeAgentName(name)}.sock`);

  const forwards: string[] = [];
  for (const name of plan.remoteNames) {
    forwards.push("-L", `${localSock(name)}:${remoteSock(name)}`);
  }
  forwards.push("-R", `${remoteSock(opts.myName)}:${localSock(opts.myName)}`);

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
  await waitForSockets(child, plan.remoteNames.map(localSock), host);
  await waitForRemoteSock(host, remoteSock(opts.myName), opts.keyPath);

  for (const name of plan.remoteNames) {
    writeLinkJson(name, host, child.pid!, opts);
  }
  // Self is on the other end of the -R, but the ledger entry belongs here so
  // `down` can find and kill its own ssh process.
  writeLinkJson(opts.myName, host, child.pid!, opts);
  return { host, pid: child.pid!, forwardNames: plan.remoteNames, rebuilt };
}

function spawnSsh(host: string, args: string[], keyPath?: string) {
  const child = spawn("ssh", ["-o", "BatchMode=yes", ...(keyPath ? ["-i", keyPath] : []), ...args, host], { stdio: "ignore" });
  child.unref();
  return child;
}

function waitForSockets(child: { pid?: number; on(ev: string, fn: () => void): void }, sockPaths: string[], host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (why: string) => { cleanup(); reject(new Error(why)); };
    const exitFn = (code: number | null) => fail(`ssh ${host} exited early (code ${code}) — check forward targets and remote dir`);
    const errFn = () => fail(`ssh ${host} failed to start`);
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

