import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { withTimeout } from "../core/utils.ts";

/** Mesh engine config, stored at ~/.pi/xfer/mesh.config.json. */
export interface MeshConfig {
  endpoint: string;
  namespace?: string;
  token?: string;
  /**
   * The token exactly as authored, when it was not a plain literal: `$NAME` /
   * `${NAME}` interpolation or a leading `!command`. Kept unevaluated on purpose
   * (see {@link resolveMeshConfig}) — parsing a config must never spawn
   * anything, so a read-only surface such as `mesh list` cannot be made to run a
   * command just by being pointed at a file.
   */
  tokenExpression?: string;
  /** `namespace` as authored, when it used `$NAME` interpolation. */
  namespaceExpression?: string;
  /**
   * Envoy/runner pool this host's runners join (RivetKit `envoy.poolName`).
   * Pins this Node's actor to its own host instead of the engine's shared
   * `default` pool. Absent = today's behavior (default pool).
   */
  pool?: string;
}

/** Single actor type hosting one mesh node per pi instance. */
export const XFER_INSTANCE_ACTOR = "xfer-instance";

/** Queue carrying inline handoff payloads between mesh nodes. */
export const HANDOFF_QUEUE = "handoff";

/**
 * Parse + validate a mesh config object. Throws with a human-readable message
 * when malformed.
 *
 * `token` and `namespace` accept the same three value forms pi's `models.json`
 * uses (`$NAME` / `${NAME}` interpolation, a literal, or a leading
 * `!command`); see {@link resolveMeshConfig} for what each means. Parsing only
 * records *which* form was authored — it never evaluates one, so merely reading
 * a config cannot run a command.
 */
export function parseMeshConfig(raw: unknown): MeshConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mesh config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.endpoint !== "string" || obj.endpoint.trim() === "") {
    throw new Error('mesh config needs a non-empty "endpoint"');
  }
  rejectUrlAuth(obj.endpoint.trim(), obj);
  const config: MeshConfig = { endpoint: obj.endpoint.trim() };
  if (typeof obj.namespace === "string" && obj.namespace !== "") {
    if (isCommandValue(obj.namespace)) {
      // A command returning a namespace is the cost-free case the field does not
      // need: keep the surface honest instead of accepting a form nothing acts on.
      throw new Error('mesh config "namespace" takes a literal or $ENV_VAR, not a "!" command');
    }
    if (isTemplateValue(obj.namespace)) config.namespaceExpression = obj.namespace;
    else config.namespace = obj.namespace;
  }
  if (obj.token !== undefined) {
    if (typeof obj.token !== "string") {
      throw new Error(
        'mesh config "token" must be a string — a literal, "$MESH_TOKEN", or "!pass show mesh-token". ' +
        'The old { "command": [...] } object form was never released',
      );
    }
    if (obj.token !== "") {
      if (isTemplateValue(obj.token) || isCommandValue(obj.token)) config.tokenExpression = obj.token;
      else config.token = obj.token;
    }
  }
  if (obj.pool !== undefined) {
    if (typeof obj.pool !== "string" || obj.pool.trim() === "") {
      throw new Error('mesh config "pool" must be a non-empty string');
    }
    config.pool = obj.pool.trim();
  }
  return config;
}

/**
 * URL-auth (`https://ns:token@host`) is refused, not read.
 *
 * One URL carrying three pieces of configuration is what made it hard to reason
 * about — and once a token may be a command or an env lookup, embedding it in a
 * URL is a second, weaker spelling of the same thing. The error carries the
 * migration, because the old form looks valid and the fix is not guessable.
 */
function rejectUrlAuth(endpoint: string, raw: Record<string, unknown>): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (!url.username && !url.password) return;
  const namespace = decodeURIComponent(url.username) || "<namespace>";
  url.username = "";
  url.password = "";
  const migrated = {
    endpoint: url.toString(),
    namespace,
    token: "<token>",
    ...(typeof raw.pool === "string" && raw.pool !== "" ? { pool: raw.pool } : {}),
  };
  throw new Error(
    "mesh config puts credentials in the endpoint URL (https://namespace:token@host), which is no longer supported — " +
    "one URL carrying several settings was too easy to get wrong. Move them to their own fields:\n" +
    `  ${JSON.stringify(migrated, null, 2).replace(/\n/g, "\n  ")}\n` +
    'The token field also accepts "$MESH_TOKEN" (an environment variable) or "!pass show mesh-token" (a command), ' +
    "so it never has to be written into this file at all.",
  );
}

