/**
 * broker-manager.ts — extension-side lifecycle for the xfer broker daemon
 * (goal 014 task 025).
 *
 * ── Contract ──────────────────────────────────────────────────────────────
 * This manager is NEVER called from controller.ts session_shutdown. The broker
 * daemon outlives pi sessions: it is spawned detached + unref'd, keeps running
 * after the session that started it exits, and is only stopped by an explicit
 * user action (a future `/xfer broker` command surface or the CLI below).
 * Session teardown must not touch it.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Lifecycle:
 *   start()  — probe first: if a broker is already alive (broker.json exists
 *              AND a TCP connect to its port succeeds) return "already
 *              running" without spawning. Otherwise spawn broker-main.ts
 *              detached (`node broker-main.ts --port <port> --xfer-dir <dir>`)
 *              with stdout/stderr wired to <xfer-dir>/broker.log (append mode;
 *              the manager opens the fd, the daemon just writes), unref() the
 *              child, and poll broker.json + TCP connect until ready (the
 *              confirmSpawn precedent from bridge.ts / broker.test.ts); on
 *              timeout, surface the last broker.log lines and fail.
 *   stop()   — read broker.pid, SIGTERM the process group (the detached spawn
 *              makes the daemon a group leader), poll for exit ≤2s, then
 *              SIGKILL the group; finally unlink broker.pid/broker.json if
 *              still present.
 *   status() — read broker.json + TCP probe its port; print port/pid/
 *              startedAt/version + alive|dead. NEVER exits non-zero
 *              (chrome-devtools convention: read the output, not the code).
 *
 * The daemon resolves its `./x.js` imports through the same --import resolve
 * hook as `npm test` (read from package.json, exactly like broker.test.ts), so
 * a spawned daemon and the suite can never drift.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive } from "./broker-main.js";
import { XFER_DIR } from "./constants.js";

/** Default broker TCP port (mirrors broker-main.ts DEFAULT_PORT). */
export const DEFAULT_BROKER_PORT = 4719;
/** Poll cadence for the readiness probe and the stop exit poll. */
const PROBE_INTERVAL_MS = 50;
/** Default deadline for the readiness probe after spawning. */
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
/** Grace between SIGTERM and SIGKILL in the stop ladder. */
const STOP_TERM_GRACE_MS = 2_000;
/** Defensive extra wait for the group to vanish after SIGKILL. */
const STOP_KILL_GRACE_MS = 1_000;
/** broker.log lines surfaced on a readiness timeout. */
const LOG_TAIL_LINES = 20;

/** What broker.json carries while the daemon is (or was) running. */
export interface BrokerInfo {
  port: number;
  pid: number;
  startedAt: string;
  version: string;
}

export interface BrokerManagerOptions {
  /** TCP port for the daemon (0 = ephemeral, the real port lands in broker.json); default 4719. */
  port?: number;
  /** Directory holding broker.pid / broker.json / broker.log; default XFER_DIR. */
  xferDir?: string;
  /** Readiness probe deadline after spawning; default 5000ms. */
  readinessTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace in stop(); default 2000ms. */
  stopTermGraceMs?: number;
}

/**
 * Lifecycle for the xfer broker daemon. Stateless on purpose: start()/stop()/
 * status() always ground themselves in <xfer-dir>/broker.{pid,json} + a TCP
 * probe, so they work identically from the process that spawned the daemon,
 * from a later CLI invocation, or from a different pi session.
 */
export class BrokerManager {
  private readonly port: number;
  private readonly xferDir: string;
  private readonly readinessTimeoutMs: number;
  private readonly stopTermGraceMs: number;

  constructor(options: BrokerManagerOptions = {}) {
    this.port = options.port ?? DEFAULT_BROKER_PORT;
    this.xferDir = options.xferDir ?? XFER_DIR;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.stopTermGraceMs = options.stopTermGraceMs ?? STOP_TERM_GRACE_MS;
  }

  /**
   * The status probe: alive only when broker.json exists AND a TCP connect to
   * its port succeeds. Used by start() to detect an already-running broker,
   * by start()'s readiness poll, and exposed for status()/tests.
   */
  async probe(): Promise<BrokerInfo | null> {
    const info = readBrokerJson(this.xferDir);
    if (info === null) return null;
    return (await tcpProbe(info.port)) ? info : null;
  }

  /**
   * Start the broker daemon. Returns "already running" when a live broker is
   * already up (no spawn); otherwise spawns detached, waits for readiness
   * (broker.json + TCP), and resolves with a one-line summary. Rejects on
   * spawn failure or readiness timeout, surfacing the broker.log tail.
   */
  async start(): Promise<string> {
    if ((await this.probe()) !== null) return "already running";

    fs.mkdirSync(this.xferDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(this.xferDir, "broker.log");
    // The daemon just writes stdout/stderr; the manager sets up the fd.
    // Passed as an integer fd the child inherits the same open file
    // description, so the parent's copy is closed once the process exists.
    const logFd = fs.openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        "--import",
        RESOLVE_HOOK,
        BROKER_MAIN,
        "--port",
        String(this.port),
        "--xfer-dir",
        this.xferDir,
      ], {
        // detached → the daemon becomes its own process-group leader, so the
        // stop ladder can kill(-pid, SIGTERM) the whole group; unref so the
        // daemon outlives this process and never keeps it alive.
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      throw new Error(`broker: spawn failed: ${errorMessage(error)}`);
    }
    child.unref();
    // Close the parent's fd copy after the child exists (closing earlier
    // would race the fork); on spawn failure no process was created, so the
    // fd is closed on the error path below instead.
    child.once("spawn", () => {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    });

    const spawnError = await confirmSpawn(child);
    if (spawnError) {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      throw new Error(`broker: spawn failed: ${spawnError.message}`);
    }

    const info = await this.waitReady(child);
    if (info === null) {
      throw new Error(`broker: not ready within ${this.readinessTimeoutMs}ms\n${this.logTail()}`);
    }
    return `broker started (pid ${info.pid}, port ${info.port})`;
  }

