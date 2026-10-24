/**
 * ssh-link.ts — peer-to-peer ssh transport (ADR-0021).
 *
 * A **Link** is one ssh forward between this pi and a remote machine:
 *
 *   in   (-L)  a remote socket is imported into this machine's xfer dir, so
 *              `listPeers` finds it and `/xfer <name>` reaches it. The remote
 *              names must be given: they are what the remote already listens on.
 *   out  (-R)  this pi's own socket is exported to the remote, so the remote
 *              can address this agent by name. Nothing to name — the target is
 *              always this process's own listener (override only when the
 *              remote needs a different name).
 *
 * The direction is never a middle value: each half has a different
 * precondition — `out` needs this pi's socket (always there), `in` needs the
 * remote's sockets (only a probe knows). Asserting both at once would assume a
 * symmetric situation the workflow never guarantees, so there is no `both`.
 *
 * The ssh process belongs to the pi process that created it: `shutdown` kills
 * it, and every ledger entry records that owner so `down` never touches a Link
 * someone else maintains. Sockets are created by ssh itself, which is what
 * makes them discoverable to `listPeers`.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeAgentName, metadataForName } from "./utils.ts";

/** `in` imports remote sockets locally (-L), `out` exports this pi's socket (-R). */
export type LinkDirection = "in" | "out";

/** Options read by every ssh-link operation (tests inject these). */
export interface SshLinkOptions {
  /** Local xfer dir holding the Link sockets; defaults to XFER_DIR via the caller. */
  xferDir: string;
  /** This pi's xfer name — the `out` target and the default remote landing name. */
  myName: string;
  /** Optional identity file passed to every ssh invocation (-i). */
  keyPath?: string;
  /** Remote names to import; required by `in`, ignored by `out`. */
  names?: string[];
  /** Remote landing name for `out`; defaults to `myName`. */
  asName?: string;
  /** Required by `sshUp`; ignored by list/down. */
  direction?: LinkDirection;
  /** Owner pid written into the ledger; defaults to this process. */
  ownerPid?: number;
}

/** One live Link, as recorded in its `<name>.json`. */
export interface LinkInfo {
  /** The local socket-file name this Link occupies (decoded). */
  name: string;
  /** For `in`, the remote socket it points at. Same as `name`. */
  host: string;
  pid: number;
  /** The pi process that created it; `down` only touches its own. */
  owner: number;
  direction: LinkDirection;
}

/** Result of a successful link-up. */
export interface SshUpResult {
  host: string;
  pid: number;
  direction: LinkDirection;
  /** Local names this Link now serves (remote names for `in`, own name for `out`). */
  names: string[];
  /** Pre-existing Links to the same host that were killed and rebuilt. */
  rebuilt: string[];
}

function requireDirection(opts: SshLinkOptions): LinkDirection {
  if (!opts.direction) throw new Error("a direction is required (in | out)");
  return opts.direction;
}

function linkJsonPath(name: string, opts: SshLinkOptions): string {
  return metadataForName(name, opts.xferDir);
}

function decodeStem(stem: string): string {
  try { return decodeURIComponent(stem); } catch { return stem; }
}

/** Every Link record in `xferDir`, regardless of owner or liveness. */
export function listLinks(opts: SshLinkOptions): LinkInfo[] {
  try {
    return fs.readdirSync(opts.xferDir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(opts.xferDir, f), "utf-8")) as Record<string, unknown>;
          if (raw.via !== "ssh" || typeof raw.host !== "string" || typeof raw.pid !== "number") return null;
          return {
            name: decodeStem(f.slice(0, -".json".length)),
            host: raw.host,
            pid: raw.pid,
            owner: typeof raw.owner === "number" ? raw.owner : -1,
            direction: raw.direction === "out" ? "out" : "in",
          } as LinkInfo;
        } catch { return null; }
      })
      .filter((v): v is LinkInfo => v !== null);
  } catch { return []; }
}

/** Links created by this very process — the only ones `down`/`shutdown` may reap. */
export function listOwnLinks(opts: SshLinkOptions): LinkInfo[] {
  const me = opts.ownerPid ?? process.pid;
  return listLinks(opts).filter(l => l.owner === me);
}

/** True when the process behind a Link still exists. */
function linkAlive(link: LinkInfo): boolean {
  try { process.kill(link.pid, 0); return true; } catch { return false; }
}

/** Status word for `/xfer ssh list`: the ssh process is the only authority. */
export function linkStatus(link: LinkInfo): "up" | "dead" | "foreign" {
  if (!linkAlive(link)) return "dead";
  return link.owner === process.pid ? "up" : "foreign";
}

