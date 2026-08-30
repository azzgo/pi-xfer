import * as fs from "node:fs";
import * as path from "node:path";
import { XFER_DIR } from "./constants.js";
import type { PeerSendConfig, Settings } from "./types.js";

/** Discriminated result of `validateSettings`. */
export type SettingsValidationResult =
  | { valid: true; settings: Settings }
  | { valid: false; errors: string[] };

/** Default settings file location: `~/.pi/xfer/settings.json`. */
export const DEFAULT_SETTINGS_PATH = path.join(XFER_DIR, "settings.json");

/**
 * Read + validate the settings file at `settingsPath` (default `~/.pi/xfer/settings.json`).
 * Missing file → `{}`. Malformed JSON → throws with the path plus line/column when the
 * parse error reports an offset. Shape-invalid JSON → throws with the aggregated errors.
 */
export function loadSettings(settingsPath: string = DEFAULT_SETTINGS_PATH): Settings {
  let text: string;
  try {
    text = fs.readFileSync(settingsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(malformedMessage(settingsPath, text, err));
  }

  const result = validateSettings(raw);
  if (!result.valid) {
    const details = result.errors.map((e) => `- ${e}`).join("\n");
    throw new Error(`Invalid settings at ${settingsPath}:\n${details}`);
  }
  return result.settings;
}

/**
 * Hand-rolled structural validation of a parsed settings document; never throws on shape
 * issues. Unknown top-level keys are tolerated but dropped from the returned settings.
 */
export function validateSettings(raw: unknown): SettingsValidationResult {
  if (!isObject(raw)) return { valid: false, errors: ["settings: must be a JSON object"] };

  const errors: string[] = [];
  const settings: Settings = {};

  if (raw.listen !== undefined) {
    if (!isObject(raw.listen)) {
      errors.push("listen: must be an object");
    } else {
      const { bridge } = raw.listen;
      if (typeof bridge !== "string" || bridge === "") errors.push("listen.bridge: must be a non-empty string");
      else settings.listen = { bridge };
    }
  }

  if (raw.peers !== undefined) {
    if (!isObject(raw.peers)) {
      errors.push("peers: must be an object");
    } else {
      const peers: Record<string, PeerSendConfig> = {};
      for (const [name, entry] of Object.entries(raw.peers)) {
        const result = validatePeer(name, entry);
        errors.push(...result.errors);
        if (result.config) peers[name] = result.config;
      }
      if (errors.length === 0) settings.peers = peers;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, settings };
}

/** Values a command template may reference when interpolated by `interpolate`. */
export type InterpolationVars = { p?: string; n?: string; peer?: string; msgfile?: string };

/** `%token` name → the `InterpolationVars` field it reads. `%%` is handled inline and reads nothing. */
const TOKEN_VARS: ReadonlyMap<string, keyof InterpolationVars> = new Map([
  ["msgfile", "msgfile"],
  ["peer", "peer"],
  ["p", "p"],
  ["n", "n"],
]);

/**
 * Interpolate `%tokens` in an xfer command template (peer `send` commands, the bridge
 * listen command): `%p`, `%n`, `%peer` and `%msgfile` splice in the matching `vars`
 * value, `%%` is a literal `%` that never consults `vars`.
 *
 * Matching is maximal-munch, enforced strictly: the full run of `[A-Za-z0-9_]` after a
 * `%` must exactly name a known token, so `%peer` never degrades to `%p` and near-misses
 * (`%msg`, `%pfile`, `%P`) throw instead of silently interpolating a prefix. A lone `%`
 * with nothing token-like after it throws too, and a token whose var is `undefined`
 * throws so a half-substituted command can never be spawned.
 */
export function interpolate(tpl: string, vars: InterpolationVars): string {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    const ch = tpl.charAt(i);
    if (ch !== "%") {
      out += ch;
      i += 1;
      continue;
    }
    if (tpl.startsWith("%%", i)) {
      out += "%";
      i += 2;
      continue;
    }
    const name = /^[A-Za-z0-9_]+/.exec(tpl.slice(i + 1))?.[0];
    const varName = name === undefined ? undefined : TOKEN_VARS.get(name);
    if (name === undefined || varName === undefined) {
      throw new Error(`Unknown template token '%${name ?? tpl.charAt(i + 1)}' in template: ${tpl}`);
    }
    const value = vars[varName];
    if (value === undefined) {
      throw new Error(`Template references %${name} but vars.${varName} is undefined in template: ${tpl}`);
    }
    out += value;
    i += 1 + name.length;
  }
  return out;
}

/** Validate one `peers.<name>` entry, collecting every problem instead of failing fast. */
function validatePeer(name: string, entry: unknown): { errors: string[]; config?: PeerSendConfig } {
  const label = `peers.${name}`;
  if (!isObject(entry)) return { errors: [`${label}: must be an object`] };

  const errors: string[] = [];
  const send = entry.send;
  if (typeof send !== "string" || send === "") errors.push(`${label}.send: must be a non-empty string`);

  let timeoutMs: number | undefined;
  if (entry.timeoutMs !== undefined) {
    const timeout = entry.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      errors.push(`${label}.timeoutMs: must be a finite positive number`);
    } else {
      timeoutMs = timeout;
    }
  }

  let note: string | undefined;
  if (entry.note !== undefined) {
    if (typeof entry.note !== "string") errors.push(`${label}.note: must be a string`);
    else note = entry.note;
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    config: {
      send,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  };
}

/** Error message for unparsable JSON, adding line/column when the parse error reports an offset. */
function malformedMessage(settingsPath: string, text: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  let location = "";
  const withLineColumn = /position \d+ \(line (\d+) column (\d+)\)/.exec(detail);
  if (withLineColumn) {
    location = ` (line ${withLineColumn[1]}, column ${withLineColumn[2]})`;
  } else {
    const atPosition = /position (\d+)/.exec(detail);
    if (atPosition) location = ` (${lineColumnAt(text, Number(atPosition[1]))})`;
  }
  return `Malformed JSON in ${settingsPath}${location}: ${detail}`;
}

/** Human line/column (1-based) for a character offset within `text`. */
function lineColumnAt(text: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const lines = text.slice(0, clamped).split("\n");
  const column = (lines[lines.length - 1] ?? "").length + 1;
  return `line ${lines.length}, column ${column}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
