
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

// admin-main.ts
var admin_main_exports = {};
__export(admin_main_exports, {
  DEFAULT_ADMIN_PORT: () => DEFAULT_ADMIN_PORT,
  createAdminServer: () => createAdminServer,
  main: () => main2,
  startWatchers: () => startWatchers
});
module.exports = __toCommonJS(admin_main_exports);
var fs8 = __toESM(require("node:fs"), 1);
var http2 = __toESM(require("node:http"), 1);
var path8 = __toESM(require("node:path"), 1);

// board.ts
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

// broker-manager.ts
var import_node_child_process = require("node:child_process");
var fs6 = __toESM(require("node:fs"), 1);
var net2 = __toESM(require("node:net"), 1);
var path6 = __toESM(require("node:path"), 1);

// utils.ts
var fs2 = __toESM(require("node:fs"), 1);
var path3 = __toESM(require("node:path"), 1);

// constants.ts
var os2 = __toESM(require("node:os"), 1);
var path2 = __toESM(require("node:path"), 1);
var XFER_DIR = path2.join(os2.homedir(), ".pi", "xfer");
var MESH_CONFIG_PATH = path2.join(XFER_DIR, "mesh.config.json");
var MESH_CACHE_DIR = path2.join(XFER_DIR, "cache");
var CONNECT_TIMEOUT_MS = 5e3;
var ACK_TIMEOUT_MS = 5e3;
var MAX_FRAME_BYTES = 1024 * 1024;
var MESH_PROBE_TIMEOUT_MS = 2500;