function killLink(link: LinkInfo, opts: SshLinkOptions): void {
  try { process.kill(link.pid, "SIGTERM"); } catch { /* already gone */ }
  try { fs.unlinkSync(path.join(opts.xferDir, `${encodeAgentName(link.name)}.sock`)); } catch { /* best effort */ }
  try { fs.unlinkSync(linkJsonPath(link.name, opts)); } catch { /* best effort */ }
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

/**
 * Detect the remote xfer dir and snapshot its existing socks in one round trip.
 * This is the `in` candidate list: what the remote already listens on.
 */
export async function probeRemote(host: string, keyPath?: string): Promise<{ dir: string; names: string[] }> {
  // XFER_DIR cannot travel via SendEnv/SetEnv (sshd AcceptEnv defaults don't
  // allow it), so the expression reads an env file the caller may have staged.
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
  /** For `in`: the remote names being imported. For `out`: the remote landing name. */
  names: string[];
}

/**
 * Probe the remote and validate the plan without starting anything.
 * Rejects on name collisions (ADR-0021: refuse, never auto-rename).
 */
export async function planSshUp(host: string, opts: SshLinkOptions): Promise<SshUpPlan> {
  const direction = requireDirection(opts);
  const remote = await probeRemote(host, opts.keyPath);
  const own = listOwnLinks(opts);
  const localStems = new Set(
    fs.existsSync(opts.xferDir)
      ? fs.readdirSync(opts.xferDir)
        .filter(f => f.endsWith(".sock"))
        .map(f => decodeStem(f.slice(0, -".sock".length)))
      : [],
  );
  const linkedByUs = new Set(own.filter(l => l.host === host).map(l => l.name));

  if (direction === "in") {
    const wanted = opts.names ?? [];
    if (wanted.length === 0) {
      throw new Error(`in needs at least one remote name — available on ${host}: ${remote.names.join(", ") || "(none)"}`);
    }
    const missing = wanted.filter(n => !remote.names.includes(n));
    if (missing.length > 0) {
      throw new Error(
        `not found on ${host}: ${missing.join(", ")} — available: ${remote.names.join(", ") || "(none)"}`,
      );
    }
    for (const name of wanted) {
      if (localStems.has(name) && !linkedByUs.has(name)) {
        throw new Error(`"${name}" already exists locally as a non-Link socket — rename one side before linking`);
      }
    }
    return { host, remoteDir: remote.dir, names: wanted };
  }

  const landing = opts.asName ?? opts.myName;
  if (!landing) throw new Error("out needs a name to expose this pi under");
  if (remote.names.includes(landing)) {
    throw new Error(`${host} already has a node named "${landing}" — pick another name with: /xfer ssh out ${host} <name>`);
  }
  return { host, remoteDir: remote.dir, names: [landing] };
}

/**
 * Bring a Link up: kill any previous Link of ours to the same host, spawn
 * `ssh -N` for the one requested direction, write the ledger entries.
 */
export async function sshUp(host: string, opts: SshLinkOptions): Promise<SshUpResult> {
  const direction = requireDirection(opts);
  const plan = await planSshUp(host, opts);

  const previous = listOwnLinks(opts).filter(l => l.host === host);
  const rebuilt = previous.map(l => l.name);
  for (const link of previous) killLink(link, opts);

  const remoteSock = (name: string) => `${plan.remoteDir}/${encodeAgentName(name)}.sock`;
  const localSock = (name: string) => path.join(opts.xferDir, `${encodeAgentName(name)}.sock`);

  const forwards: string[] = [];
  if (direction === "in") {
    for (const name of plan.names) forwards.push("-L", `${localSock(name)}:${remoteSock(name)}`);
  } else {
    forwards.push("-R", `${remoteSock(plan.names[0])}:${localSock(opts.myName)}`);
  }

  const child = spawnSsh(host, [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    ...forwards,
  ], opts.keyPath);

  // `in` waits for its local landing sockets. `out` waits for the landing to
  // materialize on the remote: sshd creates it asynchronously, and a peer
  // scanning the remote dir before it lands would see this node flap.
  if (direction === "in") {
    await waitForSockets(child, plan.names.map(localSock), host);
  } else {
    await waitForRemoteSock(host, remoteSock(plan.names[0]), opts.keyPath);
  }

  for (const name of plan.names) {
    writeLinkJson(name, host, child.pid!, direction, opts);
  }
  return { host, pid: child.pid!, direction, names: plan.names, rebuilt };
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

function writeLinkJson(name: string, host: string, pid: number, direction: LinkDirection, opts: SshLinkOptions): void {
  const body = `${JSON.stringify({
    via: "ssh",
    host,
    pid,
    direction,
    owner: opts.ownerPid ?? process.pid,
  }, null, 2)}\n`;
  fs.writeFileSync(linkJsonPath(name, opts), body, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Tear down Links **this process** maintains, optionally narrowed to one host.
 * A Link another pi started is not ours to kill: it dies with its own owner,
 * and gc reaps the leftovers if that owner already exited.
 */
export function sshDown(host: string | undefined, opts: SshLinkOptions): LinkInfo[] {
  const targets = listOwnLinks(opts).filter(l => host === undefined || l.host === host);
  for (const link of targets) killLink(link, opts);
  return targets;
}
