/**
 * ssh-link.ts — peer-to-peer ssh transport (ADR-0021).
 *
 * A **Link** is one ssh process to one host. It is always bidirectional:
 *
 *   -L  every remote socket this pi imported, appearing in the local xfer dir
 *       under the remote's name — `listPeers` finds it, `/xfer <name>` reaches it
 *   -R  this pi's own socket exported to the remote, exactly once, so the
 *       remote can always send back
 *
 * A tunnel with only one half is the thing this design rejected: with -L alone
 * a reply has no route, and every handoff then has to guess whether the other
 * side can answer. One process, both halves, no guessing.
 *
 * `in` is therefore additive per host: `/xfer ssh in pi-nas a` then
 * `/xfer ssh in pi-nas b` yields one ssh process carrying both `-L` entries and
 * the single `-R`. The unit of teardown is the host (a2's per-name teardown
 * would mean killing and rebuilding the process, which is complexity without
 * benefit at this size).
 *
 * The ledger is one file per host: `.link.<host>.json`, holding the ssh pid,
 * the owner pi, the imported names, and the reverse name. The remote side gets
 * a `<thisPi>.json` marked `role: "reverse"` so ITS agents know this socket is
 * a Link (inline the document, do not treat it as a local peer).
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeAgentName, metadataForName } from "../core/utils.ts";

/** Options read by every ssh-link operation (tests inject these). */
export interface SshLinkOptions {
  /** Local xfer dir holding the Link sockets; defaults to XFER_DIR via the caller. */
  xferDir: string;
  /** This pi's xfer name — the `-R` landing name on the remote. */
  myName: string;
  /** Optional identity file passed to every ssh invocation (-i). */
  keyPath?: string;
  /** Remote names to import; `in` merges them into the host's existing set. */
  names?: string[];
  /** Owner pid written into the ledger; defaults to this process. */
  ownerPid?: number;
}

/** One Link = one ssh process to one host. */
export interface LinkInfo {
  host: string;
  /** ssh process pid (the liveness anchor). */
  pid: number;
  /** The pi process that created it; `down` only touches its own. */
  owner: number;
  /** Remote sockets imported here, by their remote (and local) names. */
  names: string[];
  /** This pi's name on the remote — the one -R landing. */
  reverseAs: string;
  /**
   * The remote's xfer dir, recorded so teardown can remove the reverse marker
   * it wrote there. Without it, a clean exit would leave that marker behind on
   * the other machine and only its gc could ever clear it.
   */
  remoteDir: string;
}

/** Result of a successful link-up. */
export interface SshUpResult {
  host: string;
  pid: number;
  /** Every name now imported from this host (previous + newly requested). */
  names: string[];
  /** The single reverse landing name on the remote. */
  reverseAs: string;
  /** Names that this run added to an existing Link (kept alive, no rebuild). */
  added: string[];
  /** Every socket the remote had at probe time (for completion caches). */
  remoteNames: string[];
}

function ledgerPath(host: string, opts: SshLinkOptions): string {
  // Host may contain '/' or ':' (user@host, tunnel addresses); encode it so the
  // ledger stays a flat file next to the sockets.
  return path.join(opts.xferDir, `.link.${encodeURIComponent(host)}.json`);
}

function decodeStem(stem: string): string {
  try { return decodeURIComponent(stem); } catch { return stem; }
}

/** Parse one ledger file; null when absent or unusable. */
function readLedger(file: string, host: string): LinkInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (typeof raw.pid !== "number" || typeof raw.owner !== "number") return null;
    const names = Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === "string") : [];
    return {
      host,
      pid: raw.pid,
      owner: raw.owner,
      names,
      reverseAs: typeof raw.reverseAs === "string" ? raw.reverseAs : "",
      remoteDir: typeof raw.remoteDir === "string" ? raw.remoteDir : "",
    };
  } catch {
    return null;
  }
}

/** Every Link in `xferDir`, whoever owns it. */
export function listLinks(opts: SshLinkOptions): LinkInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(opts.xferDir).filter(f => f.startsWith(".link.") && f.endsWith(".json"));
  } catch {
    return [];
  }
  return entries
    .map(file => {
      const host = decodeStem(file.slice(".link.".length, -".json".length));
      return readLedger(path.join(opts.xferDir, file), host);
    })
    .filter((v): v is LinkInfo => v !== null);
}

/** Links created by this very process — the only ones `down`/`shutdown` may reap. */
export function listOwnLinks(opts: SshLinkOptions): LinkInfo[] {
  const me = opts.ownerPid ?? process.pid;
  return listLinks(opts).filter(l => l.owner === me);
}

