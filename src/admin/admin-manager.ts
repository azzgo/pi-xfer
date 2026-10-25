/**
 * admin-manager.ts — extension-side lifecycle for the xfer admin daemon
 * (milestone1 P0-1, mirrors broker-manager.ts).
 *
 * The admin daemon outlives pi sessions exactly like the broker: spawned
 * detached + unref'd, stopped only by an explicit user action
 * (`/xfer admin stop` or the CLI). Session teardown never touches it.
 *
 * Lifecycle (same shape as BrokerManager):
 *   start()  — probe first (admin.json exists AND pid live AND TCP connect
 *              succeeds) → "already running"; otherwise spawn the admin.cjs
 *              bundle detached with stdout/stderr → <xfer-dir>/admin.log and
 *              poll admin.json + TCP until ready.
 *   stop()   — SIGTERM the process group → poll ≤2s → SIGKILL → unlink
 *              admin.pid/admin.json.
 *   probe()  — the liveness check, returning AdminInfo | null.
 *
 * The daemon runs from the committed admin.cjs bundle (P0-B): no experimental
 * type stripping, no node_modules needed next to the caller's project.
 * `daemonPath` still overrides the entry (tests point it at a stub).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { XFER_DIR } from "../core/constants.ts";
import { isEntryPoint } from "../core/utils.ts";

/** Default admin TCP port (mirrors admin-main.ts DEFAULT_ADMIN_PORT). */
export const DEFAULT_ADMIN_PORT = 7788;

const PROBE_INTERVAL_MS = 50;
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const STOP_TERM_GRACE_MS = 2_000;
const STOP_KILL_GRACE_MS = 1_000;
const LOG_TAIL_LINES = 20;

/** What admin.json carries while the daemon is (or was) running. */
export interface AdminInfo {
  port: number;
  pid: number;
  startedAt: string;
  version: string;
}

export interface AdminManagerOptions {
  /** TCP port for the daemon (0 = ephemeral, the real port lands in admin.json); default 7788. */
  port?: number;
  /** Directory holding admin.pid / admin.json / admin.log; default XFER_DIR. */
  xferDir?: string;
  /** Board directory rendered by the admin pages; default <xferDir>/board. */
  boardDir?: string;
  /** Readiness probe deadline after spawning; default 5000ms. */
  readinessTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace in stop(); default 2000ms. */
  stopTermGraceMs?: number;
  /** Daemon entry to spawn; defaults to the bundled admin-main.ts (tests point this at a stub). */
  daemonPath?: string;
}

/**
 * Lifecycle for the xfer admin daemon. Stateless like BrokerManager: start()/
 * stop() ground themselves in <xfer-dir>/admin.{pid,json} + a TCP probe.
 */
export class AdminManager {
  private readonly port: number;
  private readonly xferDir: string;
  private readonly boardDir: string;
  private readonly readinessTimeoutMs: number;
  private readonly stopTermGraceMs: number;
  private readonly daemonPath: string;

  constructor(options: AdminManagerOptions = {}) {
    this.port = options.port ?? DEFAULT_ADMIN_PORT;
    this.xferDir = options.xferDir ?? XFER_DIR;
    this.boardDir = options.boardDir ?? path.join(this.xferDir, "board");
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.stopTermGraceMs = options.stopTermGraceMs ?? STOP_TERM_GRACE_MS;
    this.daemonPath = options.daemonPath ?? ADMIN_MAIN;
  }

  /**
   * Alive only when admin.json exists AND its recorded pid is live AND a TCP
   * connect to its port succeeds. Exposed for tests.
   */
  async probe(): Promise<AdminInfo | null> {
    const info = readAdminJson(this.xferDir);
    if (info === null) return null;
    if (!pidAlive(info.pid)) return null;
    return (await tcpProbe(info.port)) ? info : null;
  }

  /**
   * Start the admin daemon. "already running" when a live daemon is up (no
   * spawn); otherwise spawns detached and waits for readiness. Rejects on
   * spawn failure or readiness timeout, surfacing the admin.log tail.
   */
  async start(portOverride?: number): Promise<string> {
    const port = portOverride ?? this.port;
    if ((await this.probe()) !== null) return "already running";
    if (!fs.existsSync(this.daemonPath)) {
      throw new Error(
        `admin: daemon bundle missing (${this.daemonPath}) — run \`npm run build\` in the xfer extension directory`,
      );
    }

    fs.mkdirSync(this.xferDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(this.xferDir, "admin.log");
    const logFd = fs.openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        this.daemonPath,
        "--port",
        String(port),
        "--xfer-dir",
        this.xferDir,
        "--board-dir",
        this.boardDir,
      ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      throw new Error(`admin: spawn failed: ${errorMessage(error)}`);
    }
    child.unref();
    child.once("spawn", () => {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    });

    const spawnError = await confirmSpawn(child);
    if (spawnError) {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      throw new Error(`admin: spawn failed: ${spawnError.message}`);
    }

    const info = await this.waitReady(child);
    if (info === null) {
      throw new Error(`admin: not ready within ${this.readinessTimeoutMs}ms\n${this.logTail()}`);
    }
    if (port !== 0 && info.port !== port) {
      return `admin started (pid ${info.pid}, port ${info.port} — port ${port} was occupied by another program, fell back to an ephemeral port)`;
    }
    return `admin started (pid ${info.pid}, port ${info.port})`;
  }

