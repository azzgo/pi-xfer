/**
 * xfer-adapterd — adapter daemon CLI for non-pi Agent Hosts.
 *
 * Subcommands:
 *   up                 start the local listener + Inbox (optionally join the mesh)
 *   send               hand off to a local peer socket (daemon-independent)
 *   mesh send          hand off to a mesh node without joining it
 *   mesh down          destroy this daemon's mesh actor and go offline
 *   list               discover local peers (a send-only host reads no directory)
 *   inbox take|list    consume or peek at this daemon's Inbox
 *   install            write the xfer-agent skill into a host directory
 *
 * The same bundle serves both transports: local Unix sockets are the default,
 * the mesh is an opt-in that pi's extension shares (same MeshNode).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sendNotify } from "../client.ts";
import { MESH_CONFIG_PATH, XFER_DIR } from "../constants.ts";
import { loadMeshConfig, parseMeshConfig, resolveMeshConfig } from "../mesh-config.ts";
import { stampHandoffKind, type HandoffKind } from "../handoff-kind.ts";
import type { XferNotifyOutcome } from "../types.ts";
import { senderCwdStampFor, stampDocument, type SenderCwdStamp } from "../sender-cwd-stamp.ts";
import { listTargets } from "../targets.ts";
import { endpointForName, isEntryPoint, metadataForName, msgId } from "../utils.ts";
import { defaultAdapterName, startAdapterd, type AdapterdHandle, type AdapterdMeshOptions } from "./daemon.ts";
import { inboxPathForName, listInbox, takeInbox, type InboxRecord } from "./inbox.ts";

interface Flags {
  [key: string]: string | boolean | undefined;
}

interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function log(message: string, outcome?: string): void {
  process.stdout.write(outcome ? `${message} ${outcome}\n` : `${message}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/**
 * A diagnostic that is not a failure. A preflight `Mismatch` warning means the
 * handoff *was* queued — the engine places it on the next send — so it must
 * reach stderr without touching the exit code, or a caller that trusts the exit
 * code reads a success as a failure.
 */
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

const USAGE = `xfer-adapterd — adapt a non-pi Agent Host to the xfer network

  xfer-adapterd up [--name N] [--on-handoff CMD] [--once] [--check] [--dir D] [--mesh ...]
  xfer-adapterd send <target> <file|-> <summary> --kind <task|notification> [--from N] [--dir D]
  xfer-adapterd mesh send <target> <file|-> <summary> --kind <task|notification> [--from N] [--dir D] [--mesh-config P] [--no-preflight]
  xfer-adapterd mesh down [--name N] [--dir D] [--mesh-config P]
  xfer-adapterd list [--dir D] [--json]
  xfer-adapterd inbox take|list [--name N] [--dir D] [--inbox P]
  xfer-adapterd install --host <cursor|generic> --into <dir> [--name N] [--no-mesh]`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [command, sub] = positionals;

  // `--help` anywhere means "print usage and stop". A host agent probing the
  // CLI must never accidentally start a resident daemon: `up --help` used to
  // ignore the flag, bind a socket, and hang forever — the probe became a
  // five-hour block with no output.
  if (flags.help === true || flags.h === true) {
    log(USAGE);
    return;
  }

  if (command === "up") {
    await runUp(positionals.slice(1), flags);
    return;
  }
  if (command === "send") {
    await runSend(positionals.slice(1), flags);
    return;
  }
  if (command === "mesh" && sub === "send") {
    await runMeshSend(positionals.slice(2), flags);
    return;
  }
  if (command === "mesh" && sub === "down") {
    await runMeshDown(flags);
    return;
  }
  if (command === "list") {
    runList(flags);
    return;
  }
  if (command === "inbox") {
    runInbox(sub, flags);
    return;
  }
  if (command === "install") {
    const { installAgentSkill } = await import("./install.ts");
    runInstall(flags, installAgentSkill);
    return;
  }
  fail(USAGE);
}

