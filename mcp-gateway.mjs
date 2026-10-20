#!/usr/bin/env node
/**
 * mcp-gateway — a stdio MCP server that gives a host's model typed xfer tools.
 *
 * The host spawns this process and owns its stdin/stdout, so there is one
 * gateway per host session and each carries its own `--name`. It binds no
 * socket, keeps no inbox, joins no mesh and runs no agent loop: every tool
 * builds an argv and forks the installed `xfer-adapterd`, which is the same CLI
 * a shell would call. That is also why `xfer_mesh_send` never talks to the
 * engine from here — the mesh code path lives in the CLI, guard included.
 *
 * Two rules this file exists to honour:
 *
 * - **stdout carries JSON-RPC frames and nothing else.** One stray line makes
 *   the session look like a broken client rather than a broken server, so every
 *   diagnostic — including a CLI's own stdout — goes to stderr.
 * - **`--name` is required and never derived.** A send-only gateway binds
 *   nothing, so a name collision cannot be caught the way a duplicate daemon is
 *   (`claimEndpoint`); it has to be refused at startup instead.
 *
 * `--no-preflight` is deliberately not a tool parameter: it is a human escape
 * hatch for debugging the engine, not something a model should reach for.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const SERVER_INFO = { name: "xfer-gateway", version: "0.1.0" };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const KIND_SCHEMA = {
  type: "string",
  enum: ["task", "notification"],
  description:
    'What this handoff asks of the target. "task": the target must produce output and returns exactly one conclusion (done, blocked, or needing input). "notification": it asks for nothing and stays silent unless it lacks information or the document conflicts with fact. Never send a handoff whose only purpose is to acknowledge or confirm.',
};

const SEND_HINT =
  "Never send a handoff whose only purpose is to acknowledge or confirm. Send only when the user asks for a handoff, or when you are blocked on that specific target and a reverse handoff is what unblocks you. Never send on your own initiative to check on another agent, to keep a thread alive, or to pass work to a third agent.";

const DOCUMENT_SCHEMA = {
  type: "string",
  description: "Full markdown handoff doc: context, problem, specific request, relevant files, suggested skills, notes.",
};

const TOOLS = [
  {
    name: "xfer_send",
    title: "Send a handoff to a local agent",
    description:
      `Send a one-way handoff markdown document to another agent on this machine, over its local xfer socket; returns immediately with a handoff outcome (no reply wait). Call xfer_list first for target names. ${SEND_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target agent name on this machine (see xfer_list)." },
        summary: { type: "string", description: "One-sentence summary of the request." },
        document: DOCUMENT_SCHEMA,
        kind: KIND_SCHEMA,
      },
      required: ["target", "summary", "document", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "xfer_mesh_send",
    title: "Send a handoff to a mesh node",
    description:
      `Send a one-way handoff markdown document to an xfer node on the cross-machine mesh; returns immediately with a handoff outcome (no reply wait). Use the mesh only when the user names a mesh node, never as a silent fallback. ${SEND_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target mesh node name (see /xfer mesh list)." },
        summary: { type: "string", description: "One-sentence summary of the request." },
        document: DOCUMENT_SCHEMA,
        kind: KIND_SCHEMA,
      },
      required: ["target", "summary", "document", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "xfer_list",
    title: "List local agents",
    description:
      "List the agents reachable on this machine as xfer targets, with whatever metadata their socket sibling records (session name, cwd, status). Local only: mesh nodes are listed by the xfer extension, not here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function parseArgs(argv) {
  const flags = {};
  const problems = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      problems.push(`unexpected argument "${arg}"`);
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
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, problems };
}

/** Resolve startup options. A refusal is a returned message, never a throw: the caller prints it to stderr and exits. */
export function resolveOptions(argv) {
  const { flags, problems } = parseArgs(argv);
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  if (problems.length > 0) return { error: problems.join("; ") };
  if (flags.help === true) {
    return { help: "usage: mcp-gateway --name <n> [--dir <d>] [--xfer-adapterd <path>] [--help]" };
  }
  if (name === "") {
    return {
      error:
        "xfer-gateway: --name is required. A send-only gateway binds no socket, so a name it shares with " +
        "another node is a collision nothing can detect — name it after this host (the name `xfer-adapterd " +
        "install` generates is the right one).",
    };
  }
  const adapterd = typeof flags["xfer-adapterd"] === "string" ? flags["xfer-adapterd"] : defaultAdapterdPath();
  return {
    name,
    dir: typeof flags.dir === "string" ? flags.dir : path.join(os.homedir(), ".pi", "xfer"),
    adapterd,
  };
}

