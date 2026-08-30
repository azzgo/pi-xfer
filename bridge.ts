import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { BridgeListener, XferController } from "./controller.js";
import { interpolate, type InterpolationVars } from "./settings.js";

/** Result of a successful `setup`: the bridge command pid + the TCP port xfer listens on. */
export interface BridgeSetupInfo {
  pid: number;
  port: number;
}

/**
 * Minimal notify surface the bridge needs. Structural on purpose (tests pass a stub);
 * the real `ctx.ui.notify` matches this shape, and this module stays UI-agnostic.
 */
export interface BridgeContext {
  notify(message: string, level?: "info" | "error" | "warning"): void;
}

/** Options for `BridgeManager`. */
export interface BridgeManagerOptions {
  /** Owns the TCP listener the bridge command tunnels to (see `XferController`). */
  controller: XferController;
  /** How long early bridge output is echoed for humans; injectable for tests. */
  echoWindowMs?: number;
}

/** Default echo window for the bridge command's early output. */
const DEFAULT_ECHO_WINDOW_MS = 3_000;
/** Ring buffer capacity: tagged lines kept from bridge stdout+stderr combined. */
const RING_CAPACITY = 200;
/** Early-output echo stops after this many lines, even inside the window. */
const ECHO_MAX_LINES = 20;
/** Grace between SIGTERM and SIGKILL when stopping the bridge command group. */
const STOP_TERM_GRACE_MS = 2_000;
/** Cap on waiting for exit after SIGKILL (defensive; SIGKILL is immediate). */
const STOP_KILL_GRACE_MS = 2_000;
/** Display prefix for echoed bridge output lines. */
const ECHO_PREFIX = "🌉 bridge: ";

/**
 * Lifecycle for the `/xfer listener` bridge transport: bind a TCP listener via the
 * controller, spawn the settings-provided bridge command (`sh -c`, e.g. an `ssh -R`
 * tunnel) with `%p` interpolated to that port, and tear both down again.
 *
 * Bridge stdout/stderr are captured for humans only — a bounded ring buffer for
 * `/xfer listener logs` plus a one-shot early-output echo window — and never parsed
 * or routed into the agent message stream. Stop is a ladder: SIGTERM the process
 * group, 2s grace, SIGKILL the group, wait for exit; the TCP listener always closes
 * afterwards. `stop` is idempotent; `setup` on a running bridge stops it first.
 */
export class BridgeManager {
  private readonly controller: XferController;
  private readonly echoWindowMs: number;

  private running = false;
  private child: ChildProcess | null = null;
  private childPid: number | undefined;
  private bridgePort: number | undefined;
  private ring: string[] = [];
  private spawnFailed = false;
  private stopping = false;
  private echoClosed = true;
  private echoLines = 0;
  private echoStartedAt = 0;
  private echoTimer: NodeJS.Timeout | null = null;

  constructor(options: BridgeManagerOptions) {
    this.controller = options.controller;
    this.echoWindowMs = options.echoWindowMs ?? DEFAULT_ECHO_WINDOW_MS;
  }

  /** True from a successful `setup` until `stop`. */
  isUp(): boolean {
    return this.running;
  }

  /** TCP port of the bridge listener, while up. */
  port(): number | undefined {
    return this.bridgePort;
  }

  /** pid of the bridge command, while up. */
  pid(): number | undefined {
    return this.childPid;
  }

