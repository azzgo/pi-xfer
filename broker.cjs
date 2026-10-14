
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

// broker-main.ts
var broker_main_exports = {};
__export(broker_main_exports, {
  DEFAULT_PAGE_TIMEOUT_MS: () => DEFAULT_PAGE_TIMEOUT_MS,
  VERSION: () => VERSION,
  awaitPageResult: () => awaitPageResult,
  handleFrame: () => handleFrame,
  handlePageResponse: () => handlePageResponse,
  main: () => main,
  parseArgs: () => parseArgs,
  pidAlive: () => pidAlive,
  routePageTool: () => routePageTool,
  runPageTool: () => runPageTool,
  startBroker: () => startBroker
});
module.exports = __toCommonJS(broker_main_exports);
var fs3 = __toESM(require("node:fs"), 1);
var http = __toESM(require("node:http"), 1);
var net = __toESM(require("node:net"), 1);
var os2 = __toESM(require("node:os"), 1);
var path4 = __toESM(require("node:path"), 1);

// constants.ts
var os = __toESM(require("node:os"), 1);
var path = __toESM(require("node:path"), 1);
var XFER_DIR = path.join(os.homedir(), ".pi", "xfer");
var MESH_CONFIG_PATH = path.join(XFER_DIR, "mesh.config.json");
var MESH_CACHE_DIR = path.join(XFER_DIR, "cache");
var CONNECT_TIMEOUT_MS = 5e3;
var ACK_TIMEOUT_MS = 5e3;
var MAX_FRAME_BYTES = 1024 * 1024;

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
function renderHandoffDoc({ msgId, prompt, page, picks, record, fromTarget, brokerCliPath }) {
  const lines = [
    "# Web annotation handoff",
    "",
    "## Request",
    "",
    prompt,
    "",
    "## Page",
    "",
    field("url", page.url),
    field("title", page.title),
    field("ts", `${page.ts} (${new Date(page.ts).toISOString()})`),
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
var fs = __toESM(require("node:fs"), 1);
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
    text = fs.readFileSync(configPath, "utf-8");
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
var fs2 = __toESM(require("node:fs"), 1);
var path3 = __toESM(require("node:path"), 1);

// utils.ts
var path2 = __toESM(require("node:path"), 1);
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
function isEntryPoint(names) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return names.includes(path2.basename(invoked));
}

// targets.ts
var NULL_METADATA = { sessionName: null, cwd: null, status: null };
function readSiblingMetadata(metadataPath) {
  try {
    const raw = JSON.parse(fs2.readFileSync(metadataPath, "utf-8"));
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
    entries = fs2.readdirSync(xferDir);
  } catch {
    return [];
  }
  return entries.filter((file) => file.endsWith(".sock")).map((sockFile) => {
    const base = sockFile.replace(/\.sock$/, "");
    return { name: decodeAgentName(base), ...readSiblingMetadata(path3.join(xferDir, `${base}.json`)) };
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
    return JSON.parse(fs3.readFileSync(path4.join(__dirname, "package.json"), "utf-8")).version ?? "?";
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
    fs3.writeFileSync(temp, content, { encoding: "utf-8", mode: 384 });
    fs3.renameSync(temp, filePath);
    try {
      fs3.chmodSync(filePath, 384);
    } catch {
    }
  } catch (error) {
    try {
      fs3.unlinkSync(temp);
    } catch {
    }
    throw error;
  }
}
function readPidFile(xferDir) {
  try {
    const raw = fs3.readFileSync(path4.join(xferDir, "broker.pid"), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function unlinkBrokerFiles(xferDir) {
  for (const name of ["broker.pid", "broker.json"]) {
    try {
      fs3.unlinkSync(path4.join(xferDir, name));
    } catch {
    }
  }
}
function writeBrokerFiles(xferDir, port, startedAt) {
  writeFileAtomic(path4.join(xferDir, "broker.pid"), `${process.pid}
`);
  writeFileAtomic(
    path4.join(xferDir, "broker.json"),
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
    const endpoint = path4.join(xferDir, `${encodeAgentName(target)}.sock`);
    if (!fs3.existsSync(endpoint)) {
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
  const doc = path4.join(os2.tmpdir(), `pi-xfer-${msgId}.md`);
  const pageRaw = typeof frame.page === "object" && frame.page !== null ? frame.page : {};
  const page = {
    url: typeof pageRaw.url === "string" ? pageRaw.url : "",
    title: typeof pageRaw.title === "string" ? pageRaw.title : "",
    ts: typeof pageRaw.ts === "number" ? pageRaw.ts : Date.now()
  };
  let content;
  try {
    content = renderHandoffDoc({
      msgId,
      prompt,
      page,
      picks,
      record: record ?? void 0,
      // The receiving session's own xfer name: makes the doc's page-tool
      // follow-up command directly runnable (compose passes it too — the two
      // render paths must not drift).
      fromTarget: targetName,
      brokerCliPath: path4.join(__dirname, "broker-main.ts")
    });
  } catch (error) {
    sendError(connection, frame, ERR_INVALID_PAYLOAD, `malformed picks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    fs3.writeFileSync(doc, content, { mode: 384 });
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
      brokerCliPath: path4.join(__dirname, "broker-main.ts")
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
  const describe = createMeshDescriber(path4.join(xferDir, "mesh.config.json"));
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
  fs3.mkdirSync(options.xferDir, { recursive: true, mode: 448 });
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
    const raw = JSON.parse(fs3.readFileSync(path4.join(xferDir, "broker.json"), "utf-8"));
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_PAGE_TIMEOUT_MS,
  VERSION,
  awaitPageResult,
  handleFrame,
  handlePageResponse,
  main,
  parseArgs,
  pidAlive,
  routePageTool,
  runPageTool,
  startBroker
});