function defaultAdapterdPath() {
  return path.join(import.meta.dirname, "xfer-adapterd.cjs");
}

/**
 * One argv per tool, and nothing else. Kept a pure function of its inputs so a
 * test can assert the exact argv without an engine, a CLI or a temp file — the
 * point being that a change to the CLI's flags cannot silently diverge from
 * what the tool schema promises.
 */
export function buildCommand(tool, args, options, documentPath) {
  const subcommand = SUBCOMMAND[tool];
  if (subcommand === undefined) throw new Error(`unknown tool "${tool}"`);
  if (tool === "xfer_list") return [options.adapterd, ...subcommand, "--json", "--dir", options.dir];
  return [options.adapterd, ...subcommand, ...sendArgs(args, options, documentPath)];
}

/**
 * `<target> <file> <summary> --kind <k>`. The target leads the subcommand's
 * operands so a refusal can name it without parsing the whole line back.
 */
function sendArgs(args, options, documentPath) {
  return [args.target, documentPath, args.summary, "--kind", args.kind, "--from", options.name, "--dir", options.dir];
}

/** Which CLI subcommand a tool maps to; `mesh send` carries one extra word before its operands. */
const SUBCOMMAND = {
  xfer_send: ["send"],
  xfer_mesh_send: ["mesh", "send"],
  xfer_list: ["list"],
};

/** ADR-0020's four values, and nothing else: a fifth would break the axis. */
const OUTCOMES = ["queued", "delivered", "unknown", "not-delivered"];

/** The no-resend sentence `index.ts` puts on `unknown`, so both surfaces say the same thing. */
const UNKNOWN_ADVICE = "It may or may not have arrived; do not resend it. Check with the target before sending again.";

/** The `<target>` operand of a send argv (`[cli, ...subcommand, target, ...]`), or "" for a listing. */
function targetOf(tool, argv) {
  if (tool === "xfer_list") return "";
  return argv[1 + SUBCOMMAND[tool].length] ?? "";
}

function writeTempDocument(id, document) {
  const target = path.join(os.tmpdir(), `xfer-gateway-${id}.handoff.md`);
  fs.writeFileSync(target, document, { encoding: "utf-8", mode: 0o600 });
  return target;
}

function removeTempDocument(documentPath) {
  try {
    fs.unlinkSync(documentPath);
  } catch {
    /* the send outcome is what matters, not the cleanup */
  }
}

/**
 * How to invoke the CLI. The bundle ships without an executable bit and a
 * tmpdir may be mounted `noexec`, so a JavaScript file is handed to this Node
 * instead of being asked to be its own interpreter. The path itself stays
 * authoritative — the interpreter is only put in front of it.
 */
export function cliArgv(argv) {
  const [cli, ...rest] = argv;
  return /\.(c|m)?js$/.test(cli) ? [process.execPath, cli, ...rest] : [cli, ...rest];
}