/** Read + parse the mesh config file; throws when missing or malformed. */
export function loadMeshConfig(configPath: string): MeshConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`mesh not configured — create ${configPath} ({ endpoint, namespace?, token?, pool? })`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`mesh config is not valid JSON: ${configPath} — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMeshConfig(raw);
}

/** A value pi would treat as a shell command: it starts with "!". */
export function isCommandValue(value: string): boolean {
  return value.startsWith("!");
}

/** Does this value reference an environment variable? */
export function hasEnvInterpolation(value: string): boolean {
  return parseTemplate(value).some((part) => part.type === "env");
}

/**
 * Would this value change when read as a template?
 *
 * True for an env reference *and* for an escape: pi turns `$$` into `$` and `$!`
 * into `!` even when nothing is interpolated, so `"$$literal"` means `"$literal"`.
 * Keeping such a value in the literal slot would quietly hand the engine a
 * different string than `models.json` semantics promise.
 */
function isTemplateValue(value: string): boolean {
  return parseTemplate(value).some((part) => part.type === "env")
    || value.includes("$$")
    || value.includes("$!");
}

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Split a value into literals and env references.
 *
 * Copied from pi's `resolve-config-value.ts` on purpose: a mesh token should
 * read exactly like an `apiKey` in `models.json`, escapes included, and two
 * subtly different `$VAR` dialects in one product would be a trap. `$$` and `$!`
 * produce literal `$` and `!`; an unterminated `${` is literal text.
 */
export function parseTemplate(value: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  const appendLiteral = (text: string): void => {
    if (!text) return;
    const previous = parts[parts.length - 1];
    if (previous?.type === "literal") {
      previous.value += text;
      return;
    }
    parts.push({ type: "literal", value: text });
  };
  while (index < value.length) {
    const dollarIndex = value.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(value.slice(index));
      break;
    }
    appendLiteral(value.slice(index, dollarIndex));
    const nextChar = value[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = value.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral("$");
        index = dollarIndex + 1;
        continue;
      }
      const name = value.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else appendLiteral(value.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }
    const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral("$");
    index = dollarIndex + 1;
  }
  return parts;
}

/** The env var names a value depends on, in order, without duplicates. */
export function templateEnvNames(value: string): string[] {
  const names: string[] = [];
  for (const part of parseTemplate(value)) {
    if (part.type === "env" && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/** How long a token command may run before it is killed, in ms. Mirrors pi's budget. */
export const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

/** First `$NAME` or `${NAME}` an expansion needs but the environment lacks. */
export function missingEnvName(value: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const name of templateEnvNames(value)) {
    if (env[name] === undefined) return name;
  }
  return null;
}

function expandTemplate(value: string, env: Record<string, string | undefined>): string {
  return parseTemplate(value)
    .map((part) => (part.type === "literal" ? part.value : env[part.name] ?? ""))
    .join("");
}

/**
 * Run one `!command` and return its stdout, trimmed.
 *
 * Executed through a shell, exactly as pi runs `!command` in `models.json` — the
 * point of matching pi is that users write one dialect everywhere. That means a
 * `mesh.config.json` can run arbitrary shell, with the user's own permissions:
 * its write permission is code-execution permission. Documented in
 * `docs/guides/mesh-setup.md`.
 *
 * **cwd is the caller's cwd, and it is stated in every error.** Like a shell
 * line typed by hand, the command inherits the process's working directory — so
 * a relative path inside it (`./get-token.sh`) means "relative to wherever pi
 * happens to be running", which is the repo you opened, not the one your config
 * lives in. Two repositories, two answers from one config. That is not fixable by
 * choosing a directory for the user (there is no honest candidate: the config
 * file is not code, and pi does not run `models.json` commands from the config's
 * directory either); it is fixable by *saying so*, which every failure below does.
 *
 * Asynchronous (`spawn`, never `execSync`) because this runs on the extension's
 * thread: pi may afford a blocking call in its own config path, but a mesh
 * operation must not freeze the TUI while a secret manager unlocks.
 */
export async function runTokenCommand(
  command: string,
  timeoutMs = TOKEN_COMMAND_TIMEOUT_MS,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const shell = process.env.SHELL || "/bin/sh";
  // `where` is quoted into every message: without it, "not found" and "empty"
  // read as a broken config when the real answer is "you are in another repo".
  const where = `cwd ${jsonish(cwd)}, shell ${shell}`;
  const child = spawn(shell, ["-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
    cwd,
    shell: false,
  });

  const collect = (async (): Promise<string> => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        reject(new Error(`mesh token command "!${command}" could not be started (${where}) — ${err.message}`));
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const said = stderr.trim();
    if (outcome.code !== 0) {
      const reason = outcome.signal ? `killed by ${outcome.signal}` : `exit code ${outcome.code}`;
      throw new Error(
        `mesh token command "!${command}" produced no token (${reason}; ${where})${said ? ` — ${said}` : ""}` +
          (looksLikePathFailure(said) ? ` — a relative path inside the command resolves against the cwd above; use an absolute path or $HOME` : ""),
      );
    }
    const token = stdout.trim();
    if (!token) {
      throw new Error(
        `mesh token command "!${command}" produced an empty token (${where})` +
          (said ? ` — it wrote to stderr: ${said}` : "") +
          ` — check it prints the token on stdout and resolves any relative path against the cwd above`,
      );
    }
    return token;
  })();

  try {
    return await withTimeout(collect, timeoutMs);
  } catch (err) {
    child.kill("SIGKILL");
    if (err instanceof Error && err.message.startsWith("timed out after")) {
      throw new Error(`mesh token command "!${command}" did not finish within ${timeoutMs} ms (${where})`);
    }
    throw err;
  }
}

/** Quote a path for a one-line error, so an empty or space-riddled cwd is visible rather than implied. */
function jsonish(value: string): string {
  return JSON.stringify(value);
}

/**
 * Does the shell's own message read like a path that was not found? Covers the
 * usual English/GNU and macOS/zsh shapes plus the localized Chinese one this was
 * first reported with; anything else still gets the cwd in the message, just
 * without the extra hint.
 */
function looksLikePathFailure(stderr: string): boolean {
  if (stderr === "") return false;
  return /no such file or directory|not found|command not found|没有那个文件或目录|无法找到|not found in/i.test(stderr);
}

/**
 * Resolve a config's values that were authored as something other than literals.
 *
 * This is the async half of the split: {@link loadMeshConfig} stays synchronous
 * and only records shape, so no read path — `mesh list`, a status line, the
 * admin console — can be made to spawn a process or read a secret just by being
 * pointed at a config file. Anything that actually talks to the engine resolves
 * first.
 *
 * Following pi, a command runs **per resolution and is never cached**: a rotated
 * or expiring secret is picked up on the next mesh operation rather than being
 * frozen into the process for its lifetime.
 *
 * A config authored entirely as literals comes back unchanged (same object), so
 * the plain path costs nothing.
 */
export async function resolveMeshConfig(
  config: MeshConfig,
  options: { timeoutMs?: number; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<MeshConfig> {
  if (!config.tokenExpression && !config.namespaceExpression) return config;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TOKEN_COMMAND_TIMEOUT_MS;
  const { tokenExpression, namespaceExpression, ...rest } = config;
  const resolved: MeshConfig = { ...rest };

  if (tokenExpression !== undefined) {
    if (isCommandValue(tokenExpression)) {
      const command = tokenExpression.slice(1);
      const cwd = options.cwd ?? process.cwd();
      try {
        resolved.token = await runTokenCommand(command, timeoutMs, env, cwd);
      } catch (err) {
        // Wrapped once, here, so every caller (the CLI, the daemon, doctor, a send)
        // carries the same facts: which config field failed, the command as written
        // and where it ran. A silent fallback here is what made this bug invisible.
        throw new Error(`mesh config "token": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const missing = missingEnvName(tokenExpression, env);
      if (missing) {
        throw new Error(
          `mesh config "token" reads $${missing}, which is not set. Export it in the environment that runs pi, ` +
          `or point the field at a command instead: "!pass show mesh-token"`,
        );
      }
      resolved.token = expandTemplate(tokenExpression, env);
    }
  }

  if (namespaceExpression !== undefined) {
    const missing = missingEnvName(namespaceExpression, env);
    if (missing) {
      throw new Error(`mesh config "namespace" reads $${missing}, which is not set`);
    }
    resolved.namespace = expandTemplate(namespaceExpression, env);
  }

  return resolved;
}

/**
 * Serialize an actor key the way the engine does (`/`-joined with escaping) so
 * REST list results can be matched against an expected key. Mirrors rivetkit's
 * serializeActorKey for the shapes mesh keys use (non-empty string parts).
 */
export function serializeMeshKey(key: string[]): string {
  if (key.length === 0) return "/";
  return key
    .map((part) =>
      part === "" ? "\\0" : part.replace(/\\/g, "\\\\").replace(/\//g, "\\/"),
    )
    .join("/");
}

export function deserializeMeshKey(serialized: string | undefined): string[] {
  if (serialized === undefined || serialized === null || serialized === "/" || serialized === "") return [];
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of serialized) {
    if (escaped) {
      current += ch === "0" ? "" : ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "/") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}