  /**
   * Stop ladder: read broker.pid → SIGTERM the process group → poll for exit
   * ≤ stopTermGraceMs → SIGKILL the group → unlink broker.pid/broker.json if
   * still present. Graceful no-op ("broker not running") when there is no
   * broker.pid or its pid is already gone.
   */
  async stop(): Promise<string> {
    const pid = readPidFile(this.xferDir);
    if (pid === null) return "broker not running";
    if (!pidAlive(pid)) {
      // Stale pid file naming a dead process — nothing to signal, just clear it.
      unlinkBrokerFiles(this.xferDir);
      return "broker not running";
    }

    signalGroup(pid, "SIGTERM");
    const termDeadline = Date.now() + this.stopTermGraceMs;
    while (pidAlive(pid) && Date.now() < termDeadline) await sleep(PROBE_INTERVAL_MS);
    if (pidAlive(pid)) {
      signalGroup(pid, "SIGKILL");
      const killDeadline = Date.now() + STOP_KILL_GRACE_MS;
      while (pidAlive(pid) && Date.now() < killDeadline) await sleep(PROBE_INTERVAL_MS);
    }
    unlinkBrokerFiles(this.xferDir);
    return `broker stopped (pid ${pid})`;
  }

  /**
   * Read broker.json + TCP probe its port; one text block with port, pid,
   * startedAt, version and alive|dead. Never rejects — consumers read the
   * output, never the exit code.
   */
  async status(): Promise<string> {
    const info = readBrokerJson(this.xferDir);
    if (info === null) {
      return `broker: dead\n  xferDir: ${this.xferDir} (no broker.json)`;
    }
    const alive = await tcpProbe(info.port);
    if (!alive) {
      return [
        "broker: dead",
        `  port: ${info.port} (stale — no listener)`,
        `  pid: ${info.pid}`,
        `  startedAt: ${info.startedAt}`,
        `  version: ${info.version}`,
      ].join("\n");
    }
    return [
      "broker: alive",
      `  port: ${info.port}`,
      `  pid: ${info.pid}`,
      `  startedAt: ${info.startedAt}`,
      `  version: ${info.version}`,
    ].join("\n");
  }

  /** Poll broker.json + TCP connect until ready or the deadline (or child exit). */
  private async waitReady(child: ChildProcess): Promise<BrokerInfo | null> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (;;) {
      const info = await this.probe();
      if (info !== null) return info;
      if (child.exitCode !== null || child.signalCode !== null) return null;
      if (Date.now() > deadline) return null;
      await sleep(PROBE_INTERVAL_MS);
    }
  }

  /** The last LOG_TAIL_LINES non-empty lines of <xfer-dir>/broker.log. */
  private logTail(): string {
    try {
      const lines = fs
        .readFileSync(path.join(this.xferDir, "broker.log"), "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      return `last broker.log lines (${path.join(this.xferDir, "broker.log")}):\n${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
    } catch {
      return `broker.log unavailable at ${path.join(this.xferDir, "broker.log")}`;
    }
  }
}

// ---------- helpers ----------

/** The --import resolve hook from package.json's test script (see broker.test.ts). */
function resolveHook(): string {
  const pkg: { scripts?: { test?: string } } = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
  );
  const match = /--import\s+'([^']+)'/.exec(pkg.scripts?.test ?? "");
  if (!match) throw new Error("cannot find --import resolve hook in package.json test script");
  return match[1]!;
}

const RESOLVE_HOOK = resolveHook();
const BROKER_MAIN = path.join(import.meta.dirname, "broker-main.ts");

/** broker.json parsed + shape-checked, or null when missing/invalid. */
function readBrokerJson(xferDir: string): BrokerInfo | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(xferDir, "broker.json"), "utf-8")) as Record<
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
    const raw = fs.readFileSync(path.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function unlinkBrokerFiles(xferDir: string): void {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs.unlinkSync(path.join(xferDir, name));
    } catch {
      /* already gone */
    }
  }
}

/** Connect to 127.0.0.1:port and report success/failure; the socket is destroyed either way. */
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

/** Resolve null once the child has actually spawned, or with the spawn error (bridge.ts pattern). */
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

/** Signal a whole process group; ESRCH just means it is already gone. */
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
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  let port = DEFAULT_BROKER_PORT;
  let xferDir = XFER_DIR;
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
    } else {
      positional.push(arg);
    }
  }

  const manager = new BrokerManager({ port, xferDir });
  const subcommand = positional[0];
  let text: string;
  switch (subcommand) {
    case "start":
      text = await manager.start();
      break;
    case "stop":
      text = await manager.stop();
      break;
    case "status":
      // status() never rejects → the CLI always exits 0 (chrome-devtools
      // convention: read the output, not the exit code).
      text = await manager.status();
      break;
    default:
      console.error("usage: node broker-manager.ts <start|stop|status> [--port N] [--xfer-dir DIR]");
      process.exit(1);
  }
  process.stdout.write(`${text}\n`);
  // No explicit process.exit(): the daemon (if any) is unref'd and every
  // timer/socket has settled, so the process drains stdout and exits 0.
}

if (isMainModule()) {
  runCli().catch((error) => {
    console.error(`broker-manager: ${errorMessage(error)}`);
    process.exit(1);
  });
}