/** Run the CLI. Its stdout is the result; its stderr is relayed, never mixed in. */
export function execAdapterd(argv) {
  const [command, ...rest] = cliArgv(argv);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, rest, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * A handoff outcome as far as the CLI can honestly report it. The CLI prints
 * `<handoff_id> <outcome>` on success and its error on stderr otherwise, and a
 * failure must not read as "sent" — or, for `unknown`, as "resend it".
 */
function sendResult(tool, argv, run) {
  const text = run.stdout.trim();
  const target = targetOf(tool, argv);
  if (run.code !== 0) return failureResult(text, run.stderr.trim(), target, run.code);
  const [handoffId = "", outcome = "unknown"] = text.split(/\s+/);
  const grounded = OUTCOMES.includes(outcome) ? outcome : "unknown";
  return { isError: false, text, payload: { handoff_id: handoffId, outcome: grounded, target } };
}

/**
 * A failed send, expressed in ADR-0020's vocabulary rather than around it.
 *
 * The CLI names the outcome it left behind as the last word of its error line
 * (`… not-delivered` / `… unknown`), because exit codes and prose cannot carry a
 * four-valued answer on their own. When that word is missing — an older CLI, a
 * crash, a usage error — the honest value is `unknown`, never a definite
 * negative: the gateway did not watch the send, so it cannot claim nothing
 * happened. `unknown` also carries the no-resend sentence, because a model that
 * treats it as "try again" is the duplicate hazard the value exists to prevent.
 */
function failureResult(text, stderr, target, code) {
  const detail = stderr || text || `exit ${code}`;
  const named = OUTCOMES.find((outcome) => detail.endsWith(` ${outcome}`));
  const outcome = named ?? "unknown";
  const message = outcome === "unknown" ? `${detail} ${UNKNOWN_ADVICE}` : detail;
  return { isError: true, text, payload: { outcome, detail: message, target } };
}

function listResult(run) {
  if (run.code !== 0) {
    return { isError: true, text: run.stderr.trim() || `exit ${run.code}`, payload: { targets: [] } };
  }
  const targets = run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  return { isError: false, text: run.stdout.trim(), payload: { targets } };
}

async function callTool(name, args, options, exec) {
  const documentPath = name === "xfer_list" ? null : writeTempDocument(process.pid + "-" + Date.now(), String(args.document ?? ""));
  try {
    const argv = buildCommand(name, args, options, documentPath);
    const run = await exec(argv);
    return name === "xfer_list" ? listResult(run) : sendResult(name, argv, run);
  } finally {
    if (documentPath !== null) removeTempDocument(documentPath);
  }
}

function failureText(err) {
  return err instanceof Error ? err.message : String(err);
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(message, options, exec) {
  const { id = null, method, params = {} } = message;
  if (method === "initialize") {
    const asked = params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `xfer gateway for "${options.name}". Tools send one-way handoffs to other agents and list the ones ` +
          "reachable on this machine. A handoff never waits for a reply; the target's answer, if any, arrives as a handoff of its own.",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const toolName = params.name;
    if (!TOOLS.some((tool) => tool.name === toolName)) return errorResponse(id, -32602, `unknown tool "${toolName}"`);
    const result = await callTool(toolName, params.arguments ?? {}, options, exec);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.payload,
        isError: result.isError,
      },
    };
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  return errorResponse(id, -32601, `method not found: ${method}`);
}

/** Frame one JSON-RPC message onto stdout. Nothing else in this file writes there. */
function writeFrame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Serve one JSON-RPC message from a line of stdin. Every throw becomes a
 * JSON-RPC error frame: an unhandled rejection would kill the session, and a
 * stray console.log would corrupt it — both look like the client's fault.
 */
export async function handleLine(line, options, exec) {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    writeFrame(errorResponse(null, -32700, `parse error: ${failureText(err)}`));
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    writeFrame(errorResponse(null, -32600, "invalid request: expected a JSON-RPC object"));
    return;
  }
  if (message.id === undefined || message.id === null) {
    try {
      await dispatch(message, options, exec);
    } catch (err) {
      process.stderr.write(`xfer-gateway: notification failed — ${failureText(err)}\n`);
    }
    return;
  }
  try {
    writeFrame(await dispatch(message, options, exec));
  } catch (err) {
    writeFrame(errorResponse(message.id, -32603, failureText(err)));
  }
}

async function main() {
  const resolved = resolveOptions(process.argv.slice(2));
  if (resolved.error) {
    process.stderr.write(`${resolved.error}\n`);
    process.exitCode = 2;
    return;
  }
  if (resolved.help) {
    process.stderr.write(`${resolved.help}\n`);
    return;
  }
  process.on("uncaughtException", (err) => {
    process.stderr.write(`xfer-gateway: uncaught — ${failureText(err)}\n`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`xfer-gateway: unhandled rejection — ${failureText(err)}\n`);
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) await handleLine(line, resolved, execAdapterd);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  await main();
}