function linkAlive(link: LinkInfo): boolean {
  try { process.kill(link.pid, 0); return true; } catch { return false; }
}

/** Status word for `/xfer ssh status`: the ssh process is the only authority. */
export function linkStatus(link: LinkInfo): "up" | "dead" | "foreign" {
  if (!linkAlive(link)) return "dead";
  return link.owner === process.pid ? "up" : "foreign";
}

function localSock(name: string, opts: SshLinkOptions): string {
  return path.join(opts.xferDir, `${encodeAgentName(name)}.sock`);
}

/**
 * Remove a Link's local footprint: the ssh process, every socket it created
 * here, and its ledger. The remote side is left alone — its sshd owns that
 * socket, and its gc reaps a leftover once the connection is gone.
 */
function killLink(link: LinkInfo, opts: SshLinkOptions): void {
  try { process.kill(link.pid, "SIGTERM"); } catch { /* already gone */ }
  for (const name of link.names) {
    try { fs.unlinkSync(localSock(name, opts)); } catch { /* best effort */ }
    // The import marker is ours (this pi wrote it for a socket it created), so
    // it goes with the socket — otherwise it lingers as a "reverse" record that
    // only gc could ever report, claiming a Link that no longer exists.
    try { fs.unlinkSync(metadataForName(name, opts.xferDir)); } catch { /* best effort */ }
  }
  try { fs.unlinkSync(ledgerPath(link.host, opts)); } catch { /* best effort */ }
}

/**
 * Remove the reverse marker this Link wrote on the remote.
 *
 * The marker belongs to this pi — it was created by this pi over ssh — so it is
 * this pi's to remove. Leaving it behind makes the remote believe a live Link
 * endpoint exists: it would inline documents for a node that is gone and report
 * `unknown` instead of an honest `not-delivered`. Best effort by design: the
 * ssh channel may already be closing, and a failure only restores the old
 * "the remote's gc will get it" fallback.
 */
async function removeReverseMarker(link: LinkInfo, opts: SshLinkOptions): Promise<void> {
  if (!link.reverseAs || !link.remoteDir) return;
  const target = `${link.remoteDir}/${encodeAgentName(link.reverseAs)}.json`;
  try {
    await sshCapture(link.host, `rm -f ${JSON.stringify(target)}`, opts.keyPath);
  } catch { /* the remote's gc is the fallback */ }
}

/**
 * Build the ssh argv common to probe and tunnel. `BatchMode=yes` is mandatory:
 * the spawned ssh has no TTY, so an interactive password prompt can only hang
 * or fail. Key/agent auth is the supported path; a failure reports ssh's own
 * stderr instead of a bare exit code.
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

/** The remote xfer dir, honouring an optional staged XFER_DIR file. */
const REMOTE_DIR_EXPR = 'if [ -r ~/.pi/xfer-ssh-env ]; then . ~/.pi/xfer-ssh-env; fi; XFER_DIR="${XFER_DIR:-$HOME/.pi/xfer}"; echo "$XFER_DIR"';

/**
 * Detect the remote xfer dir and snapshot its existing socks in one round trip.
 * Those names are the `in` candidates: what that machine already listens on.
 */
export async function probeRemote(
  host: string,
  keyPath?: string,
): Promise<{ dir: string; names: string[]; housed: string[] }> {
  // Each socket is reported with whether it also has a `.json` beside it, which
  // is what tells an agent that actually lives there apart from a bare sshd
  // endpoint. The distinction matters at exactly one moment: teardown. `sshDown`
  // deletes the metadata immediately but sshd releases the -R socket only when
  // the connection finishes closing, so for that gap a socket exists with no
  // agent behind it. Treating those the same made `down` followed by `in` fail
  // as "the remote already has a node named X" — a phantom collision.
  const out = await sshCapture(host,
    `${REMOTE_DIR_EXPR} && cd "$XFER_DIR" 2>/dev/null && `
    + `for f in *.sock; do [ -e "$f" ] || continue; n="\${f%.sock}"; `
    + `if [ -f "$n.json" ]; then echo "$n json"; else echo "$n bare"; fi; done || true`,
    keyPath);
  const lines = out.split("\n").filter(l => l.trim() !== "");
  const dir = lines.shift()?.trim();
  if (!dir) throw new Error(`ssh ${host}: empty probe output`);
  const names: string[] = [];
  const housed: string[] = [];
  for (const line of lines) {
    const [rawName, kind] = line.trim().split(/\s+/);
    if (!rawName) continue;
    const name = decodeStem(rawName);
    names.push(name);
    if (kind === "json") housed.push(name);
  }
  return { dir, names, housed };
}

