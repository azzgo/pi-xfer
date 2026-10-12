/**
 * doctor.test.ts — `/xfer doctor` self-check (milestone1 P1-6).
 *
 * Every check is driven by an injected dir, stub probe and stub engine listing, so
 * nothing here touches the developer's real ~/.pi/xfer, spawns a daemon or opens a
 * socket. The zombie fixtures reuse the gc judgement: a metadata file naming a dead
 * pid is a zombie, and doctor must only report it, never reap it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AdminManager } from "./admin-manager.js";
import type { BrokerManager } from "./broker-manager.js";
import { formatDoctorReport, runDoctor, type DoctorDeps } from "./doctor.js";
import type { MeshConfig } from "./mesh-config.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix = "xfer-doctor-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A pid guaranteed gone: spawn `true` and let it exit. */
function deadPid(): number {
  const run = spawnSync("true");
  assert.ok(typeof run.pid === "number" && run.pid > 0);
  return run.pid;
}

function stubBroker(info: { port: number; pid: number } | null | Error): Pick<BrokerManager, "probe"> {
  return {
    probe: async () => {
      if (info instanceof Error) throw info;
      return info === null ? null : { startedAt: "", version: "test", ...info };
    },
  };
}

function stubAdmin(info: { port: number; pid: number } | null | Error): Pick<AdminManager, "probe"> {
  return {
    probe: async () => {
      if (info instanceof Error) throw info;
      return info === null ? null : { startedAt: "", version: "test", ...info };
    },
  };
}

interface Overrides {
  xferDir?: string;
  meshConfigPath?: string;
  broker?: ReturnType<typeof stubBroker>;
  admin?: ReturnType<typeof stubAdmin>;
  listMeshNodes?: (config: MeshConfig) => Promise<{ name: string; actorId: string }[]>;
  meshTimeoutMs?: number;
}

function deps(overrides: Overrides = {}): DoctorDeps {
  return {
    xferDir: overrides.xferDir ?? tmpDir(),
    myName: "me",
    brokerManager: overrides.broker ?? stubBroker({ port: 4719, pid: process.pid }),
    adminManager: overrides.admin ?? stubAdmin({ port: 7788, pid: process.pid }),
    meshConfigPath: overrides.meshConfigPath ?? path.join(tmpDir(), "mesh.config.json"),
    listMeshNodes: overrides.listMeshNodes ?? (async () => [{ name: "laptop", actorId: "a1" }]),
    meshTimeoutMs: overrides.meshTimeoutMs,
  };
}

function checkFor(report: { checks: { name: string }[] }, name: string) {
  const check = report.checks.find((c) => c.name === name);
  assert.ok(check, `no "${name}" check in ${report.checks.map((c) => c.name).join(", ")}`);
  return check as { name: string; status: string; detail: string; fix?: string };
}

describe("doctor: socket dir + peers", () => {
  it("passes the socket dir check and lists online peers", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "peer-one.sock"), "");
    fs.writeFileSync(path.join(dir, "peer-one.json"), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(path.join(dir, "me.sock"), "");
    fs.writeFileSync(path.join(dir, "me.json"), JSON.stringify({ pid: process.pid }));
    const report = await runDoctor(deps({ xferDir: dir }));

    assert.equal(checkFor(report, "Socket dir").status, "pass");
    const peers = checkFor(report, "Peers");
    assert.equal(peers.status, "pass");
    assert.match(peers.detail, /1 online: peer-one/);
    assert.ok(!peers.detail.includes("me"), "own socket must not count as a peer");
    assert.equal(peers.fix, undefined);
  });

  it("fails a missing socket dir, points at the fix and never creates the dir", async () => {
    const dir = path.join(tmpDir(), "absent");
    const report = await runDoctor(deps({ xferDir: dir }));

    const dirCheck = checkFor(report, "Socket dir");
    assert.equal(dirCheck.status, "fail");
    assert.match(dirCheck.detail, /does not exist/);
    assert.match(dirCheck.fix ?? "", /restart pi/);
    assert.equal(checkFor(report, "Peers").status, "fail");
    assert.ok(!fs.existsSync(dir), "doctor must stay read-only");
  });

  it("fails when the socket path is a file", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "xfer-file");
    fs.writeFileSync(file, "");
    const report = await runDoctor(deps({ xferDir: file }));
    assert.equal(checkFor(report, "Socket dir").status, "fail");
    assert.match(checkFor(report, "Socket dir").detail, /is not a directory/);
  });

  it("warns about zombie sockets with the /xfer gc hint and leaves them in place", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "ghost.json"), JSON.stringify({ pid: deadPid() }));
    fs.writeFileSync(path.join(dir, "ghost.sock"), "");
    fs.writeFileSync(path.join(dir, "peer-one.sock"), "");
    fs.writeFileSync(path.join(dir, "peer-one.json"), JSON.stringify({ pid: process.pid }));
    const report = await runDoctor(deps({ xferDir: dir }));

    const peers = checkFor(report, "Peers");
    assert.equal(peers.status, "warn");
    assert.match(peers.detail, /1 online: peer-one; 1 zombie socket\(s\): ghost/, `got: ${peers.detail}`);
    assert.equal(peers.fix, "/xfer gc");
    assert.ok(fs.existsSync(path.join(dir, "ghost.sock")), "doctor must not reap");
  });

  it("reports a lone session as having no peers", async () => {
    const report = await runDoctor(deps());
    assert.match(checkFor(report, "Peers").detail, /no peers online \(only this session\)/);
  });
});

