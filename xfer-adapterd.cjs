
globalThis.__meshLoadNapiBindings = async () => {
  const bindingsPath = globalThis.__meshNapiBindingsPath;
  if (typeof bindingsPath !== "string") {
    throw new Error("mesh: native runtime not prepared — /xfer mesh up must download the rivetkit addon first");
  }
  return require(bindingsPath);
};
globalThis.__meshLoadEngineCli = async () => {
  const entryPath = globalThis.__meshEngineCliEntry;
  if (typeof entryPath !== "string") {
    throw new Error("mesh: engine-cli not prepared — /xfer mesh up must download the rivetkit runtime first");
  }
  return require(entryPath);
};

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

// adapterd.src/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
module.exports = __toCommonJS(main_exports);
var fs4 = __toESM(require("node:fs"), 1);
var path5 = __toESM(require("node:path"), 1);

// client.ts
var fs = __toESM(require("node:fs"), 1);
var net = __toESM(require("node:net"), 1);

// constants.ts
var os = __toESM(require("node:os"), 1);
var path = __toESM(require("node:path"), 1);
var XFER_DIR = path.join(os.homedir(), ".pi", "xfer");
var MESH_CONFIG_PATH = path.join(XFER_DIR, "mesh.config.json");
var MESH_CACHE_DIR = path.join(XFER_DIR, "cache");
var CONNECT_TIMEOUT_MS = 5e3;
var ACK_TIMEOUT_MS = 5e3;
var MAX_FRAME_BYTES = 1024 * 1024;

// utils.ts
var path2 = __toESM(require("node:path"), 1);
function msgId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function encodeAgentName(name) {
  return encodeURIComponent(name);
}
function endpointForName(name, xferDir = XFER_DIR) {
  return path2.join(xferDir, `${encodeAgentName(name)}.sock`);
}
function metadataForName(name, xferDir = XFER_DIR) {
  return path2.join(xferDir, `${encodeAgentName(name)}.json`);
}
function isEntryPoint(names) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return names.includes(path2.basename(invoked));
}