export interface SshUpPlan {
  host: string;
  remoteDir: string;
  /** The full imported set after merging the request into the existing Link. */
  names: string[];
  /** The single reverse landing name on the remote. */
  reverseAs: string;
  /** Names this run adds (empty when the request only re-affirms what exists). */
  added: string[];
  /** The existing Link this run extends, when there is one. */
  existing?: LinkInfo;
  /**
   * Every socket the remote had at probe time (not just the imported subset).
   * Returned so callers can refresh completion caches from a probe they already
   * paid for, instead of showing a stale list until the next explicit `list`.
   */
  remoteNames: string[];
}

/**
 * Probe the remote and validate the plan without starting anything.
 * Rejects on name collisions (ADR-0021: refuse, never auto-rename).
 */
export async function planSshUp(host: string, opts: SshLinkOptions): Promise<SshUpPlan> {
  const remote = await probeRemote(host, opts.keyPath);
  const existing = listOwnLinks(opts).find(l => l.host === host);
  const requested = opts.names ?? [];

  // Union: `in` extends a host's Link, never replaces it.
  const names = [...new Set([...(existing?.names ?? []), ...requested])];
  const added = names.filter(n => !(existing?.names ?? []).includes(n));

  if (names.length === 0) {
    throw new Error(
      `in needs at least one remote name — available on ${host}: ${remote.names.join(", ") || "(none)"}`,
    );
  }

  const missing = names.filter(n => !remote.names.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `not found on ${host}: ${missing.join(", ")} — available: ${remote.names.join(", ") || "(none)"}`,
    );
  }

  const localStems = new Set(
    fs.existsSync(opts.xferDir)
      ? fs.readdirSync(opts.xferDir)
        .filter(f => f.endsWith(".sock"))
        .map(f => decodeStem(f.slice(0, -".sock".length)))
      : [],
  );
  for (const name of added) {
    if (localStems.has(name)) {
      throw new Error(`"${name}" already exists locally as a non-Link socket — rename one side before linking`);
    }
  }

  const reverseAs = existing?.reverseAs ?? opts.myName;
  if (!reverseAs) throw new Error("cannot expose this pi without a name — /xfer name <name> first");

  // The -R landing must not be one of the names this same tunnel imports: both
  // forwards would then claim the SAME remote path, and `-L local/X:remote/X`
  // plus `-R remote/X:local/X` is a loop that ssh cannot sort out.
  //
  // The check used to be skipped whenever an existing Link was being extended —
  // exactly the case where it matters, because a second `in` can add a name
  // that collides with the landing established by the first.
  if (names.includes(reverseAs)) {
    throw new Error(
      `cannot import "${reverseAs}" from ${host}: that is also the name this pi exposes itself under, ` +
      `so the -L and -R forwards would fight over one remote socket. ` +
      `Rename this pi first: /xfer name <another-name>`,
    );
  }
  // On a FIRST link the landing must also not shadow a node already on the
  // remote. When extending an existing Link the landing is already established
  // (ssh owns that socket), so the remote legitimately lists it.
  //
  // `housed` (socket AND metadata) is the honest signal: a bare socket is an
  // sshd endpoint with no agent behind it — most importantly, the remains of a
  // Link we just tore down, whose socket sshd has not released yet.
  if (!existing && remote.housed.includes(reverseAs)) {
    throw new Error(
      `${host} already has a node named "${reverseAs}" — rename this pi with /xfer name <name> before linking`,
    );
  }

  return {
    host,
    remoteDir: remote.dir,
    names,
    reverseAs,
    added,
    remoteNames: remote.names,
    housedNames: remote.housed,
    ...(existing ? { existing } : {}),
  };
}

/**
 * Bring a Link up: one ssh process carrying every imported socket (-L) and this
 * pi's single reverse landing (-R). Adding names to an existing Link rebuilds
 * the process (ssh cannot add a forward at runtime); the set is preserved.
 */