  /**
   * Stop ladder: admin.pid → SIGTERM group → poll → SIGKILL → unlink
   * admin.pid/admin.json. Graceful no-op ("admin not running") without a live
   * daemon.
   */
  async stop(): Promise<string> {
    const pid = readPidFile(this.xferDir);
    if (pid === null) return "admin not running";
    if (!pidAlive(pid)) {
      unlinkAdminFiles(this.xferDir);
      return "admin not running";
    }

    signalGroup(pid, "SIGTERM");
    const termDeadline = Date.now() + this.stopTermGraceMs;
    while (pidAlive(pid) && Date.now() < termDeadline) await sleep(PROBE_INTERVAL_MS);
    if (pidAlive(pid)) {
      signalGroup(pid, "SIGKILL");
      const killDeadline = Date.now() + STOP_KILL_GRACE_MS;
      while (pidAlive(pid) && Date.now() < killDeadline) await sleep(PROBE_INTERVAL_MS);
    }
    unlinkAdminFiles(this.xferDir);
    return `admin stopped (pid ${pid})`;
  }

  private async waitReady(child: ChildProcess): Promise<AdminInfo | null> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (;;) {
      const info = await this.probe();
      if (info !== null) return info;
      if (child.exitCode !== null || child.signalCode !== null) return null;
      if (Date.now() > deadline) return null;
      await sleep(PROBE_INTERVAL_MS);
    }
  }

  private logTail(): string {
    try {
      const lines = fs
        .readFileSync(path.join(this.xferDir, "admin.log"), "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      return `last admin.log lines (${path.join(this.xferDir, "admin.log")}):\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
    } catch {
      return `admin.log unavailable at ${path.join(this.xferDir, "admin.log")}`;
    }
  }
}

// ---------- helpers (mirrors broker-manager.ts) ----------

/** The committed daemon bundle (built from admin-main.ts by `npm run build`). */
const ADMIN_MAIN = path.join(import.meta.dirname, "../../dist/admin.cjs");

function readAdminJson(xferDir: string): AdminInfo | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(xferDir, "admin.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    const port = typeof data.port === "number" ? data.port : NaN;
    const pid = typeof data.pid === "number" ? data.pid : NaN;
    if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(pid) || pid <= 0) return null;
    return {
      port,
      pid,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
      version: typeof data.version === "string" ? data.version : "",
    };
  } catch {
    return null;
  }
}

function readPidFile(xferDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(xferDir, "admin.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function unlinkAdminFiles(xferDir: string): void {
  for (const name of ["admin.pid", "admin.json"]) {
    try {
      fs.unlinkSync(path.join(xferDir, name));
    } catch {
      /* already gone */
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tcpProbe(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function confirmSpawn(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    let confirmed = false;
    child.once("spawn", () => {
      confirmed = true;
      resolve(null);
    });
    child.once("error", (error: Error) => {
      if (confirmed) return;
      resolve(error);
    });
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* process group already gone */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------- CLI ----------

/** Run only when executed directly (not when imported by tests). */
function isMainModule(): boolean {
  return isEntryPoint(["admin-manager.ts"]);
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  let port = DEFAULT_ADMIN_PORT;
  let xferDir = XFER_DIR;
  let boardDir = path.join(xferDir, "board");
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port") {
      port = Number.parseInt(args[++i] ?? "", 10);
    } else if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
    } else if (arg === "--xfer-dir") {
      xferDir = args[++i] ?? XFER_DIR;
    } else if (arg.startsWith("--xfer-dir=")) {
      xferDir = arg.slice("--xfer-dir=".length);
    } else if (arg === "--board-dir") {
      boardDir = args[++i] ?? "";
    } else if (arg.startsWith("--board-dir=")) {
      boardDir = arg.slice("--board-dir=".length);
    } else {
      positional.push(arg);
    }
  }

  const manager = new AdminManager({ port, xferDir, boardDir });
  const subcommand = positional[0];
  let text: string;
  switch (subcommand) {
    case "start":
      text = await manager.start();
      break;
    case "stop":
      text = await manager.stop();
      break;
    default:
      console.error("usage: node admin-manager.ts <start|stop> [--port N] [--xfer-dir DIR] [--board-dir DIR]");
      process.exit(1);
  }
  process.stdout.write(`${text}\n`);
}

if (isMainModule()) {
  runCli().catch((error) => {
    console.error(`admin-manager: ${errorMessage(error)}`);
    process.exit(1);
  });
}
