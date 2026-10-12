/**
 * doctor.ts — `/xfer doctor`, the read-only install self-check (milestone1 P1-6).
 *
 * Every check reuses an existing status query: `listPeers` + `planGc` for the
 * socket dir (the same zombie judgement `/xfer gc` acts on), `BrokerManager.probe`
 * for the broker — which is also the web picker's only channel — `AdminManager.probe`
 * for the console, and `loadMeshConfig` + `listMeshNodes` for the mesh.
 *
 * Doctor starts, stops and writes nothing: a failing line only names the command
 * that clears it. The one cap it imposes is time — the mesh engine query is raced
 * against `MESH_PROBE_TIMEOUT_MS` so a half-reachable control plane degrades into
 * a "fail" line instead of hanging the command.
 *
 * Status semantics — `warn` is reserved for states that are genuinely off but
 * self-heal (`/xfer gc` for zombie sockets). An opt-in service that simply is not
 * running is a normal state, so it passes and still offers its start command;
 * `fail` is for the socket dir, a throwing probe, and a mesh that is configured
 * but whose config or engine is broken.
 */
import * as fs from "node:fs";
import type { AdminManager } from "./admin-manager.ts";
import type { BrokerManager } from "./broker-manager.ts";
import { MESH_PROBE_TIMEOUT_MS } from "./constants.ts";
import { planGc } from "./gc.ts";
import type { MeshConfig } from "./mesh-config.ts";
import { loadMeshConfig } from "./mesh-config.ts";
import { listMeshNodes, type MeshNodeInfo } from "./mesh-engine.ts";
import { decodeAgentName, displayPath, listPeers, withTimeout } from "./utils.ts";

/** pass = healthy (including "opt-in service not started"), warn = off but self-healing, fail = broken. */
export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** The command that starts or clears the check; rendered on its own indented line whenever set. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: number;
  warned: number;
  failed: number;
}

export interface DoctorDeps {
  /** Directory holding peer sockets + metadata; the same dir `/xfer gc` scans. */
  xferDir: string;
  /** This agent's xfer name, excluded from the peer listing. */
  myName: string;
  brokerManager: Pick<BrokerManager, "probe">;
  adminManager: Pick<AdminManager, "probe">;
  /** Mesh engine config; absence means the opt-in transport was never set up. */
  meshConfigPath: string;
  /** Engine node listing; overridden in tests, defaults to the REST listing. */
  listMeshNodes?: (config: MeshConfig) => Promise<MeshNodeInfo[]>;
  meshTimeoutMs?: number;
}

const MARK: Record<DoctorStatus, string> = { pass: "✓", warn: "!", fail: "✗" };

/** Run every check; never throws — a broken probe becomes a `fail` line. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const dirCheck = socketDirCheck(deps.xferDir);
  const checks = [
    dirCheck,
    dirCheck.status === "pass" ? await peersCheck(deps) : fail("Peers", `cannot list peers — fix "${dirCheck.name}" first`, dirCheck.fix),
    await brokerCheck(deps.brokerManager),
    await adminCheck(deps.adminManager),
    await meshCheck(deps),
  ];
  return {
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    warned: checks.filter((c) => c.status === "warn").length,
    failed: checks.filter((c) => c.status === "fail").length,
  };
}

/**
 * Render the report as one line per check plus a summary. A fix hint gets its own
 * indented line rather than a trailing `→ …`: a long peer list wraps in the terminal,
 * and a hint appended to it lands flush left like a stray error. Passing checks carry
 * hints too — "not running (opt-in)" is a pass that still tells you how to start it.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = ["🩺 /xfer doctor"];
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.fix) lines.push(`    → ${check.fix}`);
  }
  lines.push("", summaryLine(report));
  return lines.join("\n");
}

/**
 * Notification severity for the whole report: `warning` only when a `warn` or `fail`
 * survives, `info` otherwise. Doctor never reports `error` — it diagnoses, and the
 * repair is the user's to run, so a red block would misread as "the extension is
 * broken". Unstarted opt-in services pass, so a machine that runs none of them still
 * gets a clean, all-`info` report.
 */