export async function sshUp(host: string, opts: SshLinkOptions): Promise<SshUpResult> {
  const plan = await planSshUp(host, opts);

  if (plan.existing) killLink(plan.existing, opts);

  const remoteSock = (name: string) => `${plan.remoteDir}/${encodeAgentName(name)}.sock`;
  const forwards: string[] = [];
  for (const name of plan.names) {
    forwards.push("-L", `${localSock(name, opts)}:${remoteSock(name)}`);
  }
  forwards.push("-R", `${remoteSock(plan.reverseAs)}:${localSock(opts.myName, opts)}`);

  const child = spawnSsh(host, [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    ...forwards,
  ], opts.keyPath);

  // Wait for the local landings, then for the reverse socket to materialise on
  // the remote (sshd creates it asynchronously; a peer scanning that dir before
  // it lands would see this node flap).
  await waitForSockets(child, plan.names.map(n => localSock(n, opts)), host);
  await waitForRemoteSock(host, remoteSock(plan.reverseAs), opts.keyPath);

  writeLedger(plan, child.pid!, opts);
  writeImportedMarkers(plan, opts);
  await writeReverseMarker(plan, opts);

  return {
    host,
    pid: child.pid!,
    names: plan.names,
    reverseAs: plan.reverseAs,
    added: plan.added,
    remoteNames: plan.remoteNames,
  };
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
    if (sockPaths.length === 0) {
      clearTimeout(timer);
      cleanup();
      resolve();
      return;
    }
    const poll = setInterval(() => {
      if (sockPaths.every(p => fs.existsSync(p))) {
        clearInterval(poll);
        clearTimeout(timer);
        cleanup();
        resolve();
      }
    }, 100);
    child.on("exit", () => clearInterval(poll));
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

/**
 * Write a `<name>.json` marker for every imported socket on THIS machine.
 *
 * Without it, the local peer is a bare socket: `readPeerMetadata` returns `{}`,
 * `isLinkTarget` says "not a Link", and every handoff addressed to it goes out
 * as a path the far side can never open — the exact failure this transport
 * exists to avoid, just in the other direction. A Link is symmetric: the remote
 * gets a reverse marker from us, and we get an import marker for each node we
 * brought in.
 *
 * No pid: the process behind this socket lives on the OTHER machine, so a pid
 * here would name an unrelated local process and make gc judge liveness wrongly.
 */
function writeImportedMarkers(plan: SshUpPlan, opts: SshLinkOptions): void {
  for (const name of plan.names) {
    const file = metadataForName(name, opts.xferDir);
    const body = `${JSON.stringify({
      xferName: name,
      via: "ssh",
      host: plan.host,
      // `import` = recorded by THIS machine for a socket it imported; gc may
      // clear it when the owning Link ledger is gone.
      role: "import",
    }, null, 2)}\n`;
    const temp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, body, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function writeLedger(plan: SshUpPlan, pid: number, opts: SshLinkOptions): void {
  const file = ledgerPath(plan.host, opts);
  const body = `${JSON.stringify({
    host: plan.host,
    pid,
    owner: opts.ownerPid ?? process.pid,
    names: plan.names,
    reverseAs: plan.reverseAs,
    remoteDir: plan.remoteDir,
  }, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, body, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}

/**
 * Write `<reverseAs>.json` on the remote, marked `role: "reverse"`.
 *
 * Without it the remote's agents see only a socket with no metadata, decide it
 * is a local peer, and hand off a path this machine can never read — the exact
 * failure that made the document inline rule necessary in the first place.
 * Deliberately carries **no pid**: it would name a process on THIS machine,
 * meaningless over there, and would make that side's gc judge liveness wrongly.
 */
async function writeReverseMarker(plan: SshUpPlan, opts: SshLinkOptions): Promise<void> {
  const marker = JSON.stringify({
    xferName: plan.reverseAs,
    via: "ssh",
    host: opts.myName,
    role: "reverse",
  });
  const target = `${plan.remoteDir}/${encodeAgentName(plan.reverseAs)}.json`;
  // printf with a single-quoted JSON body: no shell expansion of the payload.
  const body = marker.replace(/'/g, `'\\''`);
  await sshCapture(
    plan.host,
    `mkdir -p "${plan.remoteDir}" && printf '%s\\n' '${body}' > ${JSON.stringify(target)} && chmod 600 ${JSON.stringify(target)}`,
    opts.keyPath,
  ).catch(() => { /* marker is advisory: a missing one degrades to path-only docs */ });
}

/**
 * Tear down Links **this process** maintains, optionally narrowed to one host.
 *
 * One host = one ssh process = one unit: naming a forward tears down its whole
 * host Link, because ssh cannot drop a single -L at runtime (initial design
 * choice: no per-name counters).
 *
 * A Link another pi started is never ours to kill: it dies with its own owner,
 * and gc reaps the leftovers if that owner already exited.
 */
export async function sshDown(ident: string | undefined, opts: SshLinkOptions): Promise<{ torn: LinkInfo[] }> {
  const own = listOwnLinks(opts);
  const targets = ident === undefined
    ? own
    : own.filter(l => l.host === ident || l.names.includes(ident));
  // Remove each reverse marker BEFORE killing the ssh process: once the tunnel
  // is gone the marker can only be cleaned by the remote's own gc.
  await Promise.all(targets.map(link => removeReverseMarker(link, opts)));
  for (const link of targets) killLink(link, opts);
  return { torn: targets };
}