describe("doctor: broker + admin", () => {
  it("passes both daemons with their port and console URL", async () => {
    const report = await runDoctor(deps());
    const broker = checkFor(report, "Broker");
    assert.equal(broker.status, "pass");
    assert.match(broker.detail, /running on port 4719/);
    assert.match(broker.detail, /web picker/);
    assert.match(checkFor(report, "Admin").detail, /http:\/\/localhost:7788/);
  });

  it("fails a stopped broker with /xfer broker start", async () => {
    const report = await runDoctor(deps({ broker: stubBroker(null) }));
    const broker = checkFor(report, "Broker");
    assert.equal(broker.status, "fail");
    assert.match(broker.detail, /not running/);
    assert.equal(broker.fix, "/xfer broker start");
  });

  it("fails a stopped admin with /xfer admin", async () => {
    const report = await runDoctor(deps({ admin: stubAdmin(null) }));
    const admin = checkFor(report, "Admin");
    assert.equal(admin.status, "fail");
    assert.equal(admin.fix, "/xfer admin");
  });

  it("turns a rejecting probe into a fail line instead of throwing", async () => {
    const report = await runDoctor(deps({ broker: stubBroker(new Error("socket exploded")) }));
    const broker = checkFor(report, "Broker");
    assert.equal(broker.status, "fail");
    assert.match(broker.detail, /probe failed: socket exploded/);
  });
});

describe("doctor: mesh", () => {
  function withConfig(body: Record<string, unknown>): string {
    const dir = tmpDir();
    const configPath = path.join(dir, "mesh.config.json");
    fs.writeFileSync(configPath, JSON.stringify(body));
    return configPath;
  }

  it("passes when the engine answers, naming the node count", async () => {
    const configPath = withConfig({ endpoint: "https://rivet.example", namespace: "ns" });
    const report = await runDoctor(deps({ meshConfigPath: configPath }));
    const mesh = checkFor(report, "Mesh");
    assert.equal(mesh.status, "pass");
    assert.match(mesh.detail, /engine reachable — 1 node\(s\)/);
    assert.equal(mesh.fix, undefined);
  });

  it("warns (opt-in) when no config exists and points at the mesh setup guide", async () => {
    const report = await runDoctor(deps());
    const mesh = checkFor(report, "Mesh");
    assert.equal(mesh.status, "warn");
    assert.match(mesh.detail, /not configured \(opt-in\)/);
    assert.equal(mesh.fix, "see the mesh setup guide");
  });

  it("fails an unparseable config", async () => {
    const dir = tmpDir();
    const configPath = path.join(dir, "mesh.config.json");
    fs.writeFileSync(configPath, "{ not json");
    const report = await runDoctor(deps({ meshConfigPath: configPath }));
    const mesh = checkFor(report, "Mesh");
    assert.equal(mesh.status, "fail");
    assert.match(mesh.detail, /config unusable/);
  });

  it("fails an unreachable engine with /xfer mesh list", async () => {
    const configPath = withConfig({ endpoint: "https://rivet.example" });
    const listMeshNodes = async () => {
      throw new Error("fetch failed");
    };
    const report = await runDoctor(deps({ meshConfigPath: configPath, listMeshNodes }));
    const mesh = checkFor(report, "Mesh");
    assert.equal(mesh.status, "fail");
    assert.match(mesh.detail, /engine unreachable at https:\/\/rivet\.example: fetch failed/);
    assert.equal(mesh.fix, "/xfer mesh list");
  });

  it("degrades a hanging engine into a fail instead of blocking the command", async () => {
    const configPath = withConfig({ endpoint: "https://rivet.example" });
    const listMeshNodes = () => new Promise<never>(() => {});
    const report = await runDoctor(deps({ meshConfigPath: configPath, listMeshNodes, meshTimeoutMs: 20 }));
    const mesh = checkFor(report, "Mesh");
    assert.equal(mesh.status, "fail");
    assert.match(mesh.detail, /timed out after 20ms/);
  });
});

describe("doctor: rendering", () => {
  it("renders one marked line per check plus a summary", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "ghost.json"), JSON.stringify({ pid: deadPid() }));
    fs.writeFileSync(path.join(dir, "ghost.sock"), "");
    const report = await runDoctor(deps({ xferDir: dir, broker: stubBroker(null) }));
    const text = formatDoctorReport(report);

    assert.match(text, /^🩺 \/xfer doctor\n/);
    assert.match(text, /\n {2}✓ Socket dir {2}.*exists and is writable/);
    assert.match(text, /\n {2}! Peers {4}.*ghost → \/xfer gc/);
    assert.match(text, /\n {2}✗ Broker {5}.*→ \/xfer broker start/);
    assert.match(text, /\n {2}✓ Admin {6}.*http:\/\/localhost:7788/);
    assert.match(text, /\n {2}! Mesh {5}.*→ see the mesh setup guide/);
    assert.match(text, /\n\n2 checks passed, 2 warnings, 1 failed$/);
  });

  it("omits warning and failure counts when there are none", () => {
    const text = formatDoctorReport({
      checks: [{ name: "Peers", status: "pass", detail: "1 online: a" }],
      passed: 1,
      warned: 0,
      failed: 0,
    });
    assert.match(text, /\n\n1 check passed$/);
  });
});