// utils.ts
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
  return path3.join(xferDir, `${encodeAgentName(name)}.sock`);
}
function isEntryPoint(names) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return names.includes(path3.basename(invoked));
}
function readPeerMetadata(xferName, xferDir = XFER_DIR) {
  try {
    const raw = JSON.parse(fs2.readFileSync(path3.join(xferDir, `${encodeAgentName(xferName)}.json`), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const value = raw;
    return {
      ...typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {},
      ...typeof value.cwd === "string" ? { cwd: value.cwd } : {},
      ...typeof value.model === "string" ? { model: value.model } : {},
      ...typeof value.status === "string" ? { status: value.status } : {},
      ...typeof value.pid === "number" ? { pid: value.pid } : {},
      ...typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}
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
    fs2.mkdirSync(xferDir, { recursive: true, mode: 448 });
    const names = fs2.readdirSync(xferDir).filter((f) => f.endsWith(".sock")).map((f) => decodeAgentName(f.replace(/\.sock$/, ""))).filter((n) => n !== myName);
    return [...new Set(names)].map((xferName) => ({
      xferName,
      endpoint: endpointForName(xferName),
      ...readPeerMetadata(xferName, xferDir)
    })).sort((a, b) => a.xferName.localeCompare(b.xferName));
  } catch {
    return [];
  }
}

// broker-main.ts
var fs5 = __toESM(require("node:fs"), 1);
var http = __toESM(require("node:http"), 1);
var net = __toESM(require("node:net"), 1);
var os3 = __toESM(require("node:os"), 1);
var path5 = __toESM(require("node:path"), 1);

// wire.ts
var WIRE_VERSION = 0;
var WIRE = {
  V: WIRE_VERSION,
  KIND_HELLO: "hello",
  KIND_WELCOME: "welcome",
  KIND_ACK: "ack",
  KIND_ERROR: "error",
  KIND_SUBMIT: "annotation.submit",
  KIND_COMPOSE: "annotation.compose",
  KIND_TARGETS_LIST: "targets.list",
  KIND_TARGETS_RESULT: "targets.result",
  KIND_PAGE_REQUEST: "page.request",
  KIND_PAGE_RESPONSE: "page.response",
  NS_LOCAL: "local"
};
var PAGE_OPS = {
  INFO: "page.info",
  DOM_QUERY: "dom.query",
  DOM_HTML: "dom.html",
  CONSOLE_LOGS: "console.logs",
  NETWORK_LOG: "network.log",
  SSE_LOG: "network.sse",
  FRAMEWORK_INSPECT: "framework.inspect",
  DOM_CLICK: "dom.click",
  DOM_SET_VALUE: "dom.setValue",
  PAGE_WAIT: "page.wait"
};
var PAGE_OP_KINDS = {
  [PAGE_OPS.INFO]: "read",
  [PAGE_OPS.DOM_QUERY]: "read",
  [PAGE_OPS.DOM_HTML]: "read",
  [PAGE_OPS.CONSOLE_LOGS]: "read",
  [PAGE_OPS.NETWORK_LOG]: "read",
  [PAGE_OPS.SSE_LOG]: "read",
  [PAGE_OPS.FRAMEWORK_INSPECT]: "read",
  [PAGE_OPS.DOM_CLICK]: "write",
  [PAGE_OPS.DOM_SET_VALUE]: "write",
  [PAGE_OPS.PAGE_WAIT]: "read"
};
var ERR = {
  AUTH_FAILED: "auth_failed",
  INVALID_PAYLOAD: "invalid_payload",
  BAD_TARGET: "bad_target",
  TARGET_NOT_FOUND: "target_not_found",
  DELIVERY_FAILED: "delivery_failed",
  UNSUPPORTED_VERSION: "unsupported_version"
};
var FROM_WEB_PICKER = "web-picker";

// handoff-doc.ts
function followUpSection(fromTarget, brokerCliPath) {
  const target = fromTarget?.trim() ? fromTarget.trim() : "<session-socket>";
  const cli = brokerCliPath?.trim() ? brokerCliPath.trim() : "broker-main.ts";
  return [
    "## Follow-up channel",
    "",
    "The sending browser tab is still online. Collect page data by calling its fixed tool ops via the broker CLI — the command waits and prints the result JSON on stdout:",
    `\`node ${cli} page-tool ${target} <op> [paramsJSON]\``,
    "Ops (fixed table): page.info · dom.query {selector, maxCount?, styleProps?} · dom.html {selector?, maxLength?, maxDepth?} · console.logs {lastN?, sinceTs?, level?} · network.log {lastN?, urlFilter?} · framework.inspect {selector, props?, maxDepth?} · page.wait {selector} (read) · dom.click {selector} / dom.setValue {selector, value} (write — only when the origin has page-write authorization; a refusal answers denied_op). Example:",
    `\`node ${cli} page-tool ${target} dom.query '{"selector":"button.primary","maxCount":5}'\``,
    "A timeout or no_tabs exits 1 with an error on stderr — after a page reload wait a few seconds for the userscript auto-reconnect and retry (≤3 times). Multiple calls may be issued in parallel. After changing code, verify by re-querying: dom.query the target elements and check console.logs for new errors."
  ];
}
function field(name, value) {
  return `- ${name}: ${value}`.trimEnd();
}
function attrsField(pick) {
  if (!pick.attributes) return null;
  const entries = Object.entries(pick.attributes).slice(0, 20);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => value ? `${key}="${value}"` : key).join(" ");
}
function pickSection(pick) {
  const lines = [
    `### ${pick.selector}`,
    "",
    field("xpath", pick.xpath),
    field("text", pick.textPreview ?? "")
  ];
  const attrs = attrsField(pick);
  if (attrs) lines.push(field("attrs", attrs));
  lines.push(
    field("rect", `x=${pick.rect.x} y=${pick.rect.y} w=${pick.rect.w} h=${pick.rect.h}`),
    field("note", pick.note ?? "")
  );
  if (pick.group) lines.push(field("group", pick.group));
  if (pick.source) lines.push(field("source", `${pick.source.file}:${pick.source.line}`));
  lines.push("");
  return lines;
}
function recordEventLine(ev) {
  const parts = [`+\`${ev.t}ms\``, `\`${ev.kind}\``];
  if (ev.sel) parts.push(`\`${ev.sel}\``);
  if (ev.kind === "input" && ev.value !== void 0) parts.push(`value=\`${ev.value}\``);
  if (ev.kind === "key" && ev.key) parts.push(`key=\`${ev.key}\``);
  if (ev.kind === "nav" && ev.to) parts.push(`→ ${ev.to}`);
  if (ev.text) parts.push(`— "${ev.text}"`);
  if (ev.ref) parts.push(`(pick #${ev.ref})`);
  return `- ${parts.join(" ")}`;
}
var RECORD_SCENE_MAX = 40;
function recordSection(rec) {
  const lines = [
    "## Operation timeline",
    "",
    field("record", rec.id),
    field(
      "span",
      `${rec.start}${rec.end ? ` → ${rec.end}` : ""} (${new Date(rec.start).toISOString()}${rec.end ? ` → ${new Date(rec.end).toISOString()}` : ""})`
    ),
    field("url", rec.url1 && rec.url1 !== rec.url0 ? `${rec.url0} → ${rec.url1}` : rec.url0 ?? ""),
    "",
    "The user reproduced the problem by hand while the picker recorded. Events are ordered (`seq`) with millisecond offsets (`t`); `input` values are final field values (passwords masked).",
    "",
    ...rec.events.map(recordEventLine),
    ""
  ];
  if (rec.net && rec.net.length) {
    lines.push("### Network (window slice)", "");
    for (const n of rec.net.slice(-RECORD_SCENE_MAX)) {
      const status = n.pending ? "pending" : String(n.status ?? "?");
      const sse = n.kind === "sse" ? ` sse${n.msgs !== void 0 ? ` msgs=${n.msgs}` : ""}` : "";
      const dur = n.durationMs !== void 0 ? ` ${n.durationMs}ms` : "";
      lines.push(`- ${n.method ?? "?"} ${n.url ?? "?"} → ${status}${sse}${dur}${n.error ? ` error="${n.error}"` : ""}`);
    }
    lines.push("");
  }
  if (rec.console && rec.console.length) {
    lines.push("### Console (window slice)", "");
    for (const c of rec.console.slice(-RECORD_SCENE_MAX)) {
      lines.push(`- [${c.level ?? "log"}] ${c.text ?? ""}`);
    }
    lines.push("");
  }
  return lines;
}
function renderHandoffDoc({ msgId, prompt, page: page2, picks, record, fromTarget, brokerCliPath }) {
  const lines = [
    "# Web annotation handoff",
    "",
    "## Request",
    "",
    prompt,
    "",
    "## Page",
    "",
    field("url", page2.url),
    field("title", page2.title),
    field("ts", `${page2.ts} (${new Date(page2.ts).toISOString()})`),
    "",
    "## Annotations",
    ""
  ];
  for (const pick of picks) lines.push(...pickSection(pick));
  if (record) lines.push(...recordSection(record));
  lines.push(...followUpSection(fromTarget, brokerCliPath), "");
  lines.push(
    "---",
    "",
    // Identity note: the sender is never a replyable xfer peer — point the
    // agent at the page-tool channel instead of an xfer_to that cannot succeed.
    `from: ${FROM_WEB_PICKER} (browser userscript — not an agent, no reply socket; query the page via the Follow-up channel above)`,
    `handoff_id: ${msgId}`
  );
  return lines.join("\n") + "\n";
}

// mesh-config.ts
var fs3 = __toESM(require("node:fs"), 1);
var XFER_INSTANCE_ACTOR = "xfer-instance";
function parseMeshConfig(raw) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mesh config must be a JSON object");
  }
  const obj = raw;
  if (typeof obj.endpoint !== "string" || obj.endpoint.trim() === "") {
    throw new Error('mesh config needs a non-empty "endpoint"');
  }
  const config = { endpoint: obj.endpoint.trim() };
  if (typeof obj.namespace === "string" && obj.namespace !== "") config.namespace = obj.namespace;
  if (typeof obj.token === "string" && obj.token !== "") config.token = obj.token;
  if (obj.pool !== void 0) {
    if (typeof obj.pool !== "string" || obj.pool.trim() === "") {
      throw new Error('mesh config "pool" must be a non-empty string');
    }
    config.pool = obj.pool.trim();
  }
  return withUrlAuth(config);
}
function withUrlAuth(config) {
  try {
    const url = new URL(config.endpoint);
    if (url.username || url.password) {
      if (config.namespace || config.token) {
        throw new Error(
          "mesh config sets credentials twice — namespace/token fields AND URL userinfo (https://ns:token@host). Keep exactly one; a stale placeholder in either would otherwise win silently"
        );
      }
      config.namespace = decodeURIComponent(url.username);
      config.token = decodeURIComponent(url.password);
      url.username = "";
      url.password = "";
      config.endpoint = url.toString();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("credentials twice")) throw err;
  }
  return config;
}
function loadMeshConfig(configPath) {
  let text;
  try {
    text = fs3.readFileSync(configPath, "utf-8");
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

// mesh-describer.ts
var DESCRIBE_TIMEOUT_MS = 5e3;
var GET_DESCRIPTION_ACTION = "getDescription";
function createMeshDescriber(configPath) {
  let pending = null;
  const client = () => pending ??= connect(configPath);
  return async (name) => {
    const handle = await client();
    if (!handle) return void 0;
    const description = await handle.client.get(XFER_INSTANCE_ACTOR, [name]).action({ name: GET_DESCRIPTION_ACTION, args: [], signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS) });
    return typeof description === "string" && description.trim() !== "" ? description : void 0;
  };
}
async function connect(configPath) {
  try {
    const config = loadMeshConfig(configPath);
    const specifier = ["rivetkit", "client"].join("/");
    const { createClient } = await import(specifier);
    return { client: createClient({ endpoint: config.endpoint, namespace: config.namespace, token: config.token }) };
  } catch {
    return null;
  }
}

// targets.ts
var fs4 = __toESM(require("node:fs"), 1);
var path4 = __toESM(require("node:path"), 1);
var NULL_METADATA = { sessionName: null, cwd: null, status: null };
function readSiblingMetadata(metadataPath) {
  try {
    const raw = JSON.parse(fs4.readFileSync(metadataPath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NULL_METADATA;
    const value = raw;
    return {
      sessionName: typeof value.sessionName === "string" ? value.sessionName : null,
      cwd: typeof value.cwd === "string" ? value.cwd : null,
      status: typeof value.status === "string" ? value.status : null,
      ...typeof value.description === "string" && value.description.trim() !== "" ? { description: value.description } : {}
    };
  } catch {
    return NULL_METADATA;
  }
}
function listTargets(xferDir = XFER_DIR) {
  let entries;
  try {
    entries = fs4.readdirSync(xferDir);
  } catch {
    return [];
  }
  return entries.filter((file) => file.endsWith(".sock")).map((sockFile) => {
    const base = sockFile.replace(/\.sock$/, "");
    return { name: decodeAgentName(base), ...readSiblingMetadata(path4.join(xferDir, `${base}.json`)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
async function listTargetsWithDescriptions(xferDir = XFER_DIR, describe) {
  const targets = listTargets(xferDir);
  if (!describe) return targets;
  return Promise.all(
    targets.map(async (target) => {
      let description;
      try {
        description = await describe(target.name);
      } catch {
        description = void 0;
      }
      const trimmed = description?.trim();
      return trimmed ? { ...target, description: trimmed } : target;
    })
  );
}

// ws-server.ts
var crypto = __toESM(require("node:crypto"), 1);
var OPCODE_TEXT = 1;
var OPCODE_CLOSE = 8;
var OPCODE_PING = 9;
var OPCODE_PONG = 10;
var WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var DEFAULT_PING_INTERVAL_MS = 3e4;
var MISSED_PONG_LIMIT = 2;
function acceptKey(key) {
  const digest = crypto.createHash("sha1").update(key + WS_GUID).digest();
  return digest.toString("base64");
}
function encodeFrame(opcode, payload) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`payload exceeds MAX_FRAME_BYTES (${data.length} > ${MAX_FRAME_BYTES})`);
  }
  const first = 128 | opcode;
  let header;
  if (data.length < 126) {
    header = Buffer.from([first, data.length]);
  } else if (data.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  return Buffer.concat([header, data]);
}
function decodeFrame(buffer) {
  if (buffer.length < 2) throw new Error("incomplete frame: need at least 2 header bytes");
  const fin = (buffer[0] & 128) !== 0;
  const opcode = buffer[0] & 15;
  const masked = (buffer[1] & 128) !== 0;
  let len7 = buffer[1] & 127;
  let offset = 2;
  if (len7 === 126) {
    if (buffer.length < 4) throw new Error("incomplete frame: missing 16-bit length");
    len7 = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len7 === 127) {
    if (buffer.length < 10) throw new Error("incomplete frame: missing 64-bit length");
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0 || low > MAX_FRAME_BYTES) {
      throw new Error(`payload exceeds MAX_FRAME_BYTES (${low} > ${MAX_FRAME_BYTES})`);
    }
    len7 = low;
    offset = 10;
  }
  if (len7 > MAX_FRAME_BYTES) {
    throw new Error(`payload exceeds MAX_FRAME_BYTES (${len7} > ${MAX_FRAME_BYTES})`);
  }
  let maskKey;
  if (masked) {
    if (buffer.length < offset + 4) throw new Error("incomplete frame: missing mask key");
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len7) throw new Error("incomplete frame: payload truncated");
  let payload = buffer.subarray(offset, offset + len7);
  if (masked && maskKey) {
    const unmasked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) {
      unmasked[i] = payload[i] ^ maskKey[i & 3];
    }
    payload = unmasked;
  }
  return { fin, opcode, masked, payload };
}
function createParser() {
  return { buffer: Buffer.alloc(0) };
}
function pumpFrames(parser, chunk, onFrame) {
  parser.buffer = Buffer.concat([parser.buffer, chunk]);
  for (; ; ) {
    const buf = parser.buffer;
    if (buf.length < 2) return true;
    let headerLen;
    const len7 = buf[1] & 127;
    if (len7 === 126) headerLen = 4;
    else if (len7 === 127) headerLen = 10;
    else headerLen = 2;
    if (buf.length < headerLen) return true;
    const frameLen = headerLen + (len7 === 126 ? buf.readUInt16BE(2) : len7 === 127 ? buf.readUInt32BE(6) : len7) + ((buf[1] & 128) !== 0 ? 4 : 0);
    if (buf.length < frameLen) return true;
    let frame;
    try {
      frame = decodeFrame(buf.subarray(0, frameLen));
    } catch {
      return false;
    }
    parser.buffer = buf.subarray(frameLen);
    if (onFrame(frame) === false) return true;
  }
}
function attachWsServer(httpServer, options) {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  httpServer.on("upgrade", (request2, socket, head) => {
    const url = request2.url ?? "";
    const pathOnly = url.split("?")[0];
    if (pathOnly !== "/ws") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request2.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${acceptKey(key)}\r
\r
`
    );
    let closed = false;
    let missedPongs = 0;
    const parser = createParser();
    if (head.length > 0) socket.unshift(head);
    const connection = {
      send(message) {
        if (closed || socket.destroyed) return;
        const data = typeof message === "string" ? message : message instanceof Buffer ? message : JSON.stringify(message);
        try {
          socket.write(encodeFrame(OPCODE_TEXT, data));
        } catch {
          teardown();
        }
      },
      close(code = 1e3) {
        if (closed) return;
        try {
          const body = Buffer.alloc(2);
          body.writeUInt16BE(code, 0);
          socket.write(encodeFrame(OPCODE_CLOSE, body));
        } catch {
        }
        teardown();
      }
    };
    function teardown() {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      try {
        socket.end();
      } catch {
        socket.destroy();
      }
      if (options.onClose) options.onClose(connection);
    }
    const pingTimer = setInterval(() => {
      if (closed || socket.destroyed) return;
      if (missedPongs >= MISSED_PONG_LIMIT) {
        teardown();
        return;
      }
      try {
        socket.write(encodeFrame(OPCODE_PING, Buffer.alloc(0)));
      } catch {
        teardown();
        return;
      }
      missedPongs++;
    }, pingIntervalMs);
    if (typeof pingTimer.unref === "function") pingTimer.unref();
    options.onConnection(connection);
    socket.on("data", (chunk) => {
      const ok = pumpFrames(parser, chunk, (frame) => {
        switch (frame.opcode) {
          case OPCODE_TEXT: {
            let message;
            try {
              message = JSON.parse(frame.payload.toString("utf-8"));
            } catch {
              return;
            }
            if (options.onMessage) options.onMessage(connection, message);
            return;
          }
          case OPCODE_PING:
            if (!closed) {
              try {
                socket.write(encodeFrame(OPCODE_PONG, frame.payload));
              } catch {
              }
            }
            return;
          case OPCODE_PONG:
            missedPongs = 0;
            return;
          case OPCODE_CLOSE:
            connection.close(1e3);
            return false;
          // stop parsing after close
          default:
            return;
        }
      });
      if (!ok) {
        console.log("[ws] dropping connection: inbound frame exceeds MAX_FRAME_BYTES");
        connection.close(1009);
      }
    });
    socket.on("error", () => {
      if (!closed) teardown();
    });
    socket.on("close", () => {
      if (!closed) teardown();
    });
  });
}

// broker-main.ts
var VERSION = (() => {
  try {
    return JSON.parse(fs5.readFileSync(path5.join(__dirname, "package.json"), "utf-8")).version ?? "?";
  } catch {
    return "?";
  }
})();
var PROTOCOL_VERSION = WIRE_VERSION;
var {
  KIND_HELLO: WIRE_HELLO,
  KIND_WELCOME: WIRE_WELCOME,
  KIND_ERROR: WIRE_ERROR,
  KIND_ACK: WIRE_ACK,
  KIND_SUBMIT: WIRE_ANNOTATION_SUBMIT,
  KIND_COMPOSE: WIRE_ANNOTATION_COMPOSE,
  KIND_TARGETS_LIST: WIRE_TARGETS_LIST,
  KIND_TARGETS_RESULT: WIRE_TARGETS_RESULT,
  KIND_PAGE_REQUEST: WIRE_PAGE_REQUEST,
  KIND_PAGE_RESPONSE: WIRE_PAGE_RESPONSE,
  NS_LOCAL: WIRE_NAMESPACE_LOCAL
} = WIRE;
var WIRE_XFER_NOTIFY = "xfer-notify";
var WIRE_MSG_ID_PREFIX = "m";
var {
  AUTH_FAILED: ERR_AUTH_FAILED,
  INVALID_PAYLOAD: ERR_INVALID_PAYLOAD,
  BAD_TARGET: ERR_BAD_TARGET,
  TARGET_NOT_FOUND: ERR_TARGET_NOT_FOUND,
  DELIVERY_FAILED: ERR_DELIVERY_FAILED,
  UNSUPPORTED_VERSION: ERR_UNSUPPORTED_VERSION
} = ERR;
var DEFAULT_PORT = 4719;
var HOST = "127.0.0.1";
function parseArgs(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] !== void 0 ? argv[index + 1] : void 0;
  };
  const portRaw = flag("--port") ?? process.env.BROKER_PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(portRaw, 10);
  const xferDir = flag("--xfer-dir") ?? process.env.XFER_DIR ?? XFER_DIR;
  return { port, xferDir };
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function writeFileAtomic(filePath, content) {
  const temp = `${filePath}.tmp-${process.pid}`;
  try {
    fs5.writeFileSync(temp, content, { encoding: "utf-8", mode: 384 });
    fs5.renameSync(temp, filePath);
    try {
      fs5.chmodSync(filePath, 384);
    } catch {
    }
  } catch (error) {
    try {
      fs5.unlinkSync(temp);
    } catch {
    }
    throw error;
  }
}
function readPidFile(xferDir) {
  try {
    const raw = fs5.readFileSync(path5.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function unlinkBrokerFiles(xferDir) {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs5.unlinkSync(path5.join(xferDir, name));
    } catch {
    }
  }
}
function writeBrokerFiles(xferDir, port, startedAt) {
  writeFileAtomic(path5.join(xferDir, "broker.pid"), `${process.pid}
`);
  writeFileAtomic(
    path5.join(xferDir, "broker.json"),
    `${JSON.stringify({ port, pid: process.pid, startedAt, version: VERSION }, null, 2)}
`
  );
}
function frameId(frame) {
  return typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : null;
}
function sendError(connection, frame, code, message) {
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_ERROR, id: frameId(frame), code, message });
}
function tabFromFrame(frame) {
  const client = frame.client;
  const tab = typeof client === "object" && client !== null ? client.tab : void 0;
  return typeof tab === "object" && tab !== null ? tab : {};
}
var frameHandlers = {};
var activeConns = null;
var submitSeq = 0;
function nextMsgId() {
  return `${WIRE_MSG_ID_PREFIX}${Date.now().toString(36)}${(submitSeq++).toString(36)}`;
}
function nextRequestId() {
  return `r${Date.now().toString(36)}${(submitSeq++).toString(36)}`;
}
function pushXferNotify(xferDir, target, msg) {
  return new Promise((resolve, reject) => {
    const endpoint = path5.join(xferDir, `${encodeAgentName(target)}.sock`);
    if (!fs5.existsSync(endpoint)) {
      reject(Object.assign(new Error(`peer "${target}" not found`), { code: ERR_TARGET_NOT_FOUND }));
      return;
    }
    const sock = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    let ackTimer = null;
    const connectTimer = setTimeout(() => finish(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (ackTimer) clearTimeout(ackTimer);
      if (error) {
        sock.destroy();
        reject(Object.assign(error, { code: ERR_DELIVERY_FAILED }));
      } else {
        sock.end();
        resolve();
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
        if (ack.type === WIRE_ACK && ack.msg_id === msg.msg_id) {
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
function handleAnnotationSubmit(connection, frame, xferDir) {
  const id = frameId(frame);
  const prompt = frame.prompt;
  const picks = frame.picks;
  const record = parseRecord(frame.record);
  const target = typeof frame.target === "object" && frame.target !== null ? frame.target : null;
  const missing = [];
  if (typeof prompt !== "string" || prompt.trim() === "") missing.push("prompt");
  if (!Array.isArray(picks)) missing.push("picks");
  const targetName = target?.name;
  if (typeof targetName !== "string" || targetName.trim() === "") missing.push("target.name");
  if (missing.length > 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `missing or invalid: ${missing.join(", ")}`);
    return;
  }
  if (record === null && frame.record !== void 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "malformed record: expected {id, start, events:[{seq,t,kind}...]}");
    return;
  }
  const namespace = target?.namespace;
  if (namespace !== void 0 && namespace !== WIRE_NAMESPACE_LOCAL) {
    sendError(connection, frame, ERR_BAD_TARGET, `namespace "${String(namespace)}" out of scope (v0: local only)`);
    return;
  }
  const msgId = nextMsgId();
  const doc = path5.join(os3.tmpdir(), `pi-xfer-${msgId}.md`);
  const pageRaw = typeof frame.page === "object" && frame.page !== null ? frame.page : {};
  const page2 = {
    url: typeof pageRaw.url === "string" ? pageRaw.url : "",
    title: typeof pageRaw.title === "string" ? pageRaw.title : "",
    ts: typeof pageRaw.ts === "number" ? pageRaw.ts : Date.now()
  };
  let content;
  try {
    content = renderHandoffDoc({
      msgId,
      prompt,
      page: page2,
      picks,
      record: record ?? void 0,
      // The receiving session's own xfer name: makes the doc's page-tool
      // follow-up command directly runnable (compose passes it too — the two
      // render paths must not drift).
      fromTarget: targetName,
      brokerCliPath: path5.join(__dirname, "broker-main.ts")
    });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed picks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    fs5.writeFileSync(doc, content, { mode: 384 });
  } catch (error) {
    sendError(connection, frame, ERR_DELIVERY_FAILED, `cannot write doc: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log(`[doc] ${doc} (${picks.length} picks${record ? ` + record ${record.id} (${record.events.length} events)` : ""} → local:${targetName})`);
  latestHandoffByTarget.set(targetName, msgId);
  const submittingTab = activeConns?.get(connection);
  if (submittingTab && typeof submittingTab.id === "string" && submittingTab.id !== "") {
    latestTabIdByTarget.set(targetName, submittingTab.id);
  }
  void pushXferNotify(xferDir, targetName, {
    type: WIRE_XFER_NOTIFY,
    msg_id: msgId,
    from: FROM_WEB_PICKER,
    file: doc,
    summary: prompt.slice(0, 120)
  }).then(() => {
    connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id, result: { handoff_id: msgId, doc } });
    console.log(`[xfer] delivered to ${targetName}`);
  }).catch((error) => {
    const code = error.code === ERR_TARGET_NOT_FOUND ? ERR_TARGET_NOT_FOUND : ERR_DELIVERY_FAILED;
    const message = error instanceof Error ? error.message : String(error);
    sendError(connection, frame, code, message);
    console.log(`[xfer] FAILED: ${message} (doc kept at ${doc})`);
  });
}
function handleAnnotationCompose(connection, frame) {
  const id = frameId(frame);
  const prompt = frame.prompt;
  const picks = frame.picks;
  const record = parseRecord(frame.record);
  const missing = [];
  if (typeof prompt !== "string" || prompt.trim() === "") missing.push("prompt");
  if (!Array.isArray(picks)) missing.push("picks");
  if (missing.length > 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `missing or invalid: ${missing.join(", ")}`);
    return;
  }
  if (record === null && frame.record !== void 0) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, "malformed record: expected {id, start, events:[{seq,t,kind}...]}");
    return;
  }
  const target = typeof frame.target === "object" && frame.target !== null ? frame.target : null;
  const targetName = typeof target?.name === "string" && target.name.trim() !== "" ? target.name : void 0;
  const msgId = nextMsgId();
  const pageRaw = typeof frame.page === "object" && frame.page !== null ? frame.page : {};
  let content;
  try {
    content = renderHandoffDoc({
      msgId,
      prompt,
      page: {
        url: typeof pageRaw.url === "string" ? pageRaw.url : "",
        title: typeof pageRaw.title === "string" ? pageRaw.title : "",
        ts: typeof pageRaw.ts === "number" ? pageRaw.ts : Date.now()
      },
      picks,
      record: record ?? void 0,
      fromTarget: targetName,
      brokerCliPath: path5.join(__dirname, "broker-main.ts")
    });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed picks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_ACK, id, result: { prompt: content } });
  console.log(`[compose] rendered handoff preview ${msgId} (${picks.length} picks${record ? ` + record ${record.id}` : ""}${targetName ? ` → local:${targetName}` : ""}, not delivered)`);
}
function parseRecord(raw) {
  if (raw === void 0) return void 0;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw;
  if (typeof r.id !== "string" || r.id === "") return null;
  if (typeof r.start !== "number") return null;
  if (!Array.isArray(r.events)) return null;
  if (!r.events.every((ev) => typeof ev === "object" && ev !== null && typeof ev.seq === "number" && typeof ev.t === "number" && typeof ev.kind === "string")) return null;
  return raw;
}
async function handleTargetsList(connection, frame, xferDir) {
  const describe = createMeshDescriber(path5.join(xferDir, "mesh.config.json"));
  const targets = await listTargetsWithDescriptions(xferDir, describe);
  connection.send({ v: PROTOCOL_VERSION, type: WIRE_TARGETS_RESULT, id: frameId(frame), targets });
  const described = targets.filter((t) => t.description).length;
  console.log(`[targets] ${targets.length} live local target(s), ${described} with a description`);
}
var DEFAULT_PAGE_TIMEOUT_MS = 3e4;
var latestHandoffByTarget = /* @__PURE__ */ new Map();
var latestTabIdByTarget = /* @__PURE__ */ new Map();
var tabConns = null;
var pendingPageRequests = /* @__PURE__ */ new Map();
var MAX_PENDING_PAGE_REQUESTS = 128;
function envPageTimeoutMs() {
  const raw = process.env.BROKER_PAGE_TIMEOUT_MS;
  const parsed = raw === void 0 ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_TIMEOUT_MS;
}
function settlePageRequest(requestId, result) {
  const entry = pendingPageRequests.get(requestId);
  if (!entry || entry.settled) return;
  entry.settled = true;
  clearTimeout(entry.timer);
  entry.resolve(result);
  if (pendingPageRequests.size > MAX_PENDING_PAGE_REQUESTS) {
    for (const [id, pending] of pendingPageRequests) {
      if (pendingPageRequests.size <= MAX_PENDING_PAGE_REQUESTS) break;
      if (pending.settled) pendingPageRequests.delete(id);
    }
  }
}
function routePageTool(target, tool, timeoutMs) {
  const tabs = activeConns ? [...activeConns.keys()] : [];
  if (tabs.length === 0) {
    console.log(`[page.request] no tabs connected → no_tabs (target ${target})`);
    return null;
  }
  const lastTabId = latestTabIdByTarget.get(target);
  const targeted = lastTabId !== void 0 && tabConns !== null && tabConns.has(lastTabId) && activeConns.has(tabConns.get(lastTabId));
  const routed = targeted ? [tabConns.get(lastTabId)] : tabs;
  const id = nextRequestId();
  const resolvedTimeout = timeoutMs ?? envPageTimeoutMs();
  const frame = {
    v: PROTOCOL_VERSION,
    type: WIRE_PAGE_REQUEST,
    id,
    handoff_id: latestHandoffByTarget.get(target) ?? "demo",
    from: target,
    tool,
    timeoutMs: resolvedTimeout
  };
  let sent = 0;
  for (const conn of routed) {
    conn.send(frame);
    sent++;
  }
  const routedNote = routed.length === 1 && lastTabId !== void 0;
  console.log(
    `[page.request ${id}] → ${sent} tab(s) ${routedNote ? `[tab ${lastTabId}]` : "(broadcast)"}: ${tool.op} ${JSON.stringify(tool.params ?? {})} (handoff ${frame.handoff_id}, timeout ${resolvedTimeout}ms)`
  );
  let resolve;
  const result = new Promise((res) => {
    resolve = res;
  });
  const entry = {
    tabConn: null,
    askingTarget: target,
    settled: false,
    result,
    resolve,
    timer: setTimeout(() => settlePageRequest(id, { ok: false, error: "timeout" }), resolvedTimeout)
  };
  entry.timer.unref?.();
  pendingPageRequests.set(id, entry);
  return id;
}
function awaitPageResult(requestId) {
  const entry = pendingPageRequests.get(requestId);
  return entry ? entry.result : Promise.resolve({ ok: false, error: "no_such_request" });
}
function runPageTool(target, tool, timeoutMs) {
  const requestId = routePageTool(target, tool, timeoutMs);
  return requestId === null ? Promise.resolve({ ok: false, error: "no_tabs" }) : awaitPageResult(requestId);
}
function handlePageResponse(connection, frame) {
  const id = frameId(frame);
  if (id === null) {
    console.log(`[page.response] ignored: missing id`);
    return;
  }
  const entry = pendingPageRequests.get(String(id));
  if (!entry || entry.settled) {
    console.log(`[page.response ${String(id)}] ignored (${entry ? "already settled" : "unknown request"})`);
    return;
  }
  if (frame.ok !== true && frame.ok !== false) {
    console.log(`[page.response ${String(id)}] ignored: ok must be a boolean`);
    return;
  }
  entry.tabConn = connection;
  const text = typeof frame.text === "string" ? frame.text : void 0;
  const error = typeof frame.error === "string" ? frame.error : void 0;
  const result = frame.ok ? { ok: true, ...text !== void 0 ? { text } : {} } : { ok: false, ...error !== void 0 ? { error } : {} };
  console.log(`[page.response ${String(id)}] ok=${frame.ok} ${frame.ok ? `text: ${text ?? ""}` : `error: ${error ?? ""}`}`);
  settlePageRequest(String(id), result);
}
function handlePageToolHttp(request2, response) {
  let settled = false;
  let oversized = false;
  let size = 0;
  const chunks = [];
  const respond = (status, body) => {
    if (settled) return;
    settled = true;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  request2.on("data", (chunk) => {
    if (oversized) return;
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) {
      oversized = true;
      respond(413, { ok: false, error: "payload_too_large" });
      return;
    }
    chunks.push(chunk);
  });
  request2.on("end", () => {
    if (settled) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      respond(400, { ok: false, error: "invalid_json" });
      return;
    }
    const record = body ?? {};
    const { target, tool, timeoutMs } = record;
    if (typeof target !== "string" || target.trim() === "") {
      respond(400, { ok: false, error: "invalid_payload: missing or invalid target" });
      return;
    }
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      respond(400, { ok: false, error: "invalid_payload: tool must be an object" });
      return;
    }
    const toolRecord = tool;
    if (typeof toolRecord.op !== "string" || toolRecord.op.trim() === "") {
      respond(400, { ok: false, error: "invalid_payload: tool.op must be a non-empty string" });
      return;
    }
    if (toolRecord.params !== void 0 && (typeof toolRecord.params !== "object" || toolRecord.params === null || Array.isArray(toolRecord.params))) {
      respond(400, { ok: false, error: "invalid_payload: tool.params must be an object" });
      return;
    }
    if (timeoutMs !== void 0 && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      respond(400, { ok: false, error: "invalid_payload: timeoutMs must be a positive number" });
      return;
    }
    const pageTool = {
      op: toolRecord.op,
      ...toolRecord.params !== void 0 ? { params: toolRecord.params } : {}
    };
    void runPageTool(target, pageTool, timeoutMs).then((result) => {
      if (result.ok) {
        let parsed;
        let parseOk = false;
        try {
          parsed = JSON.parse(result.text ?? "");
          parseOk = true;
        } catch {
        }
        if (parseOk) respond(200, { ok: true, result: parsed });
        else respond(200, { ok: true, text: result.text ?? "" });
      } else {
        respond(200, { ok: false, error: result.error ?? "unknown" });
      }
    });
  });
}
function handleInboundPageRequest() {
  console.log("[broker] page.request is outbound-only; inbound request ignored");
}
function buildFrameHandlers(xferDir) {
  return {
    [WIRE_ANNOTATION_SUBMIT]: (connection, frame) => handleAnnotationSubmit(connection, frame, xferDir),
    [WIRE_ANNOTATION_COMPOSE]: (connection, frame) => handleAnnotationCompose(connection, frame),
    [WIRE_TARGETS_LIST]: (connection, frame) => handleTargetsList(connection, frame, xferDir),
    [WIRE_PAGE_REQUEST]: () => handleInboundPageRequest(),
    [WIRE_PAGE_RESPONSE]: (connection, frame) => handlePageResponse(connection, frame)
  };
}
function handleFrame(connection, raw, conns) {
  if (typeof raw !== "object" || raw === null) return;
  const frame = raw;
  if (frame.type === WIRE_HELLO) {
    if (conns.has(connection)) return;
    const tab = tabFromFrame(frame);
    conns.set(connection, tab);
    const tabId = typeof tab.id === "string" && tab.id !== "" ? tab.id : null;
    if (tabId !== null && tabConns !== null) tabConns.set(tabId, connection);
    connection.send({ v: PROTOCOL_VERSION, type: WIRE_WELCOME, broker: { version: VERSION } });
    console.log(`[ws] hello: tab "${tab.title ?? "?"}" (${tab.url ?? "?"})${tabId !== null ? ` [${tabId}]` : ""}`);
    return;
  }
  if (!conns.has(connection)) {
    sendError(connection, frame, ERR_AUTH_FAILED, "hello first");
    return;
  }
  if (typeof frame.type !== "string") return;
  const handler = frameHandlers[frame.type];
  if (handler) {
    handler(connection, frame);
    return;
  }
  sendError(connection, frame, ERR_UNSUPPORTED_VERSION, `unknown frame type ${frame.type}`);
}
async function startBroker(options) {
  const conns = /* @__PURE__ */ new Map();
  activeConns = conns;
  tabConns = /* @__PURE__ */ new Map();
  frameHandlers = buildFrameHandlers(options.xferDir);
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const server = http.createServer((request2, response) => {
    const url = new URL(request2.url ?? "/", `http://${HOST}`);
    if (url.pathname === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, port: boundPort(), version: VERSION, clients: conns.size, startedAt })
      );
      return;
    }
    if (url.pathname === "/page-tool" && request2.method === "POST") {
      handlePageToolHttp(request2, response);
      return;
    }
    response.writeHead(404).end();
  });
  attachWsServer(server, {
    // Connections enter the registry on hello (not on the raw upgrade).
    onConnection: () => {
    },
    onMessage: (connection, message) => handleFrame(connection, message, conns),
    onClose: (connection) => {
      conns.delete(connection);
      if (tabConns !== null) {
        for (const [tabId, conn] of tabConns) {
          if (conn === connection) tabConns.delete(tabId);
        }
      }
      console.log(`[ws] tab disconnected (${conns.size} remaining)`);
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, HOST, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const port = boundPort();
  fs5.mkdirSync(options.xferDir, { recursive: true, mode: 448 });
  writeBrokerFiles(options.xferDir, port, startedAt);
  function boundPort() {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("broker: server not bound to a TCP port");
    }
    return address.port;
  }
  return {
    server,
    port,
    startedAt,
    conns,
    close() {
      return new Promise((resolve) => {
        for (const connection of conns.keys()) connection.close(1001);
        server.close(() => resolve());
      });
    }
  };
}
function httpPostJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request2 = http.request(
      {
        host: HOST,
        port,
        path: pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      }
    );
    request2.on("error", reject);
    request2.end(payload);
  });
}
async function runPageToolCommand(args) {
  const positional = [];
  let timeoutMs;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--timeout-ms") {
      const raw = args[i + 1];
      const parsed = raw === void 0 ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`[broker] page-tool: invalid --timeout-ms "${raw}"`);
        process.exit(1);
      }
      timeoutMs = parsed;
      i++;
      continue;
    }
    if (arg === "--xfer-dir") {
      i++;
      continue;
    }
    positional.push(arg);
  }
  const target = positional[0];
  const op = positional[1];
  const paramsRaw = positional[2];
  let params;
  if (paramsRaw !== void 0) {
    try {
      const parsed = JSON.parse(paramsRaw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      params = parsed;
    } catch {
      console.error("[broker] page-tool: params must be a JSON object literal");
      process.exit(1);
    }
  }
  if (typeof target !== "string" || target.trim() === "" || typeof op !== "string" || op.trim() === "") {
    console.error("usage: node broker-main.ts page-tool <target> <op> [paramsJSON] [--timeout-ms <ms>]");
    process.exit(1);
  }
  const xferDir = parseArgs(process.argv.slice(2)).xferDir;
  let port;
  try {
    const raw = JSON.parse(fs5.readFileSync(path5.join(xferDir, "broker.json"), "utf-8"));
    const info = raw;
    if (typeof info.port !== "number" || info.port <= 0 || info.port > 65535) throw new Error("bad port");
    port = info.port;
  } catch {
    console.error(`[broker] page-tool: broker not running in ${xferDir} (no broker.json)`);
    process.exit(1);
  }
  let response;
  try {
    response = await httpPostJson(port, "/page-tool", {
      target,
      tool: { op, ...params !== void 0 ? { params } : {} },
      ...timeoutMs !== void 0 ? { timeoutMs } : {}
    });
  } catch (error) {
    console.error(`[broker] page-tool: broker unreachable on ${HOST}:${port} (${error.message})`);
    process.exit(1);
  }
  const body = response.body ?? {};
  if (response.status === 200 && body.ok === true) {
    process.stdout.write(`${JSON.stringify(body.result !== void 0 ? body.result : body.text)}
`, () => process.exit(0));
    return;
  }
  console.error(`[broker] page-tool failed: ${typeof body.error === "string" ? body.error : `http ${response.status}`}`);
  process.exit(1);
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "page-tool") {
    await runPageToolCommand(args.slice(1));
    return;
  }
  const { port, xferDir } = parseArgs(args);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[broker] invalid port: ${port}`);
    process.exit(1);
  }
  const existingPid = readPidFile(xferDir);
  if (existingPid !== null && pidAlive(existingPid)) {
    console.log("already running");
    process.exit(0);
  }
  let handle;
  try {
    handle = await startBroker({ port, xferDir });
  } catch (error) {
    if (error.code !== "EADDRINUSE") {
      console.error(`[broker] bind failed: ${error.message}`);
      process.exit(1);
    }
    const racedPid = readPidFile(xferDir);
    if (racedPid !== null && pidAlive(racedPid)) {
      console.log("already running");
      process.exit(0);
    }
    unlinkBrokerFiles(xferDir);
    if (port !== 0) {
      console.error(`[broker] port ${port} is occupied by another program — falling back to an ephemeral port`);
    }
    try {
      handle = await startBroker({ port: 0, xferDir });
    } catch (fallbackError) {
      console.error(`[broker] bind failed: ${fallbackError.message}`);
      process.exit(1);
    }
  }
  console.log(`[broker] listening on ${HOST}:${handle.port} (pid ${process.pid}, xfer-dir ${xferDir})`);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    unlinkBrokerFiles(xferDir);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
function isMainModule() {
  return isEntryPoint(["broker-main.ts", "broker.cjs"]);
}
if (isMainModule()) {
  main().catch((error) => {
    console.error(`[broker] fatal: ${error.message}`);
    process.exit(1);
  });
}

// broker-manager.ts
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
    if (!fs6.existsSync(BROKER_MAIN)) {
      throw new Error(
        `broker: daemon bundle missing (${BROKER_MAIN}) — run \`npm run build\` in the xfer extension directory`
      );
    }
    fs6.mkdirSync(this.xferDir, { recursive: true, mode: 448 });
    const logPath = path6.join(this.xferDir, "broker.log");
    const logFd = fs6.openSync(logPath, "a");
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
        fs6.closeSync(logFd);
      } catch {
      }
      throw new Error(`broker: spawn failed: ${errorMessage(error)}`);
    }
    child.unref();
    child.once("spawn", () => {
      try {
        fs6.closeSync(logFd);
      } catch {
      }
    });
    const spawnError = await confirmSpawn(child);
    if (spawnError) {
      try {
        fs6.closeSync(logFd);
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
    const pid = readPidFile2(this.xferDir);
    if (pid === null) return "broker not running";
    if (!pidAlive(pid)) {
      unlinkBrokerFiles2(this.xferDir);
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
    unlinkBrokerFiles2(this.xferDir);
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
    return [
      "broker: alive",
      `  port: ${info.port}`,
      `  pid: ${info.pid}`,
      `  startedAt: ${info.startedAt}`,
      `  version: ${info.version}`
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
      const lines = fs6.readFileSync(path6.join(this.xferDir, "broker.log"), "utf-8").split("\n").filter((line) => line.trim() !== "");
      return `last broker.log lines (${path6.join(this.xferDir, "broker.log")}):
${lines.slice(-LOG_TAIL_LINES).join("\n")}`;
    } catch {
      return `broker.log unavailable at ${path6.join(this.xferDir, "broker.log")}`;
    }
  }
};
var BROKER_MAIN = path6.join(__dirname, "broker.cjs");
function readBrokerJson(xferDir) {
  try {
    const data = JSON.parse(fs6.readFileSync(path6.join(xferDir, "broker.json"), "utf-8"));
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
function readPidFile2(xferDir) {
  try {
    const raw = fs6.readFileSync(path6.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function unlinkBrokerFiles2(xferDir) {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs6.unlinkSync(path6.join(xferDir, name));
    } catch {
    }
  }
}
function tcpProbe(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net2.connect({ host, port });
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
function isMainModule2() {
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
if (isMainModule2()) {
  runCli().catch((error) => {
    console.error(`broker-manager: ${errorMessage(error)}`);
    process.exit(1);
  });
}

// gc.ts
var fs7 = __toESM(require("node:fs"), 1);
var net3 = __toESM(require("node:net"), 1);
var path7 = __toESM(require("node:path"), 1);
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
    const conn = net3.connect({ path: sockPath });
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
    entries = fs7.readdirSync(xferDir, { withFileTypes: true });
  } catch {
    return { zombies, alive };
  }
  const jsonStems = /* @__PURE__ */ new Set();
  const sockStems = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json") && !GC_SKIP_JSON.has(entry.name)) {
      jsonStems.add(entry.name.slice(0, -".json".length));
    } else if (entry.name.endsWith(".sock")) {
      sockStems.add(entry.name.slice(0, -".sock".length));
    }
  }
  for (const stem of jsonStems) {
    const jsonPath = path7.join(xferDir, `${stem}.json`);
    const sockPath = path7.join(xferDir, `${stem}.sock`);
    let pid;
    try {
      const raw = JSON.parse(fs7.readFileSync(jsonPath, "utf-8"));
      const candidate = raw?.pid;
      if (typeof candidate === "number") pid = candidate;
    } catch {
    }
    if (pid === void 0) {
      if (fs7.existsSync(sockPath) && !await socketHasListener(sockPath)) {
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
  for (const stem of sockStems) {
    if (jsonStems.has(stem)) continue;
    const sockPath = path7.join(xferDir, `${stem}.sock`);
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
    try {
      fs7.unlinkSync(zombie.sockPath);
    } catch {
    }
    if (zombie.jsonPath) {
      try {
        fs7.unlinkSync(zombie.jsonPath);
      } catch {
      }
    }
  }
  return report;
}

// mesh-engine.ts
function deriveActorStatus(actor) {
  if (actor.destroy_ts !== void 0 && actor.destroy_ts !== null) return "Destroyed";
  if (actor.error !== void 0 && actor.error !== null) return "Crashed";
  if (actor.sleep_ts !== void 0 && actor.sleep_ts !== null) return "Sleeping";
  if (actor.connectable_ts !== void 0 && actor.connectable_ts !== null) return "Running";
  return "Pending";
}
async function engineApi(config, method, path9, body) {
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
  return engineApi(config, "GET", "/actors?name=" + encodeURIComponent(XFER_INSTANCE_ACTOR)).then(
    (actors) => actors.actors.filter((a) => a.destroy_ts === void 0 || a.destroy_ts === null).map((a) => ({ name: deserializeKeyString(a.key), actorId: a.actor_id, status: deriveActorStatus(a) }))
  );
}
function deserializeKeyString(serialized) {
  const parts = deserializeMeshKey(typeof serialized === "string" ? serialized : void 0);
  return parts[0] ?? "";
}

// admin-main.ts
var DEFAULT_ADMIN_PORT = 7788;
var EXTENSION_VERSION = (() => {
  try {
    return JSON.parse(fs8.readFileSync(path8.join(__dirname, "package.json"), "utf-8")).version ?? "?";
  } catch {
    return "?";
  }
})();
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
async function meshView(xferDir) {
  const configPath = path8.join(xferDir, "mesh.config.json");
  if (!fs8.existsSync(configPath)) return { configured: false, error: null, nodes: [] };
  try {
    const nodes = await listMeshNodes(loadMeshConfig(configPath));
    return { configured: true, error: null, nodes };
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
      nodes: []
    };
  }
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
  const meshRow = !mesh.configured ? `<div class="row" style="padding:6px 0"><span class="dot" style="background:#8a8174"></span><b class="mono">mesh</b><span class="muted">not configured (mesh.config.json)</span></div>` : mesh.error !== null ? `<div class="row" style="padding:6px 0"><span class="dot" style="background:#cf222e"></span><b class="mono">mesh</b><span class="muted">${esc(mesh.error)}</span></div>` : `<div class="row" style="padding:6px 0"><span class="dot" style="background:#8250df"></span><b class="mono">mesh</b><span class="muted">${mesh.nodes.length} node(s): ${mesh.nodes.map((n) => esc(n.name)).join(", ") || "—"}</span></div>`;
  return shell(
    "control",
    "Control",
    "Presence and the few actions this console is allowed to take.",
    `
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="panel"><h2>presence</h2>${presenceRows(peers)}</div>
      <div>
        <div class="panel" style="margin-bottom:14px"><h2>services</h2>
          ${brokerRow}
          <div class="row" style="padding:6px 0"><span class="dot" style="background:#1a7f37"></span>
            <b class="mono">admin</b><span class="muted">:${ctx.port} (this)</span><span style="flex:1"></span>
            <form method="post" action="/control/admin/stop"><button class="btn sm danger">stop</button></form></div>
          ${meshRow}
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
      let mesh = { configured: false, error: null, nodes: [] };
      try {
        mesh = await withTimeout(meshView(xferDir), MESH_PROBE_TIMEOUT_MS);
      } catch {
      }
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
      let mesh = { configured: false, error: null, nodes: [] };
      try {
        mesh = await withTimeout(meshView(xferDir), MESH_PROBE_TIMEOUT_MS);
      } catch {
      }
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
  const server = http2.createServer((req, res) => {
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
            fs8.unlinkSync(path8.join(xferDir, name));
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
  return {
    server,
    publish,
    hubSize: () => hub.size,
    setPort: (p) => {
      port = p;
    }
  };
}
function openInSystem(targetPath, isFile) {
  const opener = process.platform === "darwin" ? isFile ? ["open", "-t", targetPath] : ["open", targetPath] : process.platform === "win32" ? ["explorer", targetPath] : ["xdg-open", targetPath];
  import("node:child_process").then(({ spawn: spawn2 }) => {
    spawn2(opener[0], opener.slice(1), { detached: true, stdio: "ignore" }).unref();
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
    fs8.watch(xferDir, (_, filename) => {
      const name = filename ?? "";
      if (name === "broker.json" || name === "broker.pid") {
        once(`broker:${name}`, () => {
          const alive = fs8.existsSync(path8.join(xferDir, "broker.json"));
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
          const alive = fs8.existsSync(path8.join(xferDir, `${peerName}.sock`));
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
    fs8.mkdirSync(boardDir, { recursive: true });
    fs8.watch(boardDir, (_, filename) => {
      const name = filename ?? "";
      if (!name.endsWith(".md")) return;
      once(`board:${name}`, () => {
        const exists = fs8.existsSync(path8.join(boardDir, name));
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
function parseArgs2(args) {
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
function isMainModule3() {
  return isEntryPoint(["admin-main.ts", "admin.cjs"]);
}
async function main2() {
  const { port, xferDir, boardDir } = parseArgs2(process.argv.slice(2));
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
      fs8.unlinkSync(path8.join(xferDir, "admin.pid"));
      fs8.unlinkSync(path8.join(xferDir, "admin.json"));
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
  fs8.mkdirSync(xferDir, { recursive: true, mode: 448 });
  fs8.writeFileSync(path8.join(xferDir, "admin.pid"), `${process.pid}
`, "utf-8");
  fs8.writeFileSync(
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
      fs8.unlinkSync(path8.join(xferDir, "admin.pid"));
      fs8.unlinkSync(path8.join(xferDir, "admin.json"));
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (isMainModule3()) {
  main2().catch((error) => {
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