// client.ts
function sendNotify(target, msg, xferDir) {
  return new Promise((resolve2, reject) => {
    const endpoint = endpointForName(target, xferDir);
    if (!fs.existsSync(endpoint)) {
      reject(new Error(`peer "${target}" not found`));
      return;
    }
    const sock = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    let ackTimer = null;
    const connectTimer = setTimeout(() => {
      finish(new Error("connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (ackTimer) clearTimeout(ackTimer);
      if (error) {
        sock.destroy();
        reject(error);
      } else {
        sock.end();
        resolve2();
      }
    };
    sock.on("connect", () => {
      clearTimeout(connectTimer);
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ackTimer = setTimeout(() => finish(new Error("ack timeout")), ACK_TIMEOUT_MS);
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf-8") > MAX_FRAME_BYTES) {
        finish(new Error("ack frame too large"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          finish(new Error("invalid ack"));
          return;
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          finish(new Error("invalid ack"));
          return;
        }
        const ack = response;
        if (ack.type === "ack" && ack.msg_id === msg.msg_id) {
          finish();
          return;
        }
      }
    });
    sock.on("error", (error) => finish(error));
    sock.on("close", () => {
      if (!settled) finish(new Error("peer closed before ack"));
    });
  });
}

// adapterd.src/daemon.ts
var fs3 = __toESM(require("node:fs"), 1);
var path4 = __toESM(require("node:path"), 1);
var import_node_child_process = require("node:child_process");

// server.ts
var net2 = __toESM(require("node:net"), 1);
function createServer2(delivery) {
  return net2.createServer((socket) => {
    let buf = "";
    socket.on("error", () => {
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (Buffer.byteLength(buf, "utf-8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (msg.type === "xfer-notify" && typeof msg.msg_id === "string") {
          delivery.deliver(msg);
          socket.write(JSON.stringify({ type: "ack", msg_id: msg.msg_id }) + "\n");
        }
      }
    });
  });
}

// adapterd.src/inbox.ts
var fs2 = __toESM(require("node:fs"), 1);
var path3 = __toESM(require("node:path"), 1);
function inboxPathForName(name, dir = XFER_DIR) {
  return path3.join(dir, `${encodeAgentName(name)}.inbox.jsonl`);
}
function appendInbox(record, inboxPath) {
  fs2.mkdirSync(path3.dirname(inboxPath), { recursive: true, mode: 448 });
  fs2.appendFileSync(inboxPath, `${JSON.stringify(record)}
`, { encoding: "utf-8", mode: 384 });
}
function parseInbox(content) {
  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}
function listInbox(inboxPath) {
  let content;
  try {
    content = fs2.readFileSync(inboxPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return parseInbox(content);
}
function takeInbox(inboxPath) {
  const taken = `${inboxPath}.take-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs2.renameSync(inboxPath, taken);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  try {
    return parseInbox(fs2.readFileSync(taken, "utf-8"));
  } finally {
    fs2.rmSync(taken, { force: true });
  }
}

// adapterd.src/daemon.ts
async function startAdapterd(options) {
  const name = options.name;
  const dir = options.dir ?? XFER_DIR;
  const endpoint = endpointForName(name, dir);
  const metadataPath = metadataForName(name, dir);
  const inboxPath = inboxPathForName(name, dir);
  const startedAt = Date.now();
  fs3.mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    fs3.chmodSync(dir, 448);
  } catch {
  }
  for (const stale of [endpoint, metadataPath]) {
    try {
      fs3.unlinkSync(stale);
    } catch {
    }
  }
  const handoffChildren = /* @__PURE__ */ new Set();
  let closed = false;
  const writeMetadata = () => {
    const metadata = {
      xferName: name,
      sessionName: `${options.host ?? "generic"} adapter`,
      cwd: process.cwd(),
      model: "adapterd",
      status: "idle",
      pid: process.pid,
      startedAt,
      kind: "adapterd",
      host: options.host ?? "generic",
      inbox: inboxPath
    };
    const serialized = `${JSON.stringify(metadata, null, 2)}
`;
    const temp = `${metadataPath}.tmp-${process.pid}`;
    try {
      fs3.writeFileSync(temp, serialized, { encoding: "utf-8", mode: 384 });
      fs3.renameSync(temp, metadataPath);
      try {
        fs3.chmodSync(metadataPath, 384);
      } catch {
      }
    } catch {
      try {
        fs3.unlinkSync(temp);
      } catch {
      }
    }
  };
  const spawnHandoff = (record) => {
    if (!options.onHandoff) return;
    let child;
    try {
      child = (0, import_node_child_process.spawn)(options.onHandoff, {
        shell: true,
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          ...process.env,
          XFER_HANDOFF_ID: record.id,
          XFER_HANDOFF_FROM: record.from,
          XFER_HANDOFF_FILE: record.file
        }
      });
    } catch (err) {
      console.error(`[xfer-adapterd] --on-handoff failed to spawn: ${errorText(err)}`);
      return;
    }
    const done = new Promise((resolve2) => {
      child.on("error", () => resolve2());
      child.on("close", () => resolve2());
    }).then(() => {
      handoffChildren.delete(done);
    });
    handoffChildren.add(done);
    child.stdin?.on("error", () => {
    });
    try {
      child.stdin?.end(JSON.stringify(record));
    } catch (err) {
      console.error(`[xfer-adapterd] --on-handoff stdin failed: ${errorText(err)}`);
    }
  };
  const delivered = (msg, transport) => {
    let document = null;
    try {
      document = fs3.readFileSync(msg.file, "utf-8");
    } catch {
      document = null;
    }
    const record = {
      id: msg.msg_id,
      from: msg.from,
      to: name,
      summary: msg.summary,
      file: msg.file,
      document,
      transport,
      received_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      appendInbox(record, inboxPath);
    } catch (err) {
      console.error(`[xfer-adapterd] inbox append failed for ${record.id}: ${errorText(err)}`);
      return;
    }
    spawnHandoff(record);
    if (options.once && !closed) {
      closed = true;
      setImmediate(() => {
        void close().then(() => options.onOnce?.());
      });
    }
  };
  const server = createServer2({ deliver: (msg) => delivered(msg, "local") });
  await listen(server, endpoint);
  writeMetadata();
  const close = async () => {
    if (!closed) closed = true;
    try {
      await new Promise((resolve2) => server.close(() => resolve2()));
    } catch {
    }
    try {
      server.closeAllConnections?.();
    } catch {
    }
    try {
      fs3.unlinkSync(endpoint);
    } catch {
    }
    try {
      fs3.unlinkSync(metadataPath);
    } catch {
    }
    await Promise.all([...handoffChildren]);
  };
  return {
    name,
    endpoint,
    metadataPath,
    inboxPath,
    pendingHandoffs: () => Promise.all([...handoffChildren]).then(() => void 0),
    close
  };
}
function listen(server, endpoint) {
  return new Promise((resolve2, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      try {
        fs3.chmodSync(endpoint, 384);
      } catch {
      }
      resolve2();
    });
    server.listen(endpoint);
  });
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
function defaultAdapterName(cwd = process.cwd()) {
  const base = path4.basename(cwd).trim() || "host";
  return `agent-${base}`;
}

// adapterd.src/main.ts
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === void 0) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== void 0 && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function log(message) {
  process.stdout.write(`${message}
`);
}
function fail(message) {
  process.stderr.write(`${message}
`);
  process.exitCode = 1;
}
var USAGE = `xfer-adapterd — adapt a non-pi Agent Host to the xfer network

  xfer-adapterd up [--name N] [--on-handoff CMD] [--once] [--dir D] [--mesh ...]
  xfer-adapterd send <target> <file> <summary> [--from N] [--dir D]
  xfer-adapterd mesh send <target> <file> <summary> [--from N] [--mesh-config P]
  xfer-adapterd inbox take|list [--name N] [--dir D] [--inbox P]
  xfer-adapterd install --host <cursor|generic> --into <dir> [--name N]`;
async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv);
  const [command, sub] = positionals;
  if (command === "up") {
    await runUp(positionals.slice(1), flags);
    return;
  }
  if (command === "send") {
    await runSend(positionals.slice(1), flags);
    return;
  }
  if (command === "inbox") {
    runInbox(sub, flags);
    return;
  }
  fail(USAGE);
}
async function runUp(argv, flags) {
  if (argv.length > 0) {
    fail(USAGE);
    return;
  }
  const name = str(flags.name) ?? defaultAdapterName();
  const dir = str(flags.dir) ?? XFER_DIR;
  const onHandoff = str(flags["on-handoff"]);
  const once = flags.once === true;
  let handle = null;
  let signals = 0;
  let armed = false;
  const shutdown = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    if (!handle) {
      armed = true;
      return;
    }
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    handle = await startAdapterd({
      name,
      dir,
      host: str(flags.host) ?? "generic",
      onHandoff,
      once,
      onOnce: () => process.exit(0)
    });
  } catch (err) {
    fail(`❌ xfer-adapterd up failed: ${errorText2(err)}`);
    return;
  }
  log(`🟢 xfer-adapterd up as "${handle.name}" — ${handle.endpoint}`);
  log(`   inbox: ${handle.inboxPath}${onHandoff ? `
   on-handoff: ${onHandoff}` : ""}`);
  if (armed) shutdown();
}
async function runSend(argv, flags) {
  const { target, file, summary } = splitSendArgs(argv);
  if (!target || !file || !summary) {
    fail(`Usage: xfer-adapterd send <target> <file> <summary>`);
    return;
  }
  if (!fs4.existsSync(file)) {
    fail(`❌ handoff file not found: ${file}`);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  const from = str(flags.from) ?? defaultAdapterName();
  const id = msgId();
  try {
    await sendNotify(target, {
      type: "xfer-notify",
      msg_id: id,
      from,
      file: path5.resolve(file),
      summary
    }, dir);
    log(id);
  } catch (err) {
    fail(`❌ send to "${target}" failed: ${errorText2(err)}`);
  }
}
function splitSendArgs(argv) {
  const [target, file, ...rest] = argv;
  return { target, file, summary: rest.join(" ").trim() || void 0 };
}
function runInbox(sub, flags) {
  if (sub !== "take" && sub !== "list") {
    fail(USAGE);
    return;
  }
  const dir = str(flags.dir) ?? XFER_DIR;
  let inboxPath;
  try {
    inboxPath = str(flags.inbox) ?? resolveInboxPath(dir, str(flags.name));
  } catch (err) {
    fail(`❌ ${errorText2(err)}`);
    return;
  }
  let records;
  try {
    records = sub === "take" ? takeInbox(inboxPath) : listInbox(inboxPath);
  } catch (err) {
    fail(`❌ inbox ${sub} failed: ${errorText2(err)}`);
    return;
  }
  for (const record of records) log(JSON.stringify(record));
}
function resolveInboxPath(dir, name) {
  if (name) return inboxPathForName(name, dir);
  let entries;
  try {
    entries = fs4.readdirSync(dir);
  } catch {
    throw new Error(`no adapter daemon found in ${dir} — start one with \`xfer-adapterd up\` or pass --name/--inbox`);
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs4.readFileSync(path5.join(dir, entry), "utf-8"));
      if (value.kind === "adapterd" && typeof value.inbox === "string") found.push(value.inbox);
    } catch {
    }
  }
  if (found.length === 0) throw new Error(`no adapter daemon found in ${dir} — start one with \`xfer-adapterd up\` or pass --name/--inbox`);
  if (found.length > 1) throw new Error(`multiple adapter daemons in ${dir} — pass --name or --inbox`);
  return found[0];
}
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
if (isEntryPoint(["xfer-adapterd.cjs", "main.ts"])) {
  main().catch((err) => {
    fail(`❌ xfer-adapterd: ${errorText2(err)}`);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main
});