async function runUp(argv: string[], flags: Flags): Promise<void> {
  if (argv.length > 0) {
    fail(USAGE);
    return;
  }
  const name = str(flags.name) ?? defaultAdapterName();
  const dir = str(flags.dir) ?? XFER_DIR;
  const onHandoff = str(flags["on-handoff"]);
  const once = flags.once === true;
  let mesh: AdapterdMeshOptions | undefined;
  if (flags.mesh === true) {
    const configPath = str(flags["mesh-config"]) ?? MESH_CONFIG_PATH;
    const engine = str(flags.engine);
    try {
      const config = engine
        ? parseMeshConfig({ endpoint: engine, namespace: str(flags.namespace), token: str(flags.token), pool: str(flags.pool) })
        : await resolveMeshConfig(loadMeshConfig(configPath));
      mesh = { configPath, config };
    } catch (err) {
      fail(`❌ --mesh requested but mesh is not configured — ${errorText(err)}`);
      return;
    }
  }
  let handle: AdapterdHandle | null = null;
  let signals = 0;
  let armed = false;
  const shutdown = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    if (!handle) { armed = true; return; }
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  // Install before binding: a signal that lands during startup must still drain.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    handle = await startAdapterd({
      name,
      dir,
      host: str(flags.host) ?? "generic",
      onHandoff,
      once,
      mesh,
      onOnce: () => process.exit(0),
    });
  } catch (err) {
    fail(`❌ xfer-adapterd up failed: ${errorText(err)}`);
    return;
  }

  log(`🟢 xfer-adapterd up as "${handle.name}" — ${handle.endpoint}${handle.meshOnline ? " [mesh]" : ""}`);
  log(`   inbox: ${handle.inboxPath}${onHandoff ? `\n   on-handoff: ${onHandoff}` : ""}`);
  // `--check` reports what came up, then leaves: the one-shot probe for a
  // host that wants to know "would this daemon work?" without a resident
  // process. `up` without it is a daemon and never returns on its own.
  if (flags.check === true) {
    await handle.close();
    process.exit(0);
  }
  if (armed) shutdown();
}

async function runSend(argv: string[], flags: Flags): Promise<void> {
  const { target, file, summary } = splitSendArgs(argv);
  if (!target || !file || !summary) {
    fail(`Usage: xfer-adapterd send <target> <file|-> <summary> --kind <task|notification>`);
    return;
  }
  const kind = readKind(str(flags.kind));
  if (!kind) {
    fail(`❌ --kind must be "task" or "notification" — see the xfer-agent skill; a handoff that declares no kind reads as a notification and never comes back`);
    return;
  }
  const body = readDocument(file);
  if (body === null) return;
  const dir = str(flags.dir) ?? XFER_DIR;
  const from = str(flags.from) ?? "unknown";
  const id = msgId();
  try {
    const outcome = await sendNotify(target, {
      type: "xfer-notify",
      msg_id: id,
      from,
      file: writeOutboundDoc(body, from, dir, kind, id),
      summary,
    }, dir);
    log(id, outcome);
  } catch (err) {
    fail(`❌ send to "${target}" failed: ${errorText(err)} ${failedSendOutcome(err)}`);
  }
}

/**
 * The handoff document for a send: the file's contents, or stdin for `-`.
 *
 * `-` exists because a host that builds a handoff in memory (a gateway, a
 * harness) otherwise has to write a temp file only for this CLI to read it
 * back. Null means the read failed and the error is already on stderr.
 */
