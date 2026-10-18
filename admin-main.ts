/**
 * admin-main.ts — the xfer admin daemon (milestone1 P0-1).
 *
 * A machine-local, localhost-only web console for observing and lightly
 * controlling xfer: live event stream (SSE), local + mesh presence, board
 * list/detail, and control buttons (gc, broker start/stop). Everything is
 * server-rendered multi-page HTML over node:http — zero npm dependencies,
 * zero bundle. Visual baseline: the settled "Ink" variant from
 * prototype/admin-ui (light-only Ink variant, viewport-width layout,
 * pill buttons without shadows, solid-red danger).
 *
 * Write operations on board content are NEVER handled in-page — the pages
 * only GET; the sole mutating endpoints are the control actions (gc, broker
 * start/stop, admin stop, mesh node down, self-check) and the two
 * open-delegations (open folder / open in editor), which shell out to the
 * system. Mesh down destroys an actor through the injected mesh seam, never
 * through the render path; bringing a node online stays a pi-side command
 * (/xfer mesh up), so the console never owns a node lifecycle.
 *
 * Events are fire-and-forget: an in-memory SSE hub pushes to whatever
 * browsers are connected right now; nothing is buffered server-side.
 * Sources: fs.watch on the xfer dir (peers, broker.json) and the board dir
 * (cards), plus the daemon's own control actions.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Board } from "./board.ts";
import { BrokerManager } from "./broker-manager.ts";
import { MESH_PROBE_TIMEOUT_MS, XFER_DIR } from "./constants.ts";
import { collectGarbage } from "./gc.ts";
import { deriveMeshNodeState, listMeshNodes, listMeshState, meshPoolName, type MeshActorStatus, type MeshNodeState, type MeshRunnerInfo } from "./mesh-engine.ts";
import { MESH_STATE_MARKS, MESH_STATE_ORDER, poolLabel } from "./mesh-status.ts";
import { loadMeshConfig } from "./mesh-config.ts";
import { MeshNode } from "./mesh.ts";
import { isEntryPoint, listPeers, withTimeout } from "./utils.ts";

/** Default admin TCP port (mirrors admin-manager.ts DEFAULT_ADMIN_PORT). */
export const DEFAULT_ADMIN_PORT = 7788;

const EXTENSION_VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8")) as { version?: string }).version ?? "?";
  } catch {
    return "?";
  }
})();

/** One admin event pushed over SSE. `full` is the expandable detail text. */
export interface AdminEvent {
  t: string;
  kind: "peer" | "board" | "broker" | "mesh" | "gc" | "admin";
  text: string;
  detail: string;
  full?: string;
}

export interface AdminServerOptions {
  xferDir: string;
  boardDir: string;
  /** Observability hook for tests/hosts: called for every published event. */
  onEvent?: (event: AdminEvent) => void;
  /** Process teardown for the web stop button; defaults to just closing the server. */
  shutdown?: () => void;
  /** Open a path via the system (folder/file); overridable for tests. */
  openPath?: (targetPath: string, isFile: boolean) => void;
  /** SSE heartbeat interval in ms; default 15000. */
  heartbeatMs?: number;
  /** A mesh node this daemon may own; its `down()` is the path taken for that node. */
  meshNode?: MeshNode;
  /** Destroy one mesh actor; defaults to the engine REST call. */
  destroyMeshNode?: (config: MeshConfig, actorId: string) => Promise<void>;
}

const MESH_DOWN_TIMEOUT_MS = 30_000;

// ---------- SSE hub ----------

class EventHub {
  private clients = new Set<http.ServerResponse>();