export function doctorSeverity(report: DoctorReport): "info" | "warning" {
  return report.warned + report.failed > 0 ? "warning" : "info";
}

function summaryLine(report: DoctorReport): string {
  const parts = [`${report.passed} check${report.passed === 1 ? "" : "s"} passed`];
  if (report.warned > 0) parts.push(`${report.warned} warning${report.warned === 1 ? "" : "s"}`);
  if (report.failed > 0) parts.push(`${report.failed} failed`);
  return parts.join(", ");
}

function socketDirCheck(xferDir: string): DoctorCheck {
  const shown = displayPath(xferDir) ?? xferDir;
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(xferDir).isDirectory();
  } catch {
    return fail("Socket dir", `${shown} does not exist`, "restart pi — the session creates it at startup");
  }
  if (!isDirectory) {
    return fail("Socket dir", `${shown} is not a directory`, `move it away: mv ${xferDir} ${xferDir}.bak`);
  }
  try {
    fs.accessSync(xferDir, fs.constants.W_OK);
  } catch {
    return fail("Socket dir", `${shown} is not writable`, `restore owner access: chmod u+rwx ${xferDir}`);
  }
  return { name: "Socket dir", status: "pass", detail: `${shown} exists and is writable` };
}

async function peersCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const { zombies } = await planGc(deps.xferDir);
  const zombieNames = zombies.map((z) => decodeAgentName(z.name));
  const online = listPeers(deps.myName, deps.xferDir).filter((peer) => !zombieNames.includes(peer.xferName));
  const listed = online.length > 0 ? `${online.length} online: ${online.map((p) => p.xferName).join(", ")}` : "no peers online (only this session)";
  if (zombies.length > 0) {
    const names = zombieNames.join(", ");
    return { name: "Peers", status: "warn", detail: `${listed}; ${zombies.length} zombie socket(s): ${names}`, fix: "/xfer gc" };
  }
  return { name: "Peers", status: "pass", detail: listed };
}

async function brokerCheck(brokerManager: Pick<BrokerManager, "probe">): Promise<DoctorCheck> {
  try {
    const info = await brokerManager.probe();
    if (info === null) {
      return { name: "Broker", status: "pass", detail: "not running (opt-in) — the web picker needs it", fix: "/xfer broker start" };
    }
    return { name: "Broker", status: "pass", detail: `running on port ${info.port} — the web picker channel is ready` };
  } catch (err) {
    return fail("Broker", `probe failed: ${message(err)}`, "/xfer broker status");
  }
}

async function adminCheck(adminManager: Pick<AdminManager, "probe">): Promise<DoctorCheck> {
  try {
    const info = await adminManager.probe();
    if (info === null) {
      return { name: "Admin", status: "pass", detail: "not running (opt-in)", fix: "/xfer admin" };
    }
    return { name: "Admin", status: "pass", detail: `running at http://localhost:${info.port}` };
  } catch (err) {
    return fail("Admin", `probe failed: ${message(err)}`, "/xfer admin");
  }
}

async function meshCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  let config: MeshConfig;
  try {
    config = loadMeshConfig(deps.meshConfigPath);
  } catch (err) {
    const shown = displayPath(deps.meshConfigPath) ?? deps.meshConfigPath;
    if (!fs.existsSync(deps.meshConfigPath)) {
      return { name: "Mesh", status: "pass", detail: `not configured (opt-in) — create ${shown}`, fix: "see the mesh setup guide" };
    }
    return fail("Mesh", `config unusable: ${message(err)}`, "see the mesh setup guide");
  }
  const list = deps.listMeshNodes ?? listMeshNodes;
  try {
    const nodes = await withTimeout(list(config), deps.meshTimeoutMs ?? MESH_PROBE_TIMEOUT_MS);
    return { name: "Mesh", status: "pass", detail: `engine reachable — ${nodes.length} node(s) on ${config.endpoint}` };
  } catch (err) {
    return fail("Mesh", `engine unreachable at ${config.endpoint}: ${message(err)}`, "/xfer mesh list");
  }
}

function fail(name: string, detail: string, fix?: string): DoctorCheck {
  return { name, status: "fail", detail, fix };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

