import * as fs from "node:fs";
import * as path from "node:path";
import { XFER_DIR } from "./constants.ts";

/**
 * Durable record for the mesh transport: `<xfer-dir>/mesh.log`, append-only,
 * one logfmt line per record.
 *
 * The mesh runs quiet on purpose (see `quietMeshRuntime`), because RivetKit
 * prints for a standalone server and every line of it wrecks a TUI redraw. That
 * decision would also throw away the evidence for a problem on someone else's
 * machine, where it does not reproduce — so the suppressed *JS* layer is
 * redirected here instead of dropped: `setup({ logging: { baseLogger } })`
 * points RivetKit's own logger at this file, and the extension writes its mesh
 * lifecycle events next to it. One file, one timeline. How it is maintained:
 * `docs/dev/mesh-log.md`.
 *
 * Not in this file, and not fixable here: the native runtime's tracing output.
 * The Rust subscriber writes straight to the process's stdout at fd level and
 * never touches `process.stdout.write` (measured on 2.3.26), so no JS can
 * capture it — and no `RIVET_LOG_*` var selects a file. Those lines exist only
 * on a terminal of a host launched with an explicit `RIVET_LOG_LEVEL`.
 */

export type MeshLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Where the mesh log lives; overridable so tests never touch the real one. */
export const MESH_LOG_PATH = path.join(XFER_DIR, "mesh.log");

/**
 * File verbosity. A constant rather than an env knob: the file has to already
 * hold the detail when nobody knows yet that it will be needed, so there is
 * nothing useful to switch on after the fact — raising this is a source edit by
 * whoever wants the trace, and it applies to the next session.
 */
export const MESH_LOG_LEVEL: MeshLogLevel = "info";

const LEVEL_RANK: Record<MeshLogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** True when `level` clears {@link MESH_LOG_LEVEL}. */
export function shouldLog(level: MeshLogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[MESH_LOG_LEVEL];
}

function quote(value: string): string {
  if (value !== "" && !/[\s"=\\']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function formatValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  if (value instanceof Error) return quote(value.message);
  if (typeof value === "string") return quote(value);
  try {
    return quote(JSON.stringify(value) ?? String(value));
  } catch {
    return quote(String(value));
  }
}

function safeKey(key: string): string {
  return key.replace(/[\s="']/g, "");
}

/** One record: `ts level msg=… key=value …`, fields after the message. */
export function formatMeshLogLine(
  level: MeshLogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): string {
  const parts = [new Date().toISOString(), `level=${level}`];
  if (message !== "") parts.push(`msg=${formatValue(message)}`);
  for (const [key, value] of Object.entries(fields)) {
    const name = safeKey(key);
    if (name !== "") parts.push(`${name}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

/** Append a record. Never throws: logging a mesh problem must not cause one. */
export function appendMeshLogLine(logPath: string, line: string): void {
  try {
    fs.appendFileSync(logPath, `${line}\n`, { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* a full disk or a missing home must not take the mesh down with it */
  }
}

/**
 * Append one extension-side mesh event, gated by {@link MESH_LOG_LEVEL}.
 * Fields stay metadata-only — handoff documents never reach the log.
 */
export function logMeshEvent(
  logPath: string,
  level: MeshLogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (!shouldLog(level)) return;
  appendMeshLogLine(logPath, formatMeshLogLine(level, message, fields));
}

/** Pino-shaped logger handed to RivetKit through `logging.baseLogger`. */
export interface MeshLogSink {
  level: MeshLogLevel;
  child(bindings: Record<string, unknown>): MeshLogSink;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

function splitArgs(args: unknown[]): { fields: Record<string, unknown>; message: string } {
  const [first, second] = args;
  if (typeof first === "string") return { fields: {}, message: first };
  if (first !== null && typeof first === "object") {
    const message = typeof second === "string" ? second : "";
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
      if (key === "level" || key === "time" || key === "msg") continue;
      if (value !== undefined) fields[key] = value;
    }
    return { fields, message };
  }
  return { fields: {}, message: first === undefined ? "" : String(first) };
}

/**
 * Build the base logger RivetKit writes through. Duck-typed on purpose:
 * `logging.baseLogger` documents a Pino logger, and Pino is only a build-time
 * transitive of rivetkit (ADR 0013 keeps rivetkit, and therefore pino, out of
 * every dependency list) — importing it here would break a plain
 * `npm install && npm test`. RivetKit 2.3.26 uses six methods of that logger
 * plus `child`, which is the whole surface implemented here.
 */
export function createMeshLogSink(options: { path?: string } = {}): MeshLogSink {
  const logPath = options.path ?? MESH_LOG_PATH;

  const write = (level: MeshLogLevel, bindings: Record<string, unknown>, args: unknown[]): void => {
    if (!shouldLog(level)) return;
    try {
      const { fields, message } = splitArgs(args);
      appendMeshLogLine(logPath, formatMeshLogLine(level, message, { ...bindings, ...fields }));
    } catch {
      /* a malformed log call must not propagate into rivetkit */
    }
  };

  const make = (bindings: Record<string, unknown>): MeshLogSink => ({
    level: MESH_LOG_LEVEL,
    child: (childBindings) => make({ ...bindings, ...childBindings }),
    trace: (...args) => write("trace", bindings, args),
    debug: (...args) => write("debug", bindings, args),
    info: (...args) => write("info", bindings, args),
    warn: (...args) => write("warn", bindings, args),
    error: (...args) => write("error", bindings, args),
    fatal: (...args) => write("fatal", bindings, args),
  });
  return make({});
}