function readDocument(file: string): string | null {
  if (file === "-") return fs.readFileSync(0, "utf-8");
  if (!fs.existsSync(file)) {
    fail(`❌ handoff file not found: ${file}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

/** The declared kind, or null when the flag is missing or meaningless. */
function readKind(value: string | undefined): HandoffKind | null {
  return value === "task" || value === "notification" ? value : null;
}

/**
 * Which of ADR-0020's four values a *failed* send leaves behind.
 *
 * Only one failure is a definite negative: `sendNotify` rejects "peer not found"
 * before it ever connects, so nothing was sent. Everything else — an ack
 * timeout above all — may have arrived, and `unknown` is the value that says so
 * without inviting a resend. A fifth value would destroy exactly that
 * distinction, which is what the outcome axis exists to keep.
 */
export function failedSendOutcome(err: unknown): XferNotifyOutcome {
  return /peer ".*" not found/.test(errorText(err)) ? "not-delivered" : "unknown";
}

/**
 * The mesh side has already classified its own failure (`MeshSendError.kind`,
 * from `classifyMeshSendFailure`), so this only names the value it implies.
 * `failed` is the one input with no definite answer — the engine refused for a
 * reason it did not classify, and the handoff may or may not have been queued —
 * so it degrades to `unknown` rather than to a claim of non-delivery.
 */
export function meshFailureOutcome(err: unknown): XferNotifyOutcome {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (kind === "not-delivered") return "not-delivered";
  return "unknown";
}

/**
 * The document to put on the wire: the sender's kind and cwd, both declared by
 * this tool rather than left to whatever the agent wrote in the file. Written
 * beside the original, so the file handed in stays untouched.
 */
function writeOutboundDoc(body: string, from: string, dir: string, kind: HandoffKind, id: string): string {
  const stamp = senderStamp(from, dir);
  const document = stampHandoffKind(stamp ? stampDocument(body, stamp) : body, kind);
  const target = path.join(os.tmpdir(), `xfer-adapterd-${id}.md`);
  fs.writeFileSync(target, document, { encoding: "utf-8", mode: 0o600 });
  return target;
}

/**
 * The cwd anchor to declare on this sender's docs, read from the named daemon's
 * metadata. Null when there is none — an unknown cwd is better left unsaid than
 * guessed from the CLI's own working directory.
 */
function senderStamp(from: string, dir: string): SenderCwdStamp | null {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataForName(from, dir), "utf-8")) as { cwd?: string };
    return metadata.cwd ? senderCwdStampFor(metadata.cwd, os.hostname()) : null;
  } catch {
    return null;
  }
}



async function runMeshSend(argv: string[], flags: Flags): Promise<void> {
  const { target, file, summary } = splitSendArgs(argv);
  if (!target || !file || !summary) {
    fail(`Usage: xfer-adapterd mesh send <target> <file|-> <summary> --kind <task|notification>`);
    return;
  }
  const kind = readKind(str(flags.kind));
  if (!kind) {
    fail(`❌ --kind must be "task" or "notification" — see the xfer-agent skill; a handoff that declares no kind reads as a notification and never comes back`);
    return;
  }
  const body = readDocument(file);
  if (body === null) return;
  const { sendMeshHandoff } = await import("../mesh-engine.ts");
  const engine = str(flags.engine);
  let config;
  try {
    config = engine
      ? parseMeshConfig({ endpoint: engine, namespace: str(flags.namespace), token: str(flags.token), pool: str(flags.pool) })
      : await resolveMeshConfig(loadMeshConfig(str(flags["mesh-config"]) ?? MESH_CONFIG_PATH));
  } catch (err) {
    fail(`❌ mesh is not configured — ${errorText(err)}`);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  const id = msgId();
  const from = str(flags.from) ?? "unknown";
  const stamp = senderStamp(from, dir);
  const document = stampHandoffKind(stamp ? stampDocument(body, stamp) : body, kind);
  try {
    const preflight = await sendMeshHandoff(
      config,
      target,
      { id, from, to: target, summary, document },
      undefined,
      { preflight: !flags["no-preflight"] },
    );
    log(id, "queued");
    if (preflight?.warning) warn(`⚠️ ${preflight.warning}`);
  } catch (err) {
    fail(`❌ ${errorText(err)} ${meshFailureOutcome(err)}`);
  }
}

/**
 * Destroy this daemon's mesh actor, releasing its name on the engine.
 *
 * A host whose daemon died leaves its actor behind: the engine still lists the
 * name, and the next `up` is refused with "already Running elsewhere" — a
 * failure that looks like another machine stole the name. `mesh down` is the
 * way a host releases it without an admin page.
 *
 * The local socket and inbox are untouched: this is the mesh half of going
 * offline, and the daemon keeps serving local peers.
 */
async function runMeshDown(flags: Flags): Promise<void> {
  const dir = str(flags.dir) ?? XFER_DIR;
  const name = str(flags.name) ?? soleAdapterName(dir);
  if (name === null) {
    fail(`❌ no adapter daemon found in ${dir} — pass --name <node> or start one with \`xfer-adapterd up\``);
    return;
  }
  const engine = str(flags.engine);
  let config;
  try {
    config = engine
      ? parseMeshConfig({ endpoint: engine, namespace: str(flags.namespace), token: str(flags.token), pool: str(flags.pool) })
      : await resolveMeshConfig(loadMeshConfig(str(flags["mesh-config"]) ?? MESH_CONFIG_PATH));
  } catch (err) {
    fail(`❌ mesh is not configured — ${errorText(err)}`);
    return;
  }
  const { destroyMeshNode, listMeshNodes } = await import("../mesh-engine.ts");
  try {
    const nodes = await listMeshNodes(config);
    const node = nodes.find((candidate) => candidate.name === name);
    if (!node) {
      log(`no mesh node named "${name}" on the engine — nothing to destroy`);
      return;
    }
    await destroyMeshNode(config, node.actorId);
    log(`🛑 mesh node "${name}" destroyed (actor ${node.actorId})`);
  } catch (err) {
    fail(`❌ mesh down for "${name}" failed: ${errorText(err)}`);
  }
}

/**
 * The only adapter daemon name in `dir`, or null when there is not exactly one.
 *
 * The same adoption rule the inbox uses: `--name` wins, otherwise the single
 * daemon in the directory is meant. Ambiguity is an error, never a guess.
 */
