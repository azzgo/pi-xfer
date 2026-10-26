
var __xferImportMetaUrl = require("node:url").pathToFileURL(__filename).href;

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// daemon/admin-main.ts
var admin_main_exports = {};
__export(admin_main_exports, {
  DEFAULT_ADMIN_PORT: () => DEFAULT_ADMIN_PORT,
  createAdminServer: () => createAdminServer,
  main: () => main,
  startWatchers: () => startWatchers
});
module.exports = __toCommonJS(admin_main_exports);
var fs7 = __toESM(require("node:fs"), 1);
var http = __toESM(require("node:http"), 1);
var path8 = __toESM(require("node:path"), 1);

// src/board/board.ts
var fs = __toESM(require("node:fs"), 1);
var os = __toESM(require("node:os"), 1);
var path = __toESM(require("node:path"), 1);
var DEFAULT_BOARD_DIR = path.join(os.homedir(), ".pi", "xfer", "board");
var ENTRY_HEADER_RE = /^### (e-\d+) · (\S+) · (\S+) · (\S+)/;
function slugify(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "card";
}
function listCardFiles(boardDir) {
  try {
    return fs.readdirSync(boardDir).filter((f) => f.endsWith(".md")).map((f) => path.join(boardDir, f)).sort();
  } catch {
    return [];
  }
}
function nextCardId(boardDir) {
  let max = 0;
  for (const file of listCardFiles(boardDir)) {
    const m = path.basename(file).match(/^c-(\d+)-/);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `c-${String(max + 1).padStart(4, "0")}`;
}
function nextEntryId(body) {
  let max = 0;
  for (const m of body.matchAll(/^### e-(\d+) ·/gm)) {
    max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `e-${String(max + 1).padStart(4, "0")}`;
}
function serialize(card, body) {
  return `---
id: ${card.id}
title: ${card.title}
created_by: ${card.createdBy}
created_at: ${card.createdAt}
---
${body}`;
}
function appendEntryText(body, entry) {
  const section = `### ${entry.id} · ${entry.type} · ${entry.author} · ${entry.at}

${entry.text.trim()}
`;
  return `${body.replace(/\s+$/, "")}

${section}`;
}
var Board = class {
  dir;
  pending = null;
  constructor(dir = DEFAULT_BOARD_DIR) {
    this.dir = dir;
  }
  getPending() {
    return this.pending;
  }
  setPending(p) {
    this.pending = p;
  }
  list() {
    return listCardFiles(this.dir).flatMap((file) => {
      const card = this.read(file);
      return card ? [{ id: card.id, title: card.title, createdBy: card.createdBy, createdAt: card.createdAt }] : [];
    });
  }
  read(fileOrId) {
    const file = fileOrId.endsWith(".md") ? fileOrId : this.findFile(fileOrId);
    if (!file) return null;
    let raw;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!fm) return null;
    const meta = {};
    for (const line of fm[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (!meta.id) return null;
    const body = raw.slice(fm[0].length);
    const entries = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ENTRY_HEADER_RE);
      if (!m) continue;
      const rest = lines.slice(i + 1).join("\n");
      const nextIdx = rest.search(/^### e-\d+ · /m);
      entries.push({
        id: m[1],
        type: m[2],
        author: m[3],
        at: m[4],
        text: (nextIdx >= 0 ? rest.slice(0, nextIdx) : rest).trim()
      });
    }
    const header = {
      id: meta.id,
      title: meta.title ?? "(untitled)",
      createdBy: meta.created_by ?? "?",
      createdAt: meta.created_at ?? "?"
    };
    return { ...header, file, body, entries };
  }
  findFile(id) {
    return listCardFiles(this.dir).find((f) => path.basename(f).startsWith(`${id}-`));
  }
  create(title, author, firstEntry) {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = nextCardId(this.dir);
    const header = { id, title, createdBy: author, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    let body = "";
    const entries = [];
    if (firstEntry) {
      const entry = { id: "e-0001", ...firstEntry };
      body = appendEntryText(body, entry);
      entries.push(entry);
    }
    fs.writeFileSync(path.join(this.dir, `${id}-${slugify(title)}.md`), serialize(header, body), "utf-8");
    return { ...header, file: path.join(this.dir, `${id}-${slugify(title)}.md`), body, entries };
  }
  append(cardId, type, text, author) {
    const card = this.read(cardId);
    if (!card) throw new Error(`card not found: ${cardId}`);
    const entry = { id: nextEntryId(card.body), type, author, at: (/* @__PURE__ */ new Date()).toISOString(), text };
    fs.writeFileSync(card.file, serialize(card, appendEntryText(card.body, entry)), "utf-8");
    return entry;
  }
  del(cardId) {
    const card = this.read(cardId);
    if (!card) return null;
    fs.unlinkSync(card.file);
    return card.file;
  }
  clean() {
    const files = listCardFiles(this.dir);
    for (const f of files) fs.unlinkSync(f);
    return files;
  }
};

// src/broker/broker-manager.ts
var import_node_child_process = require("node:child_process");
var fs4 = __toESM(require("node:fs"), 1);
var net = __toESM(require("node:net"), 1);
var path5 = __toESM(require("node:path"), 1);

// src/core/utils.ts
var fs3 = __toESM(require("node:fs"), 1);
var path4 = __toESM(require("node:path"), 1);

// src/core/constants.ts
var fs2 = __toESM(require("node:fs"), 1);
var os3 = __toESM(require("node:os"), 1);
var path3 = __toESM(require("node:path"), 1);

// src/mesh/mesh-guard.ts
var os2 = __toESM(require("node:os"), 1);
var path2 = __toESM(require("node:path"), 1);
var MeshRemoteBlockedError = class extends Error {
  endpoint;
  constructor(endpoint, message) {
    super(message);
    this.name = "MeshRemoteBlockedError";
    this.endpoint = endpoint;
  }
};
var TEST_CONTEXT_ENV = "NODE_TEST_CONTEXT";
var ALLOW_REMOTE_ENV = "XFER_ALLOW_REMOTE";
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);
var ledger = { unguarded: 0, loopback: 0, allowed: [], blocked: [] };
function inTestContext(env = process.env) {
  return Boolean(env[TEST_CONTEXT_ENV]);
}
function remoteExplicitlyAllowed(env = process.env) {
  return env[ALLOW_REMOTE_ENV] === "1";
}
function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function isLoopbackEndpoint(endpoint) {
  const host = endpointHost(endpoint);
  return host !== null && LOOPBACK_HOSTS.has(host);
}
function assertEndpointReachable(endpoint, env = process.env) {
  if (!inTestContext(env)) {
    ledger.unguarded += 1;
    return;
  }
  if (isLoopbackEndpoint(endpoint)) {
    ledger.loopback += 1;
    return;
  }
  if (remoteExplicitlyAllowed(env)) {
    ledger.allowed.push(endpoint);
    return;
  }
  ledger.blocked.push(endpoint);
  throw new MeshRemoteBlockedError(
    endpoint,
    `mesh: refusing to reach "${endpoint}" from a test run — tests must be hermetic (loopback only). Inject a seam or a stub fetch instead; set ${ALLOW_REMOTE_ENV}=1 only when the test is deliberately exercising this guard`
  );
}
function resolveMeshConfigPath(realPath, env = process.env) {
  if (!inTestContext(env)) return realPath;
  const override = env.XFER_MESH_CONFIG;
  if (override) return override;
  return path2.join(os2.tmpdir(), `pi-xfer-test-${process.pid}-no-mesh.config.json`);
}

// src/core/constants.ts
var XFER_DIR = path3.join(os3.homedir(), ".pi", "xfer");
var MESH_CONFIG_PATH = resolveMeshConfigPath(path3.join(XFER_DIR, "mesh.config.json"));
var MESH_CACHE_DIR = path3.join(XFER_DIR, "cache");
var MAX_FRAME_BYTES = 1024 * 1024;
var MESH_PROBE_TIMEOUT_MS = 2500;
function readPackageVersion(extensionRoot) {
  try {
    const raw = JSON.parse(fs2.readFileSync(path3.join(extensionRoot, "package.json"), "utf-8"));
    return typeof raw.version === "string" && raw.version !== "" ? raw.version : null;
  } catch {
    return null;
  }
}

// src/core/utils.ts
function encodeAgentName(name) {
  return encodeURIComponent(name);
}
function decodeAgentName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
function endpointForName(name, xferDir = XFER_DIR) {
  return path4.join(xferDir, `${encodeAgentName(name)}.sock`);
}
function isEntryPoint(names) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return names.includes(path4.basename(invoked));
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readPeerMetadata(xferName, xferDir = XFER_DIR) {
  try {
    const raw = JSON.parse(fs3.readFileSync(path4.join(xferDir, `${encodeAgentName(xferName)}.json`), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const value = raw;
    return {
      ...typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {},
      ...typeof value.cwd === "string" ? { cwd: value.cwd } : {},
      ...typeof value.model === "string" ? { model: value.model } : {},
      ...typeof value.status === "string" ? { status: value.status } : {},
      ...typeof value.pid === "number" ? { pid: value.pid } : {},
      ...typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {},
      ...value.via === "ssh" ? {
        via: "ssh",
        host: typeof value.host === "string" ? value.host : "",
        ...value.role === "reverse" || value.role === "import" ? { role: value.role } : {}
      } : {}
    };
  } catch {
    return {};
  }
}
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function listPeers(myName, xferDir = XFER_DIR) {
  try {
    fs3.mkdirSync(xferDir, { recursive: true, mode: 448 });
    const names = fs3.readdirSync(xferDir).filter((f) => f.endsWith(".sock")).map((f) => decodeAgentName(f.replace(/\.sock$/, ""))).filter((n) => n !== myName);
    return [...new Set(names)].map((xferName) => ({
      xferName,
      endpoint: endpointForName(xferName),
      ...readPeerMetadata(xferName, xferDir)
    })).sort((a, b) => a.xferName.localeCompare(b.xferName));
  } catch {
    return [];
  }
}

// src/broker/broker-manager.ts
var DEFAULT_BROKER_PORT = 4719;
var PROBE_INTERVAL_MS = 50;
var DEFAULT_READINESS_TIMEOUT_MS = 5e3;
var STOP_TERM_GRACE_MS = 2e3;
var STOP_KILL_GRACE_MS = 1e3;
var LOG_TAIL_LINES = 20;
var BrokerManager = class {
  port;
  xferDir;
  readinessTimeoutMs;
  stopTermGraceMs;
  constructor(options = {}) {
    this.port = options.port ?? DEFAULT_BROKER_PORT;
    this.xferDir = options.xferDir ?? XFER_DIR;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.stopTermGraceMs = options.stopTermGraceMs ?? STOP_TERM_GRACE_MS;
  }
  /**
   * The status probe: alive only when broker.json exists AND its recorded pid
   * is live AND a TCP connect to its port succeeds. The pid check keeps a
   * crashed daemon's stale broker.json from blessing a foreign program that
   * squatted the port as "already running". Used by start() to detect an
   * already-running broker, by start()'s readiness poll, and exposed for
   * tests.
   */
  async probe() {
    const info = readBrokerJson(this.xferDir);
    if (info === null) return null;
    if (!pidAlive(info.pid)) return null;
    return await tcpProbe(info.port) ? info : null;
  }
  /**
   * Start the broker daemon. Returns "already running" when a live broker is
   * already up (no spawn); otherwise spawns detached, waits for readiness
   * (broker.json + TCP), and resolves with a one-line summary. `portOverride`
   * pins the daemon port for this start (0 = ephemeral); by default the
   * manager's configured port is used. If a foreign program held the port,
   * the daemon falls back to an ephemeral one and the summary says so.
   * Rejects on spawn failure or readiness timeout, surfacing the broker.log
   * tail.
   */
  async start(portOverride) {
    const port = portOverride ?? this.port;
    if (await this.probe() !== null) return "already running";
    if (!fs4.existsSync(BROKER_MAIN)) {
      throw new Error(
        `broker: daemon bundle missing (${BROKER_MAIN}) — run \`npm run build\` in the xfer extension directory`
      );
    }
    fs4.mkdirSync(this.xferDir, { recursive: true, mode: 448 });
    const logPath = path5.join(this.xferDir, "broker.log");
    const logFd = fs4.openSync(logPath, "a");
    let child;
    try {
      child = (0, import_node_child_process.spawn)(process.execPath, [
        BROKER_MAIN,
        "--port",
        String(port),
        "--xfer-dir",
        this.xferDir
      ], {
        // detached → the daemon becomes its own process-group leader, so the
        // stop ladder can kill(-pid, SIGTERM) the whole group; unref so the
        // daemon outlives this process and never keeps it alive.
        detached: true,
        stdio: ["ignore", logFd, logFd]
      });
    } catch (error) {
      try {
        fs4.closeSync(logFd);
      } catch {
      }
      throw new Error(`broker: spawn failed: ${errorMessage(error)}`);
    }
    child.unref();
    child.once("spawn", () => {
      try {
        fs4.closeSync(logFd);
      } catch {
      }
    });
    const spawnError = await confirmSpawn(child);
    if (spawnError) {
      try {
        fs4.closeSync(logFd);
      } catch {
      }
      throw new Error(`broker: spawn failed: ${spawnError.message}`);
    }
    const info = await this.waitReady(child);
    if (info === null) {
      throw new Error(`broker: not ready within ${this.readinessTimeoutMs}ms
${this.logTail()}`);
    }
    if (port !== 0 && info.port !== port) {
      return `broker started (pid ${info.pid}, port ${info.port} — port ${port} was occupied by another program, fell back to an ephemeral port)`;
    }
    return `broker started (pid ${info.pid}, port ${info.port})`;
  }
  /**
   * Stop ladder: read broker.pid → SIGTERM the process group → poll for exit
   * ≤ stopTermGraceMs → SIGKILL the group → unlink broker.pid/broker.json if
   * still present. Graceful no-op ("broker not running") when there is no
   * broker.pid or its pid is already gone.
   */
  async stop() {
    const pid = readPidFile(this.xferDir);
    if (pid === null) return "broker not running";
    if (!pidAlive(pid)) {
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
   * Read broker.json + its pid liveness + TCP probe its port; one text block
   * with port, pid, startedAt, version and alive|dead. Never rejects —
   * consumers read the output, never the exit code.
   */
  async status() {
    const info = readBrokerJson(this.xferDir);
    if (info === null) {
      return `broker: dead
  xferDir: ${this.xferDir} (no broker.json)`;
    }
    const listenerUp = await tcpProbe(info.port);
    if (!listenerUp || !pidAlive(info.pid)) {
      return [
        "broker: dead",
        listenerUp ? `  port: ${info.port} (listener present but pid ${info.pid} is dead — likely another program)` : `  port: ${info.port} (stale — no listener)`,
        `  pid: ${info.pid}`,
        `  startedAt: ${info.startedAt}`,
        `  version: ${info.version}`
      ].join("\n");
    }
    const drift = versionDriftNote(info.version);
    return [
      "broker: alive",
      `  port: ${info.port}`,
      `  pid: ${info.pid}`,
      `  startedAt: ${info.startedAt}`,
      `  version: ${info.version}`,
      ...drift ? [drift] : []
    ].join("\n");
  }
  /** Poll broker.json + TCP connect until ready or the deadline (or child exit). */
  async waitReady(child) {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (; ; ) {
      const info = await this.probe();
      if (info !== null) return info;
      if (child.exitCode !== null || child.signalCode !== null) return null;
      if (Date.now() > deadline) return null;
      await sleep(PROBE_INTERVAL_MS);
    }
  }
  /** The last LOG_TAIL_LINES non-empty lines of <xfer-dir>/broker.log. */
  logTail() {
    try {
      const lines = fs4.readFileSync(path5.join(this.xferDir, "broker.log"), "utf-8").split("\n").filter((line) => line.trim() !== "");
      return `last broker.log lines (${path5.join(this.xferDir, "broker.log")}):
${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
    } catch {
      return `broker.log unavailable at ${path5.join(this.xferDir, "broker.log")}`;
    }
  }
};
var BROKER_MAIN = path5.join(__dirname, "../../dist/broker.cjs");
function versionDriftNote(brokerVersion) {
  const installed = readPackageVersion(path5.join(__dirname, "../.."));
  if (installed === null || brokerVersion === "" || brokerVersion === installed) return null;
  return `  drift: started by ${brokerVersion}, this install is ${installed} — run /xfer broker stop then /xfer broker start so its handoff docs name a live page-tool path`;
}
function readBrokerJson(xferDir) {
  try {
    const data = JSON.parse(fs4.readFileSync(path5.join(xferDir, "broker.json"), "utf-8"));
    const port = typeof data.port === "number" ? data.port : NaN;
    const pid = typeof data.pid === "number" ? data.pid : NaN;
    if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(pid) || pid <= 0) return null;
    return {
      port,
      pid,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
      version: typeof data.version === "string" ? data.version : ""
    };
  } catch {
    return null;
  }
}
function readPidFile(xferDir) {
  try {
    const raw = fs4.readFileSync(path5.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function unlinkBrokerFiles(xferDir) {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs4.unlinkSync(path5.join(xferDir, name));
    } catch {
    }
  }
}
function tcpProbe(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
function confirmSpawn(child) {
  return new Promise((resolve) => {
    let confirmed = false;
    child.once("spawn", () => {
      confirmed = true;
      resolve(null);
    });
    child.once("error", (error) => {
      if (confirmed) return;
      resolve(error);
    });
  });
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isMainModule() {
  return isEntryPoint(["broker-manager.ts"]);
}
async function runCli() {
  const args = process.argv.slice(2);
  let port = DEFAULT_BROKER_PORT;
  let xferDir = XFER_DIR;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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
  let text;
  switch (subcommand) {
    case "start":
      text = await manager.start();
      break;
    case "stop":
      text = await manager.stop();
      break;
    case "status":
      text = await manager.status();
      break;
    default:
      console.error("usage: node broker-manager.ts <start|stop|status> [--port N] [--xfer-dir DIR]");
      process.exit(1);
  }
  process.stdout.write(`${text}
`);
}
if (isMainModule()) {
  runCli().catch((error) => {
    console.error(`broker-manager: ${errorMessage(error)}`);
    process.exit(1);
  });
}

// src/core/gc.ts
var fs5 = __toESM(require("node:fs"), 1);
var net2 = __toESM(require("node:net"), 1);
var path6 = __toESM(require("node:path"), 1);
var GC_SKIP_JSON = /* @__PURE__ */ new Set(["broker.json", "settings.json"]);
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err.code;
    if (code === "ESRCH") return false;
    return true;
  }
}
function socketHasListener(sockPath, timeoutMs = 1e3) {
  return new Promise((resolve) => {
    let settled = false;
    const conn = net2.connect({ path: sockPath });
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    timer.unref?.();
    conn.once("connect", () => finish(true));
    conn.once("error", (err) => {
      const dead = err.code === "ECONNREFUSED" || err.code === "ENOENT" || err.code === "ENOTSOCK";
      finish(!dead);
    });
  });
}
async function planGc(xferDir) {
  const zombies = [];
  const alive = [];
  let entries;
  try {
    entries = fs5.readdirSync(xferDir, { withFileTypes: true });
  } catch {
    return { zombies, alive };
  }
  const jsonStems = /* @__PURE__ */ new Set();
  const sockStems = /* @__PURE__ */ new Set();
  const linkLedgers = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(".link.") && entry.name.endsWith(".json")) {
      linkLedgers.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith(".json") && !GC_SKIP_JSON.has(entry.name)) {
      jsonStems.add(entry.name.slice(0, -".json".length));
    } else if (entry.name.endsWith(".sock")) {
      sockStems.add(entry.name.slice(0, -".sock".length));
    }
  }
  for (const stem of jsonStems) {
    const jsonPath = path6.join(xferDir, `${stem}.json`);
    const sockPath = path6.join(xferDir, `${stem}.sock`);
    let pid;
    let linkHost;
    let reverseMarker = false;
    let importMarker = false;
    try {
      const raw = JSON.parse(fs5.readFileSync(jsonPath, "utf-8"));
      const rec = raw;
      const candidate = rec?.pid;
      if (typeof candidate === "number") pid = candidate;
      if (rec?.via === "ssh" && typeof rec.host === "string") linkHost = rec.host;
      reverseMarker = rec?.role === "reverse";
      importMarker = rec?.role === "import";
    } catch {
    }
    if (importMarker && !reverseMarker) {
      if (!await socketHasListener(sockPath)) {
        zombies.push({ name: stem, sockPath, jsonPath, reason: "dead-link" });
      } else {
        alive.push(stem);
      }
      continue;
    }
    if (reverseMarker) {
      zombies.push({ name: stem, sockPath, jsonPath, reason: "dead-link", linkHost, reportOnly: true });
      continue;
    }
    if (linkHost !== void 0) {
      if (pid !== void 0 && !processAlive(pid)) {
        zombies.push({ name: stem, sockPath, jsonPath, pid, reason: "dead-link", linkHost });
      } else {
        alive.push(stem);
      }
      continue;
    }
    if (pid === void 0) {
      if (fs5.existsSync(sockPath) && !await socketHasListener(sockPath)) {
        zombies.push({ name: stem, sockPath, jsonPath, reason: "unreadable-json" });
      } else {
        alive.push(stem);
      }
      continue;
    }
    if (!processAlive(pid)) {
      zombies.push({ name: stem, sockPath, jsonPath, pid, reason: "dead-pid" });
    } else {
      alive.push(stem);
    }
  }
  const claimedByLink = /* @__PURE__ */ new Set();
  for (const file of linkLedgers) {
    const jsonPath = path6.join(xferDir, file);
    const label = decodeURIComponent(file.slice(".link.".length, -".json".length));
    let host;
    let pid;
    let names = [];
    try {
      const rec = JSON.parse(fs5.readFileSync(jsonPath, "utf-8"));
      if (typeof rec.host === "string") host = rec.host;
      if (typeof rec.pid === "number") pid = rec.pid;
      if (Array.isArray(rec.names)) names = rec.names.filter((n) => typeof n === "string");
    } catch {
    }
    const sockets = names.map((n) => path6.join(xferDir, `${encodeURIComponent(n)}.sock`));
    for (const name of names) claimedByLink.add(name);
    if (pid !== void 0 && !processAlive(pid)) {
      const owned = sockets.filter((p) => fs5.existsSync(p));
      zombies.push({
        name: label,
        sockPath: owned[0] ?? path6.join(xferDir, `.link-${label}.sock`),
        jsonPath,
        pid,
        reason: "dead-link",
        ...host ? { linkHost: host } : {},
        ...owned.length > 0 ? { ownedSockets: owned } : {}
      });
      for (const name of names) {
        const at = alive.indexOf(name);
        if (at >= 0) alive.splice(at, 1);
      }
    } else {
      alive.push(label);
    }
  }
  for (const stem of sockStems) {
    if (claimedByLink.has(stem)) continue;
    if (jsonStems.has(stem)) continue;
    const sockPath = path6.join(xferDir, `${stem}.sock`);
    if (await socketHasListener(sockPath)) {
      alive.push(stem);
      continue;
    }
    zombies.push({ name: stem, sockPath, reason: "orphan-sock" });
  }
  return { zombies, alive };
}
async function collectGarbage(xferDir) {
  const report = await planGc(xferDir);
  for (const zombie of report.zombies) {
    if (zombie.reportOnly) continue;
    if (zombie.linkHost !== void 0 && zombie.pid !== void 0) {
      try {
        process.kill(zombie.pid, "SIGTERM");
      } catch {
      }
    }
    const sockets = zombie.ownedSockets ?? [zombie.sockPath];
    for (const sock of sockets) {
      try {
        fs5.unlinkSync(sock);
      } catch {
      }
    }
    if (zombie.jsonPath) {
      try {
        fs5.unlinkSync(zombie.jsonPath);
      } catch {
      }
    }
  }
  return report;
}

// src/mesh/mesh-config.ts
var import_node_child_process2 = require("node:child_process");
var fs6 = __toESM(require("node:fs"), 1);
var XFER_INSTANCE_ACTOR = "xfer-instance";
function parseMeshConfig(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mesh config must be a JSON object");
  }
  const obj = raw;
  if (typeof obj.endpoint !== "string" || obj.endpoint.trim() === "") {
    throw new Error('mesh config needs a non-empty "endpoint"');
  }
  rejectUrlAuth(obj.endpoint.trim(), obj);
  const config = { endpoint: obj.endpoint.trim() };
  if (typeof obj.namespace === "string" && obj.namespace !== "") {
    if (isCommandValue(obj.namespace)) {
      throw new Error('mesh config "namespace" takes a literal or $ENV_VAR, not a "!" command');
    }
    if (isTemplateValue(obj.namespace)) config.namespaceExpression = obj.namespace;
    else config.namespace = obj.namespace;
  }
  if (obj.token !== void 0) {
    if (typeof obj.token !== "string") {
      throw new Error(
        'mesh config "token" must be a string — a literal, "$MESH_TOKEN", or "!pass show mesh-token". The old { "command": [...] } object form was never released'
      );
    }
    if (obj.token !== "") {
      if (isTemplateValue(obj.token) || isCommandValue(obj.token)) config.tokenExpression = obj.token;
      else config.token = obj.token;
    }
  }
  if (obj.pool !== void 0) {
    if (typeof obj.pool !== "string" || obj.pool.trim() === "") {
      throw new Error('mesh config "pool" must be a non-empty string');
    }
    config.pool = obj.pool.trim();
  }
  return config;
}
function rejectUrlAuth(endpoint, raw) {
  let url;
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
    ...typeof raw.pool === "string" && raw.pool !== "" ? { pool: raw.pool } : {}
  };
  throw new Error(
    `mesh config puts credentials in the endpoint URL (https://namespace:token@host), which is no longer supported — one URL carrying several settings was too easy to get wrong. Move them to their own fields:
  ${JSON.stringify(migrated, null, 2).replace(/\n/g, "\n  ")}
The token field also accepts "$MESH_TOKEN" (an environment variable) or "!pass show mesh-token" (a command), so it never has to be written into this file at all.`
  );
}
function loadMeshConfig(configPath) {
  let text;
  try {
    text = fs6.readFileSync(configPath, "utf-8");
  } catch {
    throw new Error(`mesh not configured — create ${configPath} ({ endpoint, namespace?, token?, pool? })`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`mesh config is not valid JSON: ${configPath} — ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMeshConfig(raw);
}
function isCommandValue(value) {
  return value.startsWith("!");
}
function isTemplateValue(value) {
  return parseTemplate(value).some((part) => part.type === "env") || value.includes("$$") || value.includes("$!");
}
var ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
function parseTemplate(value) {
  const parts = [];
  let index = 0;
  const appendLiteral = (text) => {
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
function templateEnvNames(value) {
  const names = [];
  for (const part of parseTemplate(value)) {
    if (part.type === "env" && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}
var TOKEN_COMMAND_TIMEOUT_MS = 1e4;
function missingEnvName(value, env = process.env) {
  for (const name of templateEnvNames(value)) {
    if (env[name] === void 0) return name;
  }
  return null;
}
function expandTemplate(value, env) {
  return parseTemplate(value).map((part) => part.type === "literal" ? part.value : env[part.name] ?? "").join("");
}
async function runTokenCommand(command, timeoutMs = TOKEN_COMMAND_TIMEOUT_MS, env = process.env, cwd = process.cwd()) {
  const shell2 = process.env.SHELL || "/bin/sh";
  const where = `cwd ${jsonish(cwd)}, shell ${shell2}`;
  const child = (0, import_node_child_process2.spawn)(shell2, ["-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
    shell: false
  });
  const collect = (async () => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", (err) => {
        reject(new Error(`mesh token command "!${command}" could not be started (${where}) — ${err.message}`));
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const said = stderr.trim();
    if (outcome.code !== 0) {
      const reason = outcome.signal ? `killed by ${outcome.signal}` : `exit code ${outcome.code}`;
      throw new Error(
        `mesh token command "!${command}" produced no token (${reason}; ${where})${said ? ` — ${said}` : ""}` + (looksLikePathFailure(said) ? ` — a relative path inside the command resolves against the cwd above; use an absolute path or $HOME` : "")
      );
    }
    const token = stdout.trim();
    if (!token) {
      throw new Error(
        `mesh token command "!${command}" produced an empty token (${where})` + (said ? ` — it wrote to stderr: ${said}` : "") + ` — check it prints the token on stdout and resolves any relative path against the cwd above`
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
function jsonish(value) {
  return JSON.stringify(value);
}
function looksLikePathFailure(stderr) {
  if (stderr === "") return false;
  return /no such file or directory|not found|command not found|没有那个文件或目录|无法找到|not found in/i.test(stderr);
}
async function resolveMeshConfig(config, options = {}) {
  if (!config.tokenExpression && !config.namespaceExpression) return config;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TOKEN_COMMAND_TIMEOUT_MS;
  const { tokenExpression, namespaceExpression, ...rest } = config;
  const resolved = { ...rest };
  if (tokenExpression !== void 0) {
    if (isCommandValue(tokenExpression)) {
      const command = tokenExpression.slice(1);
      const cwd = options.cwd ?? process.cwd();
      try {
        resolved.token = await runTokenCommand(command, timeoutMs, env, cwd);
      } catch (err) {
        throw new Error(`mesh config "token": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const missing = missingEnvName(tokenExpression, env);
      if (missing) {
        throw new Error(
          `mesh config "token" reads $${missing}, which is not set. Export it in the environment that runs pi, or point the field at a command instead: "!pass show mesh-token"`
        );
      }
      resolved.token = expandTemplate(tokenExpression, env);
    }
  }
  if (namespaceExpression !== void 0) {
    const missing = missingEnvName(namespaceExpression, env);
    if (missing) {
      throw new Error(`mesh config "namespace" reads $${missing}, which is not set`);
    }
    resolved.namespace = expandTemplate(namespaceExpression, env);
  }
  return resolved;
}
function deserializeMeshKey(serialized) {
  if (serialized === void 0 || serialized === null || serialized === "/" || serialized === "") return [];
  const parts = [];
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

// src/mesh/mesh-log.ts
var path7 = __toESM(require("node:path"), 1);
var MESH_LOG_PATH = path7.join(XFER_DIR, "mesh.log");

// src/mesh/mesh-engine.ts
var NO_ENVOYS_ERROR = "no_envoys";
function isNoEnvoys(error) {
  if (typeof error === "string") return error === NO_ENVOYS_ERROR;
  return Boolean(error) && typeof error === "object" && error.message === NO_ENVOYS_ERROR;
}
function deriveActorStatus(actor) {
  if (actor.destroy_ts !== void 0 && actor.destroy_ts !== null) return "Destroyed";
  if (isNoEnvoys(actor.error)) return "Idle";
  if (actor.error !== void 0 && actor.error !== null) return "Crashed";
  if (actor.sleep_ts !== void 0 && actor.sleep_ts !== null) return "Sleeping";
  if (actor.connectable_ts !== void 0 && actor.connectable_ts !== null) return "Running";
  return "Pending";
}
async function engineApi(config, method, path9, body) {
  assertEndpointReachable(config.endpoint);
  const url = new URL(path9, config.endpoint);
  if (config.namespace) url.searchParams.set("namespace", config.namespace);
  const headers = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (body !== void 0) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, ...body !== void 0 ? { body: JSON.stringify(body) } : {} });
  if (!response.ok) {
    throw new Error(`mesh engine ${method} ${url.pathname} failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
  return await response.json();
}
function listMeshNodes(config) {
  return fetchMeshNodes(config);
}
function meshPoolName(pool) {
  return pool || "default";
}
function deriveMeshNodeState(node, envoys) {
  if (envoys === null) return "Unknown";
  if (node.status === "Destroyed") return "Unknown";
  const live = envoys.some((envoy) => envoy.pool === meshPoolName(node.pool));
  if (node.status === "Idle") return live ? "Mismatch" : "NoRunner";
  if (node.status === "Running" || node.status === "Sleeping" || node.status === "Pending") return live ? node.status : "NoRunner";
  return node.status;
}
function meshListing(nodes, envoys) {
  return { nodes, envoys: envoys === null ? null : [...envoys] };
}
async function listMeshState(config) {
  const [nodes, envoys] = await Promise.allSettled([fetchMeshNodes(config), fetchMeshEnvoys(config)]);
  if (nodes.status === "rejected") throw nodes.reason;
  return meshListing(nodes.value, envoys.status === "fulfilled" ? envoys.value : null);
}
async function fetchMeshEnvoys(config) {
  const response = await engineApi(config, "GET", "/envoys");
  return (response.envoys ?? []).filter(isLiveRunner).map(toMeshRunnerInfo);
}
function isLiveRunner(envoy) {
  return envoy.stop_ts === void 0 || envoy.stop_ts === null;
}
function toMeshRunnerInfo(envoy) {
  return { pool: envoy.pool_name ?? "default", envoyKey: envoy.envoy_key ?? "", lastPingTs: envoy.last_ping_ts ?? 0 };
}
async function fetchMeshNodes(config) {
  const actors = await engineApi(
    config,
    "GET",
    "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR)
  );
  return actors.actors.filter(isLiveActor).map(toMeshNodeInfo);
}
function isLiveActor(actor) {
  return actor.destroy_ts === void 0 || actor.destroy_ts === null;
}
function toMeshNodeInfo(actor) {
  const deserialized = deserializeMeshKey(typeof actor.key === "string" ? actor.key : void 0);
  return {
    name: deserialized[0] ?? "",
    actorId: actor.actor_id,
    status: deriveActorStatus(actor),
    ...actor.runner_name_selector ? { pool: actor.runner_name_selector } : {}
  };
}

// src/mesh/mesh-status.ts
var MESH_STATE_ORDER = ["Running", "Sleeping", "NoRunner", "Mismatch", "Pending", "Crashed", "Unknown"];
var MESH_STATE_MARKS = {
  Running: { glyph: "●", label: "running" },
  Sleeping: { glyph: "◐", label: "sleeping" },
  NoRunner: { glyph: "○", label: "no runner" },
  Mismatch: { glyph: "⚠", label: "mismatch" },
  Pending: { glyph: "·", label: "pending" },
  Crashed: { glyph: "✗", label: "crashed" },
  Unknown: { glyph: "?", label: "unknown" }
};
function poolLabel(pool) {
  const name = meshPoolName(pool);
  return name === "default" ? "(default)" : name;
}

// daemon/admin-main.ts
var DEFAULT_ADMIN_PORT = 7788;
var EXTENSION_VERSION = (() => {
  try {
    return JSON.parse(fs7.readFileSync(path8.join(__dirname, "package.json"), "utf-8")).version ?? "?";
  } catch {
    return "?";
  }
})();
var MESH_DOWN_TIMEOUT_MS = 3e4;
var EventHub = class {
  clients = /* @__PURE__ */ new Set();
  add(res) {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }
  get size() {
    return this.clients.size;
  }
  /** Push to whoever is listening; nobody and nothing is buffered. */
  publish(event) {
    const frame = `data: ${JSON.stringify(event)}

`;
    for (const res of this.clients) res.write(frame);
  }
};
function peerRows(xferDir) {
  return listPeers("", xferDir).map((peer) => ({
    name: peer.xferName,
    online: peer.pid === void 0 ? true : processAlive2(peer.pid),
    sessionName: peer.sessionName ?? null,
    cwd: peer.cwd ?? null,
    pid: peer.pid
  }));
}
function processAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
var emptyMeshView = (overrides = {}) => ({
  configured: true,
  error: null,
  nodes: [],
  envoys: null,
  config: null,
  self: null,
  notice: null,
  ...overrides
});
async function meshView(xferDir, meshNode, notice = null) {
  const configPath = path8.join(xferDir, "mesh.config.json");
  if (!fs7.existsSync(configPath)) return emptyMeshView({ configured: false, notice });
  let config;
  try {
    config = await resolveMeshConfig(loadMeshConfig(configPath));
  } catch (err) {
    return emptyMeshView({ error: err instanceof Error ? err.message : String(err), notice });
  }
  const status = meshNode?.status();
  const self = status?.online ? { name: status.name, pool: config.pool ?? "(default)" } : null;
  try {
    const listing = await listMeshState(config);
    return { configured: true, error: null, nodes: listing.nodes, envoys: listing.envoys, config, self, notice };
  } catch (err) {
    return emptyMeshView({ error: err instanceof Error ? err.message : String(err), config, self, notice });
  }
}
async function loadMeshedView(xferDir, meshNode, notice = null) {
  try {
    return await withTimeout(meshView(xferDir, meshNode, notice), MESH_PROBE_TIMEOUT_MS);
  } catch {
    return emptyMeshView({ error: `engine did not answer within ${MESH_PROBE_TIMEOUT_MS} ms`, notice });
  }
}
function meshNoticeParam(tone, text) {
  return `notice=${encodeURIComponent(`${tone}|${text}`)}`;
}
function parseMeshNotice(value) {
  if (!value) return null;
  const split = value.indexOf("|");
  if (split <= 0) return null;
  const tone = value.slice(0, split) === "ok" ? "ok" : "warn";
  return { tone, text: value.slice(split + 1) };
}
var KIND_COLORS = {
  peer: ["#1a7f37", "#dafbe1"],
  mesh: ["#8250df", "#fbefff"],
  broker: ["#9a6700", "#fff8c5"],
  board: ["#0969da", "#ddf4ff"],
  gc: ["#cf222e", "#ffebe9"],
  admin: ["#59636e", "#e7ebef"]
};
var TONES = { peers: "#1a7f37", mesh: "#8250df", board: "#0969da", broker: "#9a6700" };
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
var escAttribute = (s) => esc(s).replace(/[`\u0000-\u001f]/g, "");
var md = (src) => esc(src).replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h3>$1</h3>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>").replace(/^- (.*)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>").replace(/\n{2,}/g, "<br><br>");
var css = () => {
  const c = { bg: "#f3efe6", panel: "#fffdf8", line: "#e4dccb", text: "#1c1917", muted: "#6b6256", dim: "#8a8174", hover: "#efe8da", soft: "#e7dfd0", nav: "#fffdf8", navText: "#6b6256", accent: "#1d4ed8" };
  return `
  :root { --soft:${c.soft}; --hover:${c.hover}; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body { font:15px/1.55 ui-sans-serif,system-ui,sans-serif; background:${c.bg}; color:${c.text}; }
  body.fit { display:flex; flex-direction:column; overflow:hidden; }
  body.fit .wrap { flex:1; min-height:0; display:flex; flex-direction:column; padding-bottom:40px; }
  body.fit .filters { flex:none; }
  body.fit .feed { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  body.fit #feed { flex:1; min-height:0; overflow:auto; }
  body.fit .empty { height:100%; display:flex; align-items:center; justify-content:center; padding:0; }
  a { color:inherit; text-decoration:none; }
  .mono { font-family:ui-monospace,SFMono-Regular,monospace; }
  .muted { color:${c.muted}; } .dim { color:${c.dim}; }
  .row { display:flex; gap:10px; align-items:center; }
  .panel { background:${c.panel}; border:1px solid ${c.line}; border-radius:12px; padding:20px 24px; }
  .pill { padding:2px 10px; border-radius:99px; font-size:12px; font-weight:500; }
  .btn { border:none; border-radius:99px; padding:9px 20px; cursor:pointer; font-size:13px;
         font-weight:600; font-family:inherit; background:${c.soft}; color:${c.text}; display:inline-block; }
  .btn:hover { background:${c.hover}; }
  .btn:active { transform:translateY(1px); }
  .btn.sm { padding:6px 16px; font-size:12.5px; }
  .btn.primary { background:#1f883d; color:#fff; }
  .btn.primary:hover { background:#1a7f37; }
  .btn.danger { background:#cf222e; color:#fff; }
  .btn.danger:hover { background:#a40e26; }
  .btn.on { background:${c.accent}; color:#fff; }
  .dot { width:8px; height:8px; border-radius:99px; display:inline-block; flex:none; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:${c.muted}; margin-bottom:12px; font-weight:600; }
  h3 { font-size:11.5px; text-transform:uppercase; letter-spacing:.09em; color:${c.dim}; margin:2px 0 6px; font-weight:600; }
  .rules { display:flex; gap:16px; flex-wrap:wrap; color:${c.muted}; font-size:12.5px; margin:2px 0 12px; }
  .rules span { display:inline-flex; gap:6px; align-items:center; }
  .notice { border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:13px; border:1px solid ${c.line}; }
  .subhead { margin:20px 0 8px; }
  .notice.ok { background:#dafbe1; color:#0f5323; border-color:#aceebb; }
  .notice.warn { background:#fff8c5; color:#7d4e00; border-color:#eac54f; }
  h1 { font-size:28px; font-weight:650; letter-spacing:-.02em; margin-bottom:6px; line-height:1.2; }
  .lede { color:${c.muted}; margin-bottom:22px; font-size:15px; }
  nav { display:flex; gap:2px; padding:12px 28px; border-bottom:1px solid ${c.line}; background:${c.nav}; align-items:center; }
  nav a { padding:5px 15px; border-radius:99px; font-size:13.5px; color:${c.navText}; font-weight:500; }
  nav a:hover { background:${c.hover}; color:${c.accent}; }
  nav a.on { color:#fff; background:${c.accent}; }
  nav .brand { font-weight:700; color:${c.text}; margin-right:14px; font-size:14.5px; }
  .wrap { margin:0 auto; width:100%; padding:28px 36px 88px; }
  .grid { display:grid; gap:16px; }
  .stats { grid-template-columns:repeat(4,1fr); margin-bottom:16px; }
  .stat { display:block; border-top:3px solid transparent; }
  .stat b { font-size:36px; display:block; line-height:1.15; letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
  .ev { display:flex; gap:12px; padding:12px 2px; border-bottom:1px solid ${c.hover}; align-items:baseline; }
  .ev:last-child { border-bottom:none; }
  .ev .text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ev-detail { display:none; background:var(--soft); border-radius:8px; padding:10px 14px; margin:-4px 0 6px; font-size:12.5px; }
  .card-row { border:1px solid ${c.line}; border-radius:12px; padding:16px 20px; margin-bottom:12px; background:${c.panel}; }
  .md { font-size:16px; max-width:72ch; }
  .md h3 { font-size:13px; margin:18px 0 8px; color:${c.muted}; text-transform:uppercase; letter-spacing:.05em; }
  .md ul { padding-left:20px; margin:4px 0; }
  .md li { margin:4px 0; }
  .md code { background:${c.soft}; border-radius:4px; padding:1px 6px; font-size:12.5px; }
  .empty { text-align:center; padding:28px 24px; color:${c.dim}; }
  .hint { position:relative; display:inline-flex; width:18px; height:18px; margin-left:8px; border-radius:99px;
    border:1px solid ${c.line}; color:${c.muted}; font-size:11px; font-style:italic; font-weight:700;
    align-items:center; justify-content:center; cursor:default; }
  .hint:hover::after { content:attr(data-tip); position:absolute; left:50%; bottom:calc(100% + 8px); transform:translateX(-50%);
    width:max-content; max-width:240px; padding:6px 10px; border-radius:8px; background:#1c1917; color:#fff;
    font-style:normal; font-weight:500; font-size:12px; line-height:1.4; white-space:normal; z-index:5; }
  form { display:inline; }
  @media (max-width:900px) { .stats { grid-template-columns:1fr 1fr; } }`;
};
var now = () => (/* @__PURE__ */ new Date()).toTimeString().slice(0, 8);
var shell = (active, title, lede, body) => `
  <nav>
    <span class="brand mono">xfer admin</span>
    ${[["/", "dashboard"], ["/events", "events"], ["/board", "board"], ["/control", "control"]].map(([href, label]) => `<a href="${href}" class="${label === active ? "on" : ""}">${label}</a>`).join("")}
  </nav>
  <div class="wrap">
    <h1>${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ""}${body}
  </div>`;
var page = (fit, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>xfer admin</title><style>${css()}</style></head><body class="${fit ? "fit" : ""}">${body}${CLIENT_SCRIPT}</body></html>`;
var statCard = (tone, label, num, sub, href) => `<a class="panel stat" href="${href}" style="border-top-color:${TONES[tone]}"><h2>${esc(label)}</h2><b style="color:${TONES[tone]}">${esc(num)}</b><div class="muted">${esc(sub)}</div></a>`;
var CLIENT_SCRIPT = `<script>
(() => {
  const KIND_STYLE = {
    peer:   ["#1a7f37", "#dafbe1"],
    mesh:   ["#8250df", "#fbefff"],
    broker: ["#9a6700", "#fff8c5"],
    board:  ["#0969da", "#ddf4ff"],
    gc:     ["#cf222e", "#ffebe9"],
    admin:  ["#59636e", "#e7ebef"],
  };
  const feed = document.getElementById('feed');
  if (!feed) return;
  let filter = 'all';
  const applyFilter = () => {
    feed.querySelectorAll('.ev').forEach((el) => {
      el.style.display = filter === 'all' || el.dataset.kind === filter ? '' : 'none';
    });
  };
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      const btn = form.querySelector('[data-confirm]');
      if (btn && !window.confirm(btn.dataset.confirm)) e.preventDefault();
    });
  });
  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b === btn));
      applyFilter();
    });
  });
  const cap = 200;
  new EventSource('/sse').onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    const empty = feed.querySelector('.empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'ev mono';
    row.dataset.kind = ev.kind;
    row.style.cursor = ev.full ? 'pointer' : 'default';
    const time = document.createElement('span');
    time.className = 'dim';
    time.style.flex = 'none';
    time.textContent = ev.t;
    const [fg, bg] = KIND_STYLE[ev.kind] ?? KIND_STYLE.admin;
    const tag = document.createElement('span');
    tag.className = 'pill';
    tag.style.color = fg;
    tag.style.background = bg;
    tag.textContent = ev.kind;
    const label = document.createElement('span');
    label.className = 'text';
    const b = document.createElement('b');
    b.textContent = ev.text;
    const d = document.createElement('span');
    d.className = 'muted';
    d.textContent = ' · ' + ev.detail;
    label.appendChild(b);
    label.appendChild(d);
    row.appendChild(time);
    row.appendChild(tag);
    row.appendChild(label);
    let detail = null;
    if (ev.full) {
      detail = document.createElement('div');
      detail.className = 'ev-detail mono muted';
      detail.textContent = ev.full;
      row.addEventListener('click', () => {
        detail.style.display = detail.style.display === 'block' ? 'none' : 'block';
      });
    }
    feed.prepend(row);
    if (detail) feed.insertBefore(detail, row.nextSibling);
    while (feed.children.length > cap * 2) feed.lastChild?.remove();
    applyFilter();
  };
})();
</script>`;
var STATE_DOT_COLORS = {
  Running: "#1a7f37",
  Sleeping: "#9a6700",
  NoRunner: "#8250df",
  Mismatch: "#bc4c00",
  Pending: "#0969da",
  Crashed: "#cf222e",
  Unknown: "#8a8174"
};
var STATUS_LEGEND = `<div class="rules">${MESH_STATE_ORDER.map((state) => `<span><span class="dot" style="background:${STATE_DOT_COLORS[state]}"></span>${MESH_STATE_MARKS[state].label}</span>`).join("")}</div>`;
var meshPoolCount = (nodes) => new Set(nodes.map((node) => meshPoolName(node.pool))).size;
var meshRowState = (node, mesh) => deriveMeshNodeState({ status: node.status ?? "Unknown", pool: node.pool }, mesh.envoys);
var rowReason = (node, mesh) => {
  if (mesh.envoys === null) return "engine did not answer /envoys — its pool's runners are unknown";
  const pool = poolLabel(node.pool);
  const state = meshRowState(node, mesh);
  if (state === "NoRunner") return `no runner in pool "${pool}"`;
  if (state === "Mismatch") return `pool "${pool}" has a runner, but the actor record still reads idle`;
  if (state === "Sleeping") return `asleep in pool "${pool}" — wakes on delivery`;
  return "";
};
var meshDownForm = (node, confirmMessage) => `<form method="post" action="/control/mesh/down"><input type="hidden" name="name" value="${escAttribute(node.name)}"><input type="hidden" name="actor" value="${escAttribute(node.actorId)}"><button class="btn sm danger"${confirmMessage ? ` data-confirm="${esc(confirmMessage)}"` : ""}>down</button></form>`;
var meshNodeRow = (node, mesh) => {
  const state = meshRowState(node, mesh);
  const dot = STATE_DOT_COLORS[state];
  const isSelf = mesh.self?.name === node.name;
  const pool = poolLabel(node.pool);
  const runningElsewhere = node.status === "Running" && !isSelf;
  const confirmMessage = runningElsewhere ? `"${node.name}" is Running on another host right now. Destroying its actor cuts that host off mid-session. Destroy it anyway?` : null;
  const reason = rowReason(node, mesh);
  return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--hover)">
    <span class="mono" style="color:${dot};width:1em;text-align:center">${MESH_STATE_MARKS[state].glyph}</span><b class="mono">${esc(node.name)}</b>
    <span class="muted">${MESH_STATE_MARKS[state].label}</span>
    <span class="dim mono">pool ${esc(pool)}</span>
    ${reason ? `<span class="dim">— ${esc(reason)}</span>` : ""}
    ${isSelf ? `<span class="pill" style="color:#8250df;background:#fbefff">this node</span>` : ""}
    <span style="flex:1"></span>${meshDownForm(node, confirmMessage)}</div>`;
};
var meshViewBody = (mesh) => {
  if (!mesh.configured) return `<div class="empty">not configured — no mesh.config.json in the xfer dir</div>`;
  if (mesh.error !== null) return `<div class="notice warn mono">engine error — ${esc(mesh.error)}</div>`;
  const rows = mesh.nodes.map((node) => meshNodeRow(node, mesh)).join("");
  const unknown = mesh.envoys === null ? `<div class="notice warn mono">the engine did not answer /envoys — every row reads "?"</div>` : "";
  return `${unknown}${STATUS_LEGEND}${rows || `<div class="empty">no mesh nodes on the engine</div>`}`;
};
var presenceRows = (peers) => peers.length === 0 ? `<div class="empty">no local peers</div>` : peers.map((p) => {
  const col = p.online ? "#1a7f37" : "#cf222e";
  return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--hover)">
    <span class="dot" style="background:${col}"></span><b class="mono">${esc(p.name)}</b>
    <span class="muted">${p.online ? "online" : "zombie"}${p.sessionName ? ` · ${esc(p.sessionName)}` : ""}</span>
    <span style="flex:1"></span><span class="dim">${p.cwd ? esc(p.cwd) : ""}</span></div>`;
}).join("");
var boardList = (ctx) => {
  const cards = new Board(ctx.boardDir).list();
  if (cards.length === 0) return `<div class="empty">board is empty</div>`;
  return cards.map((c) => `<div class="card-row"><div class="row">
    <a href="/board/${encodeURIComponent(c.id)}"><b class="mono" style="border-bottom:1px dotted #0969da">${esc(c.title)}</b></a>
    <span class="dim mono">${esc(c.id)}</span><span class="dim">by ${esc(c.createdBy)}</span>
    <span style="flex:1"></span>
    <form method="post" action="/board/open"><input type="hidden" name="card" value=""><button class="btn sm">open folder</button></form>
  </div></div>`).join("");
};
var boardDetail = (ctx, idOrTitle) => {
  const board = new Board(ctx.boardDir);
  const cards = board.list();
  const header = cards.find((c) => c.id === idOrTitle) ?? cards.find((c) => c.title === idOrTitle);
  const card = header ? board.read(header.id) : null;
  if (!card) return shell("board", "Board", "", `<div class="empty">card not found: ${esc(idOrTitle)}</div>`);
  return shell("board", card.title, "", `
    <div class="row" style="margin-bottom:14px">
      <a class="muted" href="/board">← board</a>
      <span class="pill" style="color:#0969da;background:#ddf4ff">${esc(card.id)}</span>
      <span class="dim">by ${esc(card.createdBy)} · ${card.entries.length} entr${card.entries.length === 1 ? "y" : "ies"}</span>
      <span style="flex:1"></span>
      <form method="post" action="/board/open"><input type="hidden" name="card" value="${esc(card.id)}"><button class="btn">open in editor</button></form>
    </div>
    <div class="panel md">${md(card.body)}</div>`);
};
var controlPage = (ctx, peers, mesh, broker, selfCheck) => {
  const brokerRow = broker ? `<div class="row" style="padding:6px 0"><span class="dot" style="background:#1a7f37"></span>
        <b class="mono">broker</b><span class="muted">:${broker.port}</span><span style="flex:1"></span>
        <form method="post" action="/control/broker/stop"><button class="btn sm danger">stop</button></form></div>` : `<div class="row" style="padding:6px 0"><span class="dot" style="background:#cf222e"></span>
        <b class="mono">broker</b><span class="muted">stopped</span><span style="flex:1"></span>
        <form method="post" action="/control/broker/start"><button class="btn sm primary">start</button></form></div>`;
  const meshPoint = mesh.error !== null ? "#cf222e" : mesh.configured ? "#8250df" : "#8a8174";
  const meshSummary = mesh.configured ? `${mesh.nodes.length} node(s) · ${meshPoolCount(mesh.nodes)} pool(s)` : "not configured";
  const notice = mesh.notice ? `<div class="notice ${mesh.notice.tone}">${esc(mesh.notice.text)}</div>` : "";
  return shell(
    "control",
    "Control",
    "Presence and the few actions this console is allowed to take.",
    `
    ${notice}
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="panel"><h2>presence</h2>
        <h3>local peers</h3>${presenceRows(peers)}
        <h3 class="subhead">mesh nodes</h3>${meshViewBody(mesh)}
      </div>
      <div>
        <div class="panel" style="margin-bottom:14px"><h2>services</h2>
          ${brokerRow}
          <div class="row" style="padding:6px 0"><span class="dot" style="background:#1a7f37"></span>
            <b class="mono">admin</b><span class="muted">:${ctx.port} (this)</span><span style="flex:1"></span>
            <form method="post" action="/control/admin/stop"><button class="btn sm danger">stop</button></form></div>
          <div class="row" style="padding:6px 0"><span class="dot" style="background:${meshPoint}"></span>
            <b class="mono">mesh</b><span class="muted">${meshSummary}</span></div>
        </div>
        <div class="panel"><h2>maintenance</h2>
          <div class="row"><form method="post" action="/control/gc"><button class="btn">run gc</button></form>
            <span class="muted">reclaim zombie peer sockets</span></div>
          <div class="row" style="margin-top:10px"><form method="post" action="/control/selfcheck"><button class="btn">self-check</button></form>
            <span class="muted">doctor-style status probe</span></div>
          ${selfCheck ? `<pre class="mono muted" style="margin-top:14px;white-space:pre-wrap">${esc(selfCheck)}</pre>` : ""}
        </div>
      </div>
    </div>`
  );
};
function createAdminServer(options) {
  const { xferDir, boardDir } = options;
  const hub = new EventHub();
  const brokerManager = new BrokerManager({ xferDir });
  const meshNode = options.meshNode ?? null;
  const destroyMeshNode = options.destroyMeshNode ?? destroyMeshActor;
  let meshBusy = null;
  let port = DEFAULT_ADMIN_PORT;
  const openPath = options.openPath ?? openInSystem;
  const heartbeatMs = options.heartbeatMs ?? 15e3;
  const publish = (event) => {
    options.onEvent?.(event);
    hub.publish(event);
  };
  async function render(pathname, query) {
    const ctx = {
      xferDir,
      boardDir,
      port,
      brokerProbe: () => brokerManager.probe()
    };
    if (pathname === "/" || pathname === "") {
      const peers = peerRows(xferDir);
      const online = peers.filter((p) => p.online).length;
      const cards = new Board(boardDir).list();
      const broker = await brokerManager.probe();
      const mesh = await loadMeshedView(xferDir, meshNode);
      const meshLine = mesh.configured ? mesh.error ? "engine error" : `${mesh.nodes.length} node(s)` : "not configured";
      const body = `
      <div class="grid stats">
        ${statCard("peers", "peers", String(peers.length), `${online} online · ${peers.length - online} zombie`, "/control")}
        ${statCard("mesh", "mesh", String(mesh.nodes.length), meshLine, "/control")}
        ${statCard("board", "board", String(cards.length), `${cards.length} card(s)`, "/board")}
        ${statCard("broker", "broker", broker ? "▲" : "▽", broker ? `running · :${broker.port}` : "stopped", "/control")}
      </div>
      <div class="panel feed" style="min-height:260px"><div class="row" style="margin-bottom:4px"><h2 style="margin:0">live activity</h2>
        <span style="flex:1"></span><a class="muted" href="/events">events →</a></div>
        <div id="feed" style="max-height:420px;overflow:auto"><div class="empty">listening since page open — events appear here as they happen</div></div></div>`;
      return page(false, shell(
        "dashboard",
        "Overview",
        "Local presence, mesh, and the board — what is happening on this machine.",
        body
      ));
    }
    if (pathname === "/events") {
      const body = `
      <div class="row filters" style="margin-bottom:14px">
        <button class="btn primary on" data-filter="all">all</button>
        ${Object.keys(KIND_COLORS).map((k) => `<button class="btn" data-filter="${k}">${k}</button>`).join("")}
        <span class="hint" data-tip="Since this page opened. Events are not persisted.">i</span>
      </div>
      <div class="panel feed"><div id="feed"><div class="empty">listening — events appear here as they happen</div></div></div>`;
      return page(true, shell("events", "Event stream", "Fire-and-forget. Nothing here is stored.", body));
    }
    if (pathname === "/board") {
      return page(false, shell("board", "Board", "machine-local · append-only, human-cleaned", boardList(ctx)));
    }
    if (pathname.startsWith("/board/")) {
      return page(false, boardDetail(ctx, decodeURIComponent(pathname.slice("/board/".length))));
    }
    if (pathname === "/control") {
      const peers = peerRows(xferDir);
      const mesh = await loadMeshedView(xferDir, meshNode, parseMeshNotice(query.get("notice")));
      const broker = await brokerManager.probe();
      return page(false, controlPage(ctx, peers, mesh, broker, query.get("selfcheck") === "1" ? selfCheckReport(peers, mesh, broker) : null));
    }
    return page(false, shell("dashboard", "Not found", "", `<div class="empty">no such page: ${esc(pathname)}</div>`));
  }
  function selfCheckReport(peers, mesh, broker) {
    const lines = [
      `peers: ${peers.length} socket(s), ${peers.filter((p) => p.online).length} alive`,
      broker ? `broker: alive on :${broker.port}` : "broker: not running (/xfer broker start)",
      `mesh: ${!mesh.configured ? "not configured" : mesh.error ? `engine error — ${mesh.error}` : `${mesh.nodes.length} node(s) online`}`,
      `board: ${new Board(boardDir).list().length} card(s)`,
      `admin: alive on :${port} (this page)`
    ];
    return lines.join("\n");
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/sse" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(": connected\n\n");
      hub.add(res);
      const heartbeat = setInterval(() => res.write(": hb\n\n"), heartbeatMs);
      res.on("close", () => clearInterval(heartbeat));
      return;
    }
    if (req.method === "POST") {
      void handlePost(req, res, url);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    void render(url.pathname, url.searchParams).then(
      (html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      },
      (err) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`admin: render failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    );
  });
  const MAX_BODY_BYTES = 64 * 1024;
  async function readBody(req) {
    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw Object.assign(new Error(`request body too large (${declared} bytes)`), { statusCode: 413 });
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        req.destroy();
        throw Object.assign(new Error(`request body too large (> ${MAX_BODY_BYTES} bytes)`), { statusCode: 413 });
      }
    }
    return body;
  }
  function redirect(res, to) {
    res.writeHead(303, { location: to });
    res.end();
  }
  async function handlePost(req, res, url) {
    const back = (fallback) => {
      const referer = req.headers.referer;
      if (referer) {
        const ref = new URL(referer);
        return ref.pathname + (ref.search ?? "");
      }
      return fallback;
    };
    try {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      if (url.pathname === "/control/gc") {
        const report = await collectGarbage(xferDir);
        publish({
          t: now(),
          kind: "gc",
          text: `gc removed ${report.zombies.length} zombie(s)`,
          detail: `kept ${report.alive.length} live peer(s)`,
          full: report.zombies.map((z) => `${z.name} — ${z.reason}`).join("\n") || "(nothing to reclaim)"
        });
        redirect(res, back("/control"));
        return;
      }
      if (url.pathname === "/control/broker/start") {
        const result = await brokerManager.start();
        publish({ t: now(), kind: "broker", text: "broker started via admin", detail: result });
        redirect(res, back("/control"));
        return;
      }
      if (url.pathname === "/control/broker/stop") {
        const result = await brokerManager.stop();
        publish({ t: now(), kind: "broker", text: "broker stopped via admin", detail: result });
        redirect(res, back("/control"));
        return;
      }
      if (url.pathname === "/control/admin/stop") {
        redirect(res, back("/control"));
        for (const name of ["admin.pid", "admin.json"]) {
          try {
            fs7.unlinkSync(path8.join(xferDir, name));
          } catch {
          }
        }
        if (options.shutdown) options.shutdown();
        else server.close();
        return;
      }
      if (url.pathname === "/control/selfcheck") {
        redirect(res, back("/control?selfcheck=1"));
        return;
      }
      if (url.pathname === "/control/mesh/down") {
        await handleMeshDown(form.get("name") ?? "", form.get("actor") ?? "", res, back);
        return;
      }
      if (url.pathname === "/board/open") {
        const card = form.get("card") ?? "";
        if (card === "") {
          openPath(boardDir, false);
          publish({ t: now(), kind: "board", text: "board folder opened", detail: boardDir });
        } else {
          const board = new Board(boardDir);
          const target = board.read(card);
          if (!target) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end(`card not found: ${card}`);
            return;
          }
          openPath(target.file, true);
          publish({ t: now(), kind: "board", text: `card opened in editor`, detail: target.id });
        }
        redirect(res, back("/board"));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      const status = err.statusCode ?? 500;
      res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`admin: action failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async function handleMeshDown(name, actorId, res, back) {
    const target = name.trim();
    const refuse = (text) => {
      publish({ t: now(), kind: "mesh", text: `mesh down refused — ${target || "(no name)"}`, detail: text });
      redirect(res, back(`/control?${meshNoticeParam("warn", text)}`));
    };
    if (target === "") return refuse("mesh down needs a node name");
    const configPath = path8.join(xferDir, "mesh.config.json");
    if (!fs7.existsSync(configPath)) return refuse("mesh is not configured — no mesh.config.json in the xfer dir");
    let config;
    try {
      config = await resolveMeshConfig(loadMeshConfig(configPath));
    } catch (err) {
      return refuse(`mesh config unusable — ${err instanceof Error ? err.message : String(err)}`);
    }
    const selfStatus = meshNode?.status();
    if (meshNode && selfStatus?.online && selfStatus.name === target) {
      try {
        await withTimeout(meshNode.down(), MESH_DOWN_TIMEOUT_MS);
        publish({ t: now(), kind: "mesh", text: `mesh node went down — ${target}`, detail: "this daemon's own node, via admin" });
        redirect(res, back(`/control?${meshNoticeParam("ok", `mesh node "${target}" (this daemon) is offline`)}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        publish({ t: now(), kind: "mesh", text: `mesh down failed — ${target}`, detail: message });
        redirect(res, back(`/control?${meshNoticeParam("warn", message)}`));
      }
      return;
    }
    if (meshBusy) return refuse(`mesh is busy — ${meshBusy} is still in flight`);
    try {
      meshBusy = `down "${target}"`;
      const nodes = await withTimeout(listMeshNodes(config), MESH_PROBE_TIMEOUT_MS);
      const node = nodes.find((candidate) => candidate.name === target);
      if (!node) return refuse(`mesh node "${target}" is not in the engine listing — nothing to destroy`);
      if (actorId !== "" && actorId !== node.actorId) {
        return refuse(`mesh node "${target}" changed since this page rendered — reload the page before destroying it`);
      }
      await withTimeout(destroyMeshNode(config, node.actorId), MESH_DOWN_TIMEOUT_MS);
      publish({ t: now(), kind: "mesh", text: `mesh node went down — ${target}`, detail: `actor ${node.actorId} destroyed via admin` });
      redirect(res, back(`/control?${meshNoticeParam("ok", `mesh node "${target}" was destroyed (actor ${node.actorId})`)}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      publish({ t: now(), kind: "mesh", text: `mesh down failed — ${target}`, detail: message });
      redirect(res, back(`/control?${meshNoticeParam("warn", message)}`));
    } finally {
      meshBusy = null;
    }
  }
  return {
    server,
    publish,
    hubSize: () => hub.size,
    setPort: (p) => {
      port = p;
    }
  };
}
async function destroyMeshActor(config, actorId) {
  const url = new URL(`/actors/${encodeURIComponent(actorId)}`, config.endpoint);
  if (config.namespace) url.searchParams.set("namespace", config.namespace);
  const headers = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const response = await fetch(url, { method: "DELETE", headers });
  if (!response.ok) {
    throw new Error(`mesh engine DELETE ${url.pathname} failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
}
function openInSystem(targetPath, isFile) {
  const opener = process.platform === "darwin" ? isFile ? ["open", "-t", targetPath] : ["open", targetPath] : process.platform === "win32" ? ["explorer", targetPath] : ["xdg-open", targetPath];
  import("node:child_process").then(({ spawn: spawn3 }) => {
    spawn3(opener[0], opener.slice(1), { detached: true, stdio: "ignore" }).unref();
  });
}
function startWatchers(xferDir, boardDir, publish) {
  const debounce = /* @__PURE__ */ new Map();
  const SKIP_JSON = /* @__PURE__ */ new Set(["broker.json", "admin.json", "mesh.config.json", "settings.json"]);
  const once = (key, fn, ms = 100) => {
    const existing = debounce.get(key);
    if (existing) clearTimeout(existing);
    debounce.set(key, setTimeout(() => {
      debounce.delete(key);
      fn();
    }, ms));
  };
  try {
    fs7.watch(xferDir, (_, filename) => {
      const name = filename ?? "";
      if (name === "broker.json" || name === "broker.pid") {
        once(`broker:${name}`, () => {
          const alive = fs7.existsSync(path8.join(xferDir, "broker.json"));
          publish({
            t: now(),
            kind: "broker",
            text: alive ? "broker is up" : "broker went down",
            detail: name
          });
        });
        return;
      }
      if (name.endsWith(".sock") || name.endsWith(".json") && !SKIP_JSON.has(name)) {
        const peerName = name.replace(/\.sock$/, "").replace(/\.json$/, "");
        once(`peer:${peerName}`, () => {
          const alive = fs7.existsSync(path8.join(xferDir, `${peerName}.sock`));
          publish({
            t: now(),
            kind: "peer",
            text: alive ? `${peerName} came online` : `${peerName} went offline`,
            detail: `${peerName}${alive ? " registered" : " unregistered"}`
          });
        });
      }
    });
  } catch {
  }
  try {
    fs7.mkdirSync(boardDir, { recursive: true });
    fs7.watch(boardDir, (_, filename) => {
      const name = filename ?? "";
      if (!name.endsWith(".md")) return;
      once(`board:${name}`, () => {
        const exists = fs7.existsSync(path8.join(boardDir, name));
        publish({
          t: now(),
          kind: "board",
          text: exists ? `card updated: ${name}` : `card removed: ${name}`,
          detail: name
        });
      });
    });
  } catch {
  }
}
function parseArgs(args) {
  let port = DEFAULT_ADMIN_PORT;
  let xferDir = XFER_DIR;
  let boardDir = path8.join(xferDir, "board");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") port = Number.parseInt(args[++i] ?? "", 10);
    else if (arg.startsWith("--port=")) port = Number.parseInt(arg.slice("--port=".length), 10);
    else if (arg === "--xfer-dir") xferDir = args[++i] ?? xferDir;
    else if (arg.startsWith("--xfer-dir=")) xferDir = arg.slice("--xfer-dir=".length);
    else if (arg === "--board-dir") boardDir = args[++i] ?? boardDir;
    else if (arg.startsWith("--board-dir=")) boardDir = arg.slice("--board-dir=".length);
  }
  return { port, xferDir, boardDir };
}
function isMainModule2() {
  return isEntryPoint(["admin-main.ts", "admin.cjs"]);
}
async function main() {
  const { port, xferDir, boardDir } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[admin] invalid port: ${port}`);
    process.exit(1);
  }
  let shutdownRequested = false;
  const { server, publish, setPort } = createAdminServer({
    xferDir,
    boardDir,
    // The web console's stop button shares the SIGTERM path: admin state is
    // unlinked (inside createAdminServer) before this teardown runs.
    shutdown: () => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1e3).unref();
    }
  });
  const listenOn = (p) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  let realPort;
  try {
    await listenOn(port);
    realPort = server.address().port;
  } catch (err) {
    const code = err.code;
    if (code !== "EADDRINUSE" || port === 0) {
      console.error(`[admin] bind failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    try {
      fs7.unlinkSync(path8.join(xferDir, "admin.pid"));
      fs7.unlinkSync(path8.join(xferDir, "admin.json"));
    } catch {
    }
    console.error(`[admin] port ${port} is occupied by another program — falling back to an ephemeral port`);
    try {
      await listenOn(0);
      realPort = server.address().port;
    } catch (fallbackError) {
      console.error(`[admin] bind failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      process.exit(1);
    }
  }
  setPort(realPort);
  fs7.mkdirSync(xferDir, { recursive: true, mode: 448 });
  fs7.writeFileSync(path8.join(xferDir, "admin.pid"), `${process.pid}
`, "utf-8");
  fs7.writeFileSync(
    path8.join(xferDir, "admin.json"),
    JSON.stringify({ port: realPort, pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString(), version: EXTENSION_VERSION }, null, 2),
    "utf-8"
  );
  startWatchers(xferDir, boardDir, publish);
  console.log(`[admin] listening on http://localhost:${realPort} (pid ${process.pid}, xfer-dir ${xferDir})`);
  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      fs7.unlinkSync(path8.join(xferDir, "admin.pid"));
      fs7.unlinkSync(path8.join(xferDir, "admin.json"));
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (isMainModule2()) {
  main().catch((error) => {
    console.error(`[admin] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_ADMIN_PORT,
  createAdminServer,
  main,
  startWatchers
});
