/**
 * xfer-adapterd — adapter daemon CLI for non-pi Agent Hosts.
 *
 * Subcommands:
 *   up                 start the local listener + Inbox (optionally join the mesh)
 *   send               hand off to a local peer socket (daemon-independent)
 *   inbox take|list    consume or peek at this daemon's Inbox
 *   install            write the xfer-agent skill into a host directory
 *
 * The same bundle serves both transports: local Unix sockets are the default,
 * the mesh is an opt-in that pi's extension shares (same MeshNode).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sendNotify } from "../client.ts";
import { MESH_CONFIG_PATH, XFER_DIR } from "../constants.ts";
import { loadMeshConfig, parseMeshConfig } from "../mesh-config.ts";
import { isEntryPoint, msgId } from "../utils.ts";
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

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const USAGE = `xfer-adapterd — adapt a non-pi Agent Host to the xfer network

  xfer-adapterd up [--name N] [--on-handoff CMD] [--once] [--dir D] [--mesh ...]
  xfer-adapterd send <target> <file> <summary> [--from N] [--dir D]
  xfer-adapterd mesh send <target> <file> <summary> [--from N] [--mesh-config P]
  xfer-adapterd inbox take|list [--name N] [--dir D] [--inbox P]
  xfer-adapterd install --host <cursor|generic> --into <dir> [--name N]`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [command, sub] = positionals;

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
        ? parseMeshConfig({ endpoint: engine, namespace: str(flags.namespace), token: str(flags.token) })
        : loadMeshConfig(configPath);
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
  if (armed) shutdown();
}

async function runSend(argv: string[], flags: Flags): Promise<void> {
  const { target, file, summary } = splitSendArgs(argv);
  if (!target || !file || !summary) {
    fail(`Usage: xfer-adapterd send <target> <file> <summary>`);
    return;
  }
  if (!fs.existsSync(file)) {
    fail(`❌ handoff file not found: ${file}`);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  const from = str(flags.from) ?? defaultAdapterName();
  const id = msgId();
  try {
    await sendNotify(target, {
      type: "xfer-notify",
      msg_id: id,
      from,
      file: path.resolve(file),
      summary,
    }, dir);
    log(id);
  } catch (err) {
    fail(`❌ send to "${target}" failed: ${errorText(err)}`);
  }
}


async function runMeshSend(argv: string[], flags: Flags): Promise<void> {
  const { target, file, summary } = splitSendArgs(argv);
  if (!target || !file || !summary) {
    fail(`Usage: xfer-adapterd mesh send <target> <file> <summary>`);
    return;
  }
  if (!fs.existsSync(file)) {
    fail(`❌ handoff file not found: ${file}`);
    return;
  }
  const { sendMeshHandoff } = await import("../mesh-engine.ts");
  const engine = str(flags.engine);
  let config;
  try {
    config = engine
      ? parseMeshConfig({ endpoint: engine, namespace: str(flags.namespace), token: str(flags.token) })
      : loadMeshConfig(str(flags["mesh-config"]) ?? MESH_CONFIG_PATH);
  } catch (err) {
    fail(`❌ mesh is not configured — ${errorText(err)}`);
    return;
  }
  const id = msgId();
  const from = str(flags.from) ?? defaultAdapterName();
  try {
    await sendMeshHandoff(config, target, {
      id,
      from,
      to: target,
      summary,
      document: fs.readFileSync(file, "utf-8"),
    });
    log(id);
  } catch (err) {
    fail(`❌ mesh send to "${target}" failed: ${errorText(err)}`);
  }
}

function splitSendArgs(argv: string[]): { target?: string; file?: string; summary?: string } {
  const [target, file, ...rest] = argv;
  return { target, file, summary: rest.join(" ").trim() || undefined };
}

function runInbox(sub: string | undefined, flags: Flags): void {
  if (sub !== "take" && sub !== "list") {
    fail(USAGE);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  let inboxPath: string;
  try {
    inboxPath = str(flags.inbox) ?? resolveInboxPath(dir, str(flags.name));
  } catch (err) {
    fail(`❌ ${errorText(err)}`);
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
  const launchCommand = `node "${bundle}" up --name "${name}"`;
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