  add(res: http.ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  get size(): number {
    return this.clients.size;
  }

  /** Push to whoever is listening; nobody and nothing is buffered. */
  publish(event: AdminEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }
}

// ---------- live state readers (reused command logic) ----------

interface PeerRow {
  name: string;
  online: boolean;
  sessionName: string | null;
  cwd: string | null;
  pid: number | undefined;
}

function peerRows(xferDir: string): PeerRow[] {
  return listPeers("", xferDir).map((peer) => ({
    name: peer.xferName,
    online: peer.pid === undefined ? true : processAlive(peer.pid),
    sessionName: peer.sessionName ?? null,
    cwd: peer.cwd ?? null,
    pid: peer.pid,
  }));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface MeshNodeRow {
  name: string;
  actorId: string;
  status?: string;
  pool?: string;
}

interface MeshView {
  configured: boolean;
  error: string | null;
  nodes: MeshNodeRow[];
  /** `null` = the engine did not answer `/envoys`; every row then reads "unknown". */
  envoys: MeshRunnerInfo[] | null;
  config: MeshConfig | null;
  self: { name: string; pool: string } | null;
  notice: { tone: "ok" | "warn"; text: string } | null;
}

const emptyMeshView = (overrides: Partial<MeshView> = {}): MeshView => ({
  configured: true,
  error: null,
  nodes: [],
  envoys: null,
  config: null,
  self: null,
  notice: null,
  ...overrides,
});

async function meshView(xferDir: string, meshNode: MeshNode | null, notice: MeshView["notice"] = null): Promise<MeshView> {
  const configPath = path.join(xferDir, "mesh.config.json");
  if (!fs.existsSync(configPath)) return emptyMeshView({ configured: false, notice });
  let config: MeshConfig;
  try {
    config = loadMeshConfig(configPath);
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

async function loadMeshedView(xferDir: string, meshNode: MeshNode | null, notice: MeshView["notice"] = null): Promise<MeshView> {
  try {
    return await withTimeout(meshView(xferDir, meshNode, notice), MESH_PROBE_TIMEOUT_MS);
  } catch {
    return emptyMeshView({ error: `engine did not answer within ${MESH_PROBE_TIMEOUT_MS} ms`, notice });
  }
}


function meshNoticeParam(tone: "ok" | "warn", text: string): string {
  return `notice=${encodeURIComponent(`${tone}|${text}`)}`;
}

function parseMeshNotice(value: string | null): MeshView["notice"] {
  if (!value) return null;
  const split = value.indexOf("|");
  if (split <= 0) return null;
  const tone = value.slice(0, split) === "ok" ? "ok" : "warn";
  return { tone, text: value.slice(split + 1) };
}

// ---------- HTML rendering (Ink variant, light) ----------

const KIND_COLORS: Record<AdminEvent["kind"], [string, string]> = {
  peer: ["#1a7f37", "#dafbe1"],
  mesh: ["#8250df", "#fbefff"],
  broker: ["#9a6700", "#fff8c5"],
  board: ["#0969da", "#ddf4ff"],
  gc: ["#cf222e", "#ffebe9"],
  admin: ["#59636e", "#e7ebef"],
};

const TONES: Record<string, string> = { peers: "#1a7f37", mesh: "#8250df", board: "#0969da", broker: "#9a6700" };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escAttribute = (s: string): string => esc(s).replace(/[`\u0000-\u001f]/g, "");

const md = (src: string): string => esc(src)
  .replace(/^### (.*)$/gm, "<h3>$1</h3>")
  .replace(/^## (.*)$/gm, "<h3>$1</h3>")
  .replace(/^# (.*)$/gm, "<h3>$1</h3>")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/`(.+?)`/g, "<code>$1</code>")
  .replace(/^- (.*)$/gm, "<li>$1</li>")
  .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
  .replace(/\n{2,}/g, "<br><br>");

const css = (): string => {
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


const now = (): string => new Date().toTimeString().slice(0, 8);

const shell = (active: string, title: string, lede: string, body: string): string => `
  <nav>
    <span class="brand mono">xfer admin</span>
    ${[["/", "dashboard"], ["/events", "events"], ["/board", "board"], ["/control", "control"]]
      .map(([href, label]) => `<a href="${href}" class="${label === active ? "on" : ""}">${label}</a>`).join("")}
  </nav>
  <div class="wrap">
    <h1>${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ""}${body}
  </div>`;

const page = (fit: boolean, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>xfer admin</title><style>${css()}</style></head>` +
  `<body class="${fit ? "fit" : ""}">${body}${CLIENT_SCRIPT}</body></html>`;

const statCard = (tone: string, label: string, num: string, sub: string, href: string): string =>
  `<a class="panel stat" href="${href}" style="border-top-color:${TONES[tone]}"><h2>${esc(label)}</h2>` +
  `<b style="color:${TONES[tone]}">${esc(num)}</b><div class="muted">${esc(sub)}</div></a>`;

const CLIENT_SCRIPT = `<script>
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

// ---------- page bodies ----------

interface RenderContext {
  xferDir: string;
  boardDir: string;
  port: number;
  brokerProbe: () => Promise<{ port: number } | null>;
}

/** Presentation only: glyphs and labels come from mesh-status.ts, never from here. */
const STATE_DOT_COLORS: Record<MeshNodeState, string> = {
  Running: "#1a7f37",
  Sleeping: "#9a6700",
  NoRunner: "#8250df",
  Mismatch: "#bc4c00",
  Pending: "#0969da",
  Crashed: "#cf222e",
  Unknown: "#8a8174",
};

const STATUS_LEGEND = `<div class="rules">${MESH_STATE_ORDER
  .map((state) => `<span><span class="dot" style="background:${STATE_DOT_COLORS[state]}"></span>${MESH_STATE_MARKS[state].label}</span>`)
  .join("")}</div>`;

const meshPoolCount = (nodes: MeshNodeRow[]): number =>
  new Set(nodes.map((node) => meshPoolName(node.pool))).size;

const meshRowState = (node: MeshNodeRow, mesh: MeshView): MeshNodeState =>
  deriveMeshNodeState({ status: (node.status ?? "Unknown") as MeshActorStatus, pool: node.pool }, mesh.envoys);

const rowReason = (node: MeshNodeRow, mesh: MeshView): string => {
  if (mesh.envoys === null) return "engine did not answer /envoys — its pool's runners are unknown";
  const pool = poolLabel(node.pool);
  const state = meshRowState(node, mesh);
  if (state === "NoRunner") return `no runner in pool "${pool}"`;
  if (state === "Mismatch") return `pool "${pool}" has a runner, but the actor record still reads idle`;
  if (state === "Sleeping") return `asleep in pool "${pool}" — wakes on delivery`;
  return "";
};

const meshDownForm = (node: MeshNodeRow, confirmMessage: string | null): string =>
  `<form method="post" action="/control/mesh/down">` +
  `<input type="hidden" name="name" value="${escAttribute(node.name)}">` +
  `<input type="hidden" name="actor" value="${escAttribute(node.actorId)}">` +
  `<button class="btn sm danger"${confirmMessage ? ` data-confirm="${esc(confirmMessage)}"` : ""}>down</button></form>`;

const meshNodeRow = (node: MeshNodeRow, mesh: MeshView): string => {
  const state = meshRowState(node, mesh);
  const dot = STATE_DOT_COLORS[state];
  const isSelf = mesh.self?.name === node.name;
  const pool = poolLabel(node.pool);
  const runningElsewhere = node.status === "Running" && !isSelf;
  const confirmMessage = runningElsewhere
    ? `"${node.name}" is Running on another host right now. Destroying its actor cuts that host off mid-session. Destroy it anyway?`
    : null;
  const reason = rowReason(node, mesh);
  return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--hover)">
    <span class="mono" style="color:${dot};width:1em;text-align:center">${MESH_STATE_MARKS[state].glyph}</span><b class="mono">${esc(node.name)}</b>
    <span class="muted">${MESH_STATE_MARKS[state].label}</span>
    <span class="dim mono">pool ${esc(pool)}</span>
    ${reason ? `<span class="dim">— ${esc(reason)}</span>` : ""}
    ${isSelf ? `<span class="pill" style="color:#8250df;background:#fbefff">this node</span>` : ""}
    <span style="flex:1"></span>${meshDownForm(node, confirmMessage)}</div>`;
};

const meshViewBody = (mesh: MeshView): string => {
  if (!mesh.configured) return `<div class="empty">not configured — no mesh.config.json in the xfer dir</div>`;
  if (mesh.error !== null) return `<div class="notice warn mono">engine error — ${esc(mesh.error)}</div>`;
  const rows = mesh.nodes.map((node) => meshNodeRow(node, mesh)).join("");
  const unknown = mesh.envoys === null ? `<div class="notice warn mono">the engine did not answer /envoys — every row reads "?"</div>` : "";
  return `${unknown}${STATUS_LEGEND}${rows || `<div class="empty">no mesh nodes on the engine</div>`}`;
};

const presenceRows = (peers: PeerRow[]): string =>
  peers.length === 0
    ? `<div class="empty">no local peers</div>`
    : peers.map((p) => {
        const col = p.online ? "#1a7f37" : "#cf222e";
        return `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--hover)">
    <span class="dot" style="background:${col}"></span><b class="mono">${esc(p.name)}</b>
    <span class="muted">${p.online ? "online" : "zombie"}${p.sessionName ? ` · ${esc(p.sessionName)}` : ""}</span>
    <span style="flex:1"></span><span class="dim">${p.cwd ? esc(p.cwd) : ""}</span></div>`;
      }).join("");

const boardList = (ctx: RenderContext): string => {
  const cards = new Board(ctx.boardDir).list();
  if (cards.length === 0) return `<div class="empty">board is empty</div>`;
  return cards.map((c) => `<div class="card-row"><div class="row">
    <a href="/board/${encodeURIComponent(c.id)}"><b class="mono" style="border-bottom:1px dotted #0969da">${esc(c.title)}</b></a>
    <span class="dim mono">${esc(c.id)}</span><span class="dim">by ${esc(c.createdBy)}</span>
    <span style="flex:1"></span>
    <form method="post" action="/board/open"><input type="hidden" name="card" value=""><button class="btn sm">open folder</button></form>
  </div></div>`).join("");
};

const boardDetail = (ctx: RenderContext, idOrTitle: string): string => {
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

const controlPage = (ctx: RenderContext, peers: PeerRow[], mesh: MeshView, broker: { port: number } | null, selfCheck: string | null): string => {
  const brokerRow = broker
    ? `<div class="row" style="padding:6px 0"><span class="dot" style="background:#1a7f37"></span>
        <b class="mono">broker</b><span class="muted">:${broker.port}</span><span style="flex:1"></span>
        <form method="post" action="/control/broker/stop"><button class="btn sm danger">stop</button></form></div>`
    : `<div class="row" style="padding:6px 0"><span class="dot" style="background:#cf222e"></span>
        <b class="mono">broker</b><span class="muted">stopped</span><span style="flex:1"></span>
        <form method="post" action="/control/broker/start"><button class="btn sm primary">start</button></form></div>`;
  const meshPoint = mesh.error !== null ? "#cf222e" : mesh.configured ? "#8250df" : "#8a8174";
  const meshSummary = mesh.configured ? `${mesh.nodes.length} node(s) · ${meshPoolCount(mesh.nodes)} pool(s)` : "not configured";
  const notice = mesh.notice
    ? `<div class="notice ${mesh.notice.tone}">${esc(mesh.notice.text)}</div>`
    : "";
  return shell("control", "Control",
    "Presence and the few actions this console is allowed to take.", `
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
    </div>`);
};

// ---------- server factory ----------

export interface AdminServer {
  server: http.Server;
  publish: (event: AdminEvent) => void;
  hubSize(): number;
  /** Report the actually-bound port (main() calls this after listen). */
  setPort(port: number): void;
}

export function createAdminServer(options: AdminServerOptions): AdminServer {
  const { xferDir, boardDir } = options;
  const hub = new EventHub();
  const brokerManager = new BrokerManager({ xferDir });
  const meshNode = options.meshNode ?? null;
  const destroyMeshNode = options.destroyMeshNode ?? destroyMeshActor;
  let meshBusy: string | null = null;
  let port = DEFAULT_ADMIN_PORT;
  const openPath = options.openPath ?? openInSystem;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const publish = (event: AdminEvent): void => {
    options.onEvent?.(event);
    hub.publish(event);
  };

  async function render(pathname: string, query: URLSearchParams): Promise<string> {
    const ctx: RenderContext = {
      xferDir,
      boardDir,
      port,
      brokerProbe: () => brokerManager.probe(),
    };

    if (pathname === "/" || pathname === "") {
      const peers = peerRows(xferDir);
      const online = peers.filter((p) => p.online).length;
      const cards = new Board(boardDir).list();
      const broker = await brokerManager.probe();
      const mesh = await loadMeshedView(xferDir, meshNode);
      const meshLine = mesh.configured ? (mesh.error ? "engine error" : `${mesh.nodes.length} node(s)`) : "not configured";
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
      return page(false, shell("dashboard", "Overview",
        "Local presence, mesh, and the board — what is happening on this machine.", body));
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

  function selfCheckReport(peers: PeerRow[], mesh: MeshView, broker: { port: number } | null): string {
    const lines = [
      `peers: ${peers.length} socket(s), ${peers.filter((p) => p.online).length} alive`,
      broker ? `broker: alive on :${broker.port}` : "broker: not running (/xfer broker start)",
      `mesh: ${!mesh.configured ? "not configured" : mesh.error ? `engine error — ${mesh.error}` : `${mesh.nodes.length} node(s) online`}`,
      `board: ${new Board(boardDir).list().length} card(s)`,
      `admin: alive on :${port} (this page)`,
    ];
    return lines.join("\n");
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/sse" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
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
      },
    );
  });

  const MAX_BODY_BYTES = 64 * 1024;

  async function readBody(req: http.IncomingMessage): Promise<string> {
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

  function redirect(res: http.ServerResponse, to: string): void {
    res.writeHead(303, { location: to });
    res.end();
  }

  async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const back = (fallback: string): string => {
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
          t: now(), kind: "gc",
          text: `gc removed ${report.zombies.length} zombie(s)`,
          detail: `kept ${report.alive.length} live peer(s)`,
          full: report.zombies.map((z) => `${z.name} — ${z.reason}`).join("\n") || "(nothing to reclaim)",
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
        // Same cleanup as SIGTERM: unlink admin.pid/admin.json before teardown.
        for (const name of ["admin.pid", "admin.json"]) {
          try { fs.unlinkSync(path.join(xferDir, name)); } catch { /* already gone */ }
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
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      // An unread oversized body would hold the keep-alive socket open.
      res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`admin: action failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleMeshDown(name: string, actorId: string, res: http.ServerResponse, back: (fallback: string) => string): Promise<void> {
    const target = name.trim();
    const refuse = (text: string): void => {
      publish({ t: now(), kind: "mesh", text: `mesh down refused — ${target || "(no name)"}`, detail: text });
      redirect(res, back(`/control?${meshNoticeParam("warn", text)}`));
    };
    if (target === "") return refuse("mesh down needs a node name");
    const configPath = path.join(xferDir, "mesh.config.json");
    if (!fs.existsSync(configPath)) return refuse("mesh is not configured — no mesh.config.json in the xfer dir");
    let config: MeshConfig;
    try {
      config = loadMeshConfig(configPath);
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
    setPort: (p: number) => {
      port = p;
    },
  };
}

async function destroyMeshActor(config: MeshConfig, actorId: string): Promise<void> {
  const url = new URL(`/actors/${encodeURIComponent(actorId)}`, config.endpoint);
  if (config.namespace) url.searchParams.set("namespace", config.namespace);
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const response = await fetch(url, { method: "DELETE", headers });
  if (!response.ok) {
    throw new Error(`mesh engine DELETE ${url.pathname} failed: ${response.status} ${await response.text().catch(() => "")}`);
  }
}

function openInSystem(targetPath: string, isFile: boolean): void {
  const opener = process.platform === "darwin"
    ? (isFile ? ["open", "-t", targetPath] : ["open", targetPath])
    : process.platform === "win32"
      ? ["explorer", targetPath]
      : ["xdg-open", targetPath];
  import("node:child_process").then(({ spawn }) => {
    spawn(opener[0]!, opener.slice(1), { detached: true, stdio: "ignore" }).unref();
  });
}


// ---------- filesystem event sources ----------

export function startWatchers(xferDir: string, boardDir: string, publish: (event: AdminEvent) => void): void {
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  // Non-peer metadata that also lives in the xfer dir (gc.ts GC_SKIP_JSON plus
  // the admin's own state) — their writes must not fire fake peer events.
  const SKIP_JSON = new Set(["broker.json", "admin.json", "mesh.config.json", "settings.json"]);
  const once = (key: string, fn: () => void, ms = 100): void => {
    const existing = debounce.get(key);
    if (existing) clearTimeout(existing);
    debounce.set(key, setTimeout(() => {
      debounce.delete(key);
      fn();
    }, ms));
  };

  try {
    fs.watch(xferDir, (_, filename) => {
      const name = filename ?? "";
      if (name === "broker.json" || name === "broker.pid") {
        once(`broker:${name}`, () => {
          const alive = fs.existsSync(path.join(xferDir, "broker.json"));
          publish({
            t: now(), kind: "broker",
            text: alive ? "broker is up" : "broker went down",
            detail: name,
          });
        });
        return;
      }
      if (name.endsWith(".sock") || (name.endsWith(".json") && !SKIP_JSON.has(name))) {
        const peerName = name.replace(/\.sock$/, "").replace(/\.json$/, "");
        once(`peer:${peerName}`, () => {
          const alive = fs.existsSync(path.join(xferDir, `${peerName}.sock`));
          publish({
            t: now(), kind: "peer",
            text: alive ? `${peerName} came online` : `${peerName} went offline`,
            detail: `${peerName}${alive ? " registered" : " unregistered"}`,
          });
        });
      }
    });
  } catch { /* xfer dir missing — nothing to watch */ }

  try {
    fs.mkdirSync(boardDir, { recursive: true });
    fs.watch(boardDir, (_, filename) => {
      const name = filename ?? "";
      if (!name.endsWith(".md")) return;
      once(`board:${name}`, () => {
        const exists = fs.existsSync(path.join(boardDir, name));
        publish({
          t: now(), kind: "board",
          text: exists ? `card updated: ${name}` : `card removed: ${name}`,
          detail: name,
        });
      });
    });
  } catch { /* board dir unavailable */ }
}

// ---------- CLI entry ----------

function parseArgs(args: string[]): { port: number; xferDir: string; boardDir: string } {
  let port = DEFAULT_ADMIN_PORT;
  let xferDir = XFER_DIR;
  let boardDir = path.join(xferDir, "board");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port") port = Number.parseInt(args[++i] ?? "", 10);
    else if (arg.startsWith("--port=")) port = Number.parseInt(arg.slice("--port=".length), 10);
    else if (arg === "--xfer-dir") xferDir = args[++i] ?? xferDir;
    else if (arg.startsWith("--xfer-dir=")) xferDir = arg.slice("--xfer-dir=".length);
    else if (arg === "--board-dir") boardDir = args[++i] ?? boardDir;
    else if (arg.startsWith("--board-dir=")) boardDir = arg.slice("--board-dir=".length);
  }
  return { port, xferDir, boardDir };
}

/** Direct-run guard: only the admin entry starts a daemon, never a bundled host. */
function isMainModule(): boolean {
  return isEntryPoint(["admin-main.ts", "admin.cjs"]);
}

export async function main(): Promise<void> {
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
      setTimeout(() => process.exit(0), 1_000).unref();
    },
  });

  const listenOn = (p: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve();
      });
    });

  let realPort: number;
  try {
    await listenOn(port);
    realPort = (server.address() as { port: number }).port;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE" || port === 0) {
      console.error(`[admin] bind failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    // broker-main.ts precedent: a port held by a foreign program must not
    // wedge startup — clear stale admin state and fall back to an ephemeral
    // port; the real port lands in admin.json either way.
    try {
      fs.unlinkSync(path.join(xferDir, "admin.pid"));
      fs.unlinkSync(path.join(xferDir, "admin.json"));
    } catch { /* already gone */ }
    console.error(`[admin] port ${port} is occupied by another program — falling back to an ephemeral port`);
    try {
      await listenOn(0);
      realPort = (server.address() as { port: number }).port;
    } catch (fallbackError) {
      console.error(`[admin] bind failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      process.exit(1);
    }
  }
  setPort(realPort);

  fs.mkdirSync(xferDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(xferDir, "admin.pid"), `${process.pid}\n`, "utf-8");
  fs.writeFileSync(
    path.join(xferDir, "admin.json"),
    JSON.stringify({ port: realPort, pid: process.pid, startedAt: new Date().toISOString(), version: EXTENSION_VERSION }, null, 2),
    "utf-8",
  );

  startWatchers(xferDir, boardDir, publish);

  console.log(`[admin] listening on http://localhost:${realPort} (pid ${process.pid}, xfer-dir ${xferDir})`);

  const shutdown = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      fs.unlinkSync(path.join(xferDir, "admin.pid"));
      fs.unlinkSync(path.join(xferDir, "admin.json"));
    } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[admin] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