function soleAdapterName(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as Record<string, unknown>;
      if (value.kind === "adapterd" && typeof value.xferName === "string") found.push(value.xferName);
    } catch { /* not ours */ }
  }
  if (found.length === 0) return null;
  if (found.length > 1) return null;
  return found[0]!;
}

function splitSendArgs(argv: string[]): { target?: string; file?: string; summary?: string } {
  const [target, file, ...rest] = argv;
  return { target, file, summary: rest.join(" ").trim() || undefined };
}

/**
 * Local peer discovery. A send-only host — the MCP gateway, a script — binds no
 * socket and cannot tell a peer from a stale `.json`, so it must not have to
 * read `~/.pi/xfer` by hand. `--json` is one object per line: the same shape
 * `inbox` prints, so a caller parses every listing this CLI makes the same way.
 */
function runList(flags: Flags): void {
  const dir = str(flags.dir) ?? XFER_DIR;
  const targets = listTargets(dir);
  if (flags.json === true) {
    for (const target of targets) log(JSON.stringify(target));
    return;
  }
  for (const target of targets) {
    const details = [target.sessionName, target.status, target.cwd].filter((value) => typeof value === "string" && value !== "");
    log(details.length > 0 ? `${target.name}  ${details.join("  ")}` : target.name);
  }
}

function runInbox(sub: string | undefined, flags: Flags): void {
  if (sub !== "take" && sub !== "list") {
    fail(USAGE);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  const name = str(flags.name);
  const inboxFlag = str(flags.inbox);
  let inboxPath: string;
  try {
    inboxPath = inboxFlag ?? resolveInboxPath(dir, name);
  } catch (err) {
    fail(`❌ ${errorText(err)}`);
    return;
  }
  // An explicit --name must point at a daemon that exists — otherwise "empty
  // inbox" is indistinguishable from "never started", and an empty list reads
  // as a healthy signal. --inbox is trusted as given (explicit file path).
  if (!inboxFlag && name && !fs.existsSync(endpointForName(name, dir))) {
    fail(`no daemon "${name}" — start one with \`xfer-adapterd up --name ${name}\``);
    return;
  }
  let records: InboxRecord[];
  try {
    records = sub === "take" ? takeInbox(inboxPath) : listInbox(inboxPath);
  } catch (err) {
    fail(`❌ inbox ${sub} failed: ${errorText(err)}`);
    return;
  }
  for (const record of records) log(JSON.stringify(record));
}

/** `--name` wins; otherwise adopt the only adapter daemon metadata in `dir`. */
function resolveInboxPath(dir: string, name: string | undefined): string {
  if (name) return inboxPathForName(name, dir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new Error(`no adapter daemon found in ${dir} — start one with \`xfer-adapterd up\` or pass --name/--inbox`);
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as Record<string, unknown>;
      if (value.kind === "adapterd" && typeof value.inbox === "string") found.push(value.inbox);
    } catch { /* not ours */ }
  }
  if (found.length === 0) throw new Error(`no adapter daemon found in ${dir} — start one with \`xfer-adapterd up\` or pass --name/--inbox`);
  if (found.length > 1) throw new Error(`multiple adapter daemons in ${dir} — pass --name or --inbox`);
  return found[0]!;
}


function runInstall(flags: Flags, install: typeof import("./install.ts").installAgentSkill): void {
  const host = str(flags.host);
  const into = str(flags.into);
  if (!host || !into) {
    fail(`Usage: xfer-adapterd install --host <cursor|generic> --into <dir> [--name N]`);
    return;
  }
  const name = str(flags.name) ?? defaultAdapterName();
  const bundle = process.argv[1] ? path.resolve(process.argv[1]) : "xfer-adapterd.cjs";
  // Install exists to onboard non-pi hosts onto the network, so the generated
  // command joins the mesh by default; --no-mesh is the explicit local-only opt-out.
  const meshFlag = flags["no-mesh"] === true ? "" : " --mesh";
  const launchCommand = `node "${bundle}" up --name "${name}"${meshFlag}`;
  try {
    const result = install({ host, into, name, launchCommand });
    log(`✅ installed ${host} skill into ${into}`);
    for (const file of result.files) log(`   ${file}`);
  } catch (err) {
    fail(`❌ install failed: ${errorText(err)}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (isEntryPoint(["xfer-adapterd.cjs", "main.ts"])) {
  main().catch((err) => {
    fail(`❌ xfer-adapterd: ${errorText(err)}`);
  });
}