  /**
   * Start the bridge: bind the TCP listener, interpolate `%p` to its port in `tpl`,
   * spawn the command detached (own process group, killable as `-pid`). Resolves with
   * pid + port; throws (after an error notify and listener cleanup) on an empty
   * template, listener failure, interpolation failure or spawn failure.
   */
  async setup(ctx: BridgeContext, tpl: string, vars?: InterpolationVars): Promise<BridgeSetupInfo> {
    if (tpl.trim() === "") {
      const message = "🌉 Bridge setup failed: listen.bridge template is empty";
      ctx.notify(message, "error");
      throw new Error("xfer: bridge template is empty");
    }
    if (this.running) await this.teardown();

    let listener: BridgeListener;
    let cmd: string;
    try {
      listener = await this.controller.startBridgeListener();
      cmd = interpolate(tpl, { ...vars, p: String(listener.port) });
    } catch (error) {
      ctx.notify(`🌉 Bridge setup failed: ${errorMessage(error)}`, "error");
      await this.controller.stopBridgeListener();
      throw error;
    }

    const child = spawn("sh", ["-c", cmd], {
      // detached so the whole process group dies with `kill(-pid)`; stdin is not ours.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.childPid = child.pid;
    this.bridgePort = listener.port;
    this.ring = [];
    this.spawnFailed = false;
    this.stopping = false;

    if (child.stdout) this.watchStream(child.stdout, "out", ctx);
    if (child.stderr) this.watchStream(child.stderr, "err", ctx);
    child.once("exit", (code, signal) => {
      // Our own stop ladder already reports; a failed spawn never got a process.
      if (this.spawnFailed || this.stopping) return;
      const why = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      ctx.notify(`🌉 bridge command exited (${why})`, "info");
    });

    const spawnError = await confirmSpawn(child);
    if (spawnError) {
      this.spawnFailed = true;
      const error = spawnError;
      ctx.notify(`🌉 Bridge setup failed: ${errorMessage(error)}`, "error");
      this.child = null;
      this.childPid = undefined;
      this.bridgePort = undefined;
      await this.controller.stopBridgeListener();
      throw error;
    }
    const pid = this.childPid;
    if (pid === undefined) {
      const error = new Error("xfer: bridge command has no pid after spawn");
      ctx.notify(`🌉 Bridge setup failed: ${error.message}`, "error");
      this.child = null;
      this.childPid = undefined;
      this.bridgePort = undefined;
      await this.controller.stopBridgeListener();
      throw error;
    }

    this.startEchoWindow();
    this.running = true;
    ctx.notify(`🌉 Bridge up — pid ${pid}, port ${listener.port}`, "info");
    return { pid, port: listener.port };
  }

  /**
   * Stop the bridge: SIGTERM the command's process group, escalate to SIGKILL after a
   * grace period, always close the TCP listener afterwards. No-op when not up.
   */
  async stop(_ctx: BridgeContext): Promise<void> {
    if (!this.running) return;
    await this.teardown();
  }

  /** Dump the captured bridge output (newest last) for the user; display-only. */
  logs(ctx: BridgeContext): void {
    if (!this.running) {
      ctx.notify("🌉 bridge not running", "warning");
      return;
    }
    if (this.ring.length === 0) {
      ctx.notify("🌉 bridge log: no output yet", "info");
      return;
    }
    ctx.notify(`🌉 bridge log (last ${this.ring.length} lines):\n${this.ring.join("\n")}`, "info");
  }

  /** Kill the command group, then unconditionally release the listener and state. */
  private async teardown(): Promise<void> {
    this.running = false;
    this.closeEchoWindow();
    const child = this.child;
    const pid = this.childPid;
    this.child = null;
    this.childPid = undefined;
    this.bridgePort = undefined;
    this.ring = [];
    this.stopping = true;
    try {
      if (child && pid !== undefined && !this.spawnFailed && isAlive(child)) {
        await killGroup(child, pid);
      }
    } finally {
      this.stopping = false;
      await this.controller.stopBridgeListener();
    }
  }

  /** Tag + ring one output line, and echo it while the one-shot window is open. */
  private onLine(tag: string, line: string, ctx: BridgeContext): void {
    const tagged = `[${tag}] ${line}`;
    this.ring.push(tagged);
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
    if (this.echoClosed) return;
    ctx.notify(`${ECHO_PREFIX}${tagged}`, "info");
    this.echoLines += 1;
    if (this.echoLines >= ECHO_MAX_LINES || Date.now() - this.echoStartedAt >= this.echoWindowMs) {
      this.closeEchoWindow();
    }
  }

  /** Split a child stdio stream into lines and feed `onLine`; flush the tail on close. */
  private watchStream(stream: Readable, tag: string, ctx: BridgeContext): void {
    let partial = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      partial += chunk;
      let nl = partial.indexOf("\n");
      while (nl >= 0) {
        this.onLine(tag, partial.slice(0, nl), ctx);
        partial = partial.slice(nl + 1);
        nl = partial.indexOf("\n");
      }
    });
    stream.once("close", () => {
      if (partial !== "") this.onLine(tag, partial, ctx);
    });
  }

  /** Open the one-shot early-output echo window (time- and line-bounded). */
  private startEchoWindow(): void {
    this.echoClosed = false;
    this.echoLines = 0;
    this.echoStartedAt = Date.now();
    if (this.echoTimer) clearTimeout(this.echoTimer);
    const timer = setTimeout(() => this.closeEchoWindow(), this.echoWindowMs);
    timer.unref?.();
    this.echoTimer = timer;
  }

  /** Latch the echo window shut: later output still rings, but never echoes again. */
  private closeEchoWindow(): void {
    this.echoClosed = true;
    if (this.echoTimer) {
      clearTimeout(this.echoTimer);
      this.echoTimer = null;
    }
  }
}

/**
 * Resolve `null` once the child has actually spawned, or with the spawn error.
 * The `spawn` event fires on the next tick after a successful spawn, so the race
 * settles immediately in either direction; a post-spawn `error` is ignored.
 */
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

/** A child counts as alive until its exit code/signal has been recorded. */
function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Signal a whole process group; ESRCH just means it is already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* process group already gone */
  }
}

/** SIGTERM the group, escalate to SIGKILL after the grace, and wait for the exit. */
async function killGroup(child: ChildProcess, pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  if (await exitedWithin(child, STOP_TERM_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await exitedWithin(child, STOP_KILL_GRACE_MS);
}

/** Resolve true when `child` fires `exit` within `ms`; false on timeout. */
function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    timer.unref?.();
    child.once("exit", () => finish(true));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
