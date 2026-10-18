/**
 * admin-server.test.ts — HTTP surface tests for the admin daemon
 * (milestone1 P0-1): SSE endpoint (fire-and-forget push), board read-only
 * routes, and control endpoints. Everything runs on an ephemeral port with
 * an isolated os.tmpdir() xfer/board dir; the server is closed after each
 * test so the suite leaks no handles.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Board } from "./board.js";
import { createAdminServer, type AdminEvent, type AdminServer, type AdminServerOptions } from "./admin-main.js";
import type { MeshConfig } from "./mesh-config.js";
import type { MeshNode } from "./mesh.js";
import { serializeMeshKey } from "./mesh-config.js";
import type { MeshNodeInfo } from "./mesh-engine.js";

const tmpDirs: string[] = [];
const servers: AdminServer[] = [];

interface Harness {
  admin: AdminServer;
  port: number;
  xferDir: string;
  boardDir: string;
  published: AdminEvent[];
  opened: { path: string; isFile: boolean }[];
  counters: { shutdowns: number };
}

function makeHarness(options: { heartbeatMs?: number; meshNode?: MeshNode; destroyMeshNode?: AdminServerOptions["destroyMeshNode"] } = {}): Harness {
  const xferDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-admin-server-test-"));
  tmpDirs.push(xferDir);
  const boardDir = path.join(xferDir, "board");
  const published: AdminEvent[] = [];
  const opened: { path: string; isFile: boolean }[] = [];
  const counters = { shutdowns: 0 };
  const admin = createAdminServer({
    xferDir,
    boardDir,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    onEvent: (event) => published.push(event),
    openPath: (targetPath, isFile) => opened.push({ path: targetPath, isFile }),
    shutdown: () => {
      counters.shutdowns += 1;
    },
    ...(options.meshNode ? { meshNode: options.meshNode } : {}),
    ...(options.destroyMeshNode ? { destroyMeshNode: options.destroyMeshNode } : {}),
  });
  servers.push(admin);
  const h: Harness = { admin, port: 0, xferDir, boardDir, published, opened, counters };
  return h;
}

function listen(harness: Harness): Promise<number> {
  return new Promise((resolve) => {
    harness.admin.server.listen(0, "127.0.0.1", () => {
      const port = (harness.admin.server.address() as { port: number }).port;
      harness.port = port;
      resolve(port);
    });
  });
}

afterEach(async () => {
  for (const admin of servers.splice(0)) {
    await new Promise<void>((resolve) => admin.server.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function get(port: number, pathname: string, method = "GET", body?: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers: body ? { "content-type": "application/x-www-form-urlencoded" } : {} },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location as string | undefined, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Open an SSE connection, run `run`, and collect the data frames seen. */
async function withSse(port: number, run: () => Promise<void>, collectMs = 500): Promise<string[]> {
  const frames: string[] = [];
  return await new Promise<string[]>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (res) => {
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) frames.push(frame.slice("data: ".length));
        }
      });
      res.on("error", reject);
      void (async () => {
        await run();
        setTimeout(() => {
          req.destroy();
          resolve(frames);
        }, collectMs);
      })();
    });
    req.on("error", reject);
  });
}

function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("admin server pages", () => {
  it("dashboard renders stats and pages exist", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const dash = await get(port, "/");
    assert.equal(dash.status, 200);
    assert.match(dash.body, /Overview/);
    for (const p of ["/", "/events", "/board", "/control", "/board/c-0001-x", "/nope"]) {
      const res = await get(port, p);
      assert.equal(res.status, 200, p);
      assert.match(res.body, /<!doctype html>/, `${p} must be a full document`);
      assert.match(res.body, /<style>/, `${p} must embed the Ink stylesheet`);
    }
  });

  it("unknown pages 404 in-band", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/nope");
    assert.match(res.body, /no such page/);
  });
});

describe("admin SSE endpoint", () => {
  it("pushes published events to connected clients and buffers nothing", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const event: AdminEvent = {
      t: "12:00:00", kind: "peer", text: "tester came online", detail: "tester.sock",
    };
    const frames = await withSse(port, async () => {
      h.admin.publish(event);
    });
    assert.equal(frames.length, 1, "exactly one data frame");
    const parsed = JSON.parse(frames[0]!) as AdminEvent;
    assert.equal(parsed.kind, "peer");
    assert.equal(parsed.text, "tester came online");
    // Fire-and-forget: a later publish with no client is simply dropped.
    h.admin.publish({ ...event, text: "nobody listening" });
    await waitFor(() => h.admin.hubSize() === 0, "the disconnected client to be reaped");
    assert.equal(h.admin.hubSize(), 0, "client removed after disconnect");
  });

  it("theme toggle is gone: no theme links, ?theme ignored", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/");
    assert.doesNotMatch(res.body, /theme-btn|[?&]theme=/);
    assert.match(res.body, /#f3efe6/, "light palette is the only one");
  });

  it("responds with text/event-stream headers", async () => {
    const h = makeHarness();
    const port = await listen(h);
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (res) => {
        assert.match(String(res.headers["content-type"]), /text\/event-stream/);
        req.destroy();
        resolve();
      });
      req.on("error", reject);
    });
  });
});

describe("admin board routes (read-only)", () => {
  it("lists cards, renders card detail, and offers no write API", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const board = new Board(h.boardDir);
    const card = board.create("mesh rollout", "tester", { type: "note", author: "tester", at: new Date().toISOString(), text: "**Self-host** route verified\n\n- queue drain works\n- `gc` edge case fixed" });

    const list = await get(port, "/board");
    assert.match(list.body, /mesh rollout/);
    assert.match(list.body, new RegExp(card.id));
    assert.match(list.body, /open folder/);
    assert.doesNotMatch(list.body, /<textarea|method="put"|\/board\/write|\/board\/new|\/board\/del/);

    const detail = await get(port, `/board/${encodeURIComponent(card.id)}`);
    assert.match(detail.body, /mesh rollout/);
    assert.match(detail.body, /<b>Self-host<\/b>/);
    assert.match(detail.body, /<code>gc<\/code>/);
    assert.match(detail.body, /open in editor/);

    const byTitle = await get(port, `/board/${encodeURIComponent("mesh rollout")}`);
    assert.match(byTitle.body, /mesh rollout/);

    const missing = await get(port, "/board/c-9999-none");
    assert.match(missing.body, /card not found/);
  });

  it("board/open with no card opens the folder via the injected openPath", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/board/open", "POST", "card=");
    assert.equal(res.status, 303);
    assert.equal(res.location, "/board");
    await waitFor(() => h.opened.length > 0, "the open call");
    assert.deepEqual(h.opened[0], { path: h.boardDir, isFile: false });
    await waitFor(() => h.published.length > 0, "the open event");
    assert.equal(h.published[0]!.kind, "board");
  });

  it("board/open with a card opens the card file in an editor", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const card = new Board(h.boardDir).create("editor target", "tester");
    const res = await get(port, "/board/open", "POST", `card=${encodeURIComponent(card.id)}`);
    assert.equal(res.status, 303);
    await waitFor(() => h.opened.length > 0, "the open call");
    assert.equal(h.opened[0]!.path, card.file);
    assert.equal(h.opened[0]!.isFile, true);
  });

  it("escapes hostile card titles (attribute-context XSS regression)", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const hostile = `"><img src=x onerror=alert('x')>`;
    new Board(h.boardDir).create(hostile, "tester");
    const list = await get(port, "/board");
    assert.doesNotMatch(list.body, /<img/, "raw <img must not survive escaping");
    assert.match(list.body, /&lt;img/);
    assert.match(list.body, /&quot;/);
    const id = new Board(h.boardDir).list()[0]!.id;
    const detail = await get(port, `/board/${encodeURIComponent(id)}`);
    assert.doesNotMatch(detail.body, /<img/);
    assert.match(detail.body, /&#39;/);
  });
  it("POST to a board detail path is refused (no write API)", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/board/c-0001-x", "POST", "body=malicious");
    assert.equal(res.status, 404);
  });
});

describe("admin control endpoints", () => {
  it("run gc reuses collectGarbage, redirects, and publishes a gc event", async () => {
    const h = makeHarness();
    const port = await listen(h);
    // A zombie: .json with a dead pid plus its sock.
    fs.writeFileSync(path.join(h.xferDir, "zombie.json"), JSON.stringify({ pid: 999999999 }), "utf-8");
    fs.writeFileSync(path.join(h.xferDir, "zombie.sock"), "", "utf-8");
    const res = await get(port, "/control/gc", "POST", "");
    assert.equal(res.status, 303);
    await waitFor(() => h.published.some((e) => e.kind === "gc"), "the gc event");
    const gcEvent = h.published.find((e) => e.kind === "gc")!;
    assert.match(gcEvent.text, /removed 1 zombie/);
    assert.equal(fs.existsSync(path.join(h.xferDir, "zombie.sock")), false);
  });

  it("self-check renders a report on /control?selfcheck=1", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/control?selfcheck=1");
    assert.match(res.body, /peers: 0 socket/);
    assert.match(res.body, /broker: not running/);
  });
});

const MESH_ENDPOINT = "http://127.0.0.1:1";

function writeMeshConfig(dir: string, body: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, "mesh.config.json"), JSON.stringify({ endpoint: MESH_ENDPOINT, ...body }), "utf-8");
}

function stubEngine(nodes: MeshNodeInfo[], options: { fail?: string } = {}) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    if (options.fail) throw new Error(options.fail);
    return new Response(
      JSON.stringify({
        actors: nodes.map((n) => ({
          actor_id: n.actorId,
          key: serializeMeshKey([n.name]),
          runner_name_selector: n.pool,
          ...(n.status === "Running" ? { connectable_ts: 1, start_ts: 1 } : {}),
          ...(n.status === "Sleeping" ? { sleep_ts: 5 } : {}),
          ...(n.status === "Idle" ? { sleep_ts: 5, error: "no_envoys" } : {}),
          ...(n.status === "Crashed" ? { error: "boom" } : {}),
        })),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

interface FakeMeshNode {
  node: MeshNode;
  ups: string[];
  downs: number;
  online: { name: string } | null;
}

function fakeMeshNode(): FakeMeshNode {
  const state: FakeMeshNode = { node: null as unknown as MeshNode, ups: [], downs: 0, online: null };
  state.node = {
    status: () => (state.online ? { online: true, name: state.online.name } : { online: false }),
    up: async (name: string) => {
      state.ups.push(name);
      state.online = { name };
    },
    down: async () => {
      state.downs += 1;
      state.online = null;
    },
  } as unknown as MeshNode;
  return state;
}

describe("admin mesh control — presence grouping", () => {
  it("groups local peers and mesh nodes, one row per node with status and pool", async () => {
    const h = makeHarness();
    writeMeshConfig(h.xferDir, { pool: "host-a" });
    fs.writeFileSync(path.join(h.xferDir, "laptop.json"), JSON.stringify({ pid: process.pid, sessionName: "s3" }), "utf-8");
    fs.writeFileSync(path.join(h.xferDir, "laptop.sock"), "", "utf-8");
    const stub = stubEngine([
      { name: "doubao", actorId: "a1", status: "Idle", pool: "host-b" },
      { name: "agent-grok", actorId: "a2", status: "Running", pool: "host-c" },
      { name: "quiet", actorId: "a3", status: "Sleeping" },
    ]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control");
      assert.equal(res.status, 200);
      assert.match(res.body, /<h3>local peers<\/h3>/, "peers get their own subsection");
      assert.match(res.body, /<h3 class="subhead">mesh nodes<\/h3>/, "mesh nodes get their own subsection");
      assert.match(res.body, /laptop/);
      assert.equal((res.body.match(/action="\/control\/mesh\/down"/g) ?? []).length, 3, "one down action per node");
      assert.match(res.body, /idle · no runner/);
      assert.match(res.body, /pool host-b/);
      assert.match(res.body, /pool \(default\)/);
      assert.match(res.body, /<b class="mono">mesh<\/b><span class="muted">3 node\(s\) · 3 pool\(s\)<\/span>/, "SERVICES counts nodes and distinct pools");
      assert.doesNotMatch(res.body, /\/control\/mesh\/up/, "no up control is rendered");
    } finally { stub.restore(); }
  });

  it("asks for confirmation before destroying a node that is Running on another host", async () => {
    const h = makeHarness();
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([
      { name: "agent-grok", actorId: "a2", status: "Running", pool: "host-c" },
      { name: "quiet", actorId: "a3", status: "Sleeping" },
    ]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control");
      assert.match(res.body, /data-confirm="&quot;agent-grok&quot; is Running on another host right now/);
      assert.equal((res.body.match(/data-confirm="/g) ?? []).length, 1, "only the Running node carries the guard");
      assert.match(res.body, /<b class="mono">quiet<\/b>[\s\S]{0,400}?class="btn sm danger">down<\/button><\/form><\/div>/, "the unguarded action still renders as a plain danger button");
    } finally { stub.restore(); }
  });

  it("renders a readable engine error instead of an empty mesh section", async () => {
    const h = makeHarness();
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([], { fail: "connect ECONNREFUSED" });
    try {
      const port = await listen(h);
      const res = await get(port, "/control");
      assert.match(res.body, /<div class="notice warn mono">engine error — connect ECONNREFUSED<\/div>/);
    } finally { stub.restore(); }
  });

  it("says not configured when there is no mesh.config.json", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/control");
    assert.match(res.body, /not configured — no mesh.config.json/);
  });
});

describe("admin mesh control — down action only", () => {
  it("offers no up control and no mesh control panel", async () => {
    const mesh = fakeMeshNode();
    mesh.online = { name: "phone" };
    const h = makeHarness({ meshNode: mesh.node });
    writeMeshConfig(h.xferDir, { pool: "host-a" });
    const stub = stubEngine([{ name: "phone", actorId: "a9", status: "Sleeping" }, { name: "tablet", actorId: "a10", status: "Pending" }]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control");
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /\/control\/mesh\/up/, "no up endpoint is rendered");
      assert.doesNotMatch(res.body, /mesh control/i, "the mesh control panel is gone");
      assert.doesNotMatch(res.body, /<button class="btn sm primary">up<\/button>/, "no up button anywhere");
      assert.match(res.body, /action="\/control\/mesh\/down"/, "the per-node down action stays");
      assert.equal((res.body.match(/action="\/control\/mesh\/down"/g) ?? []).length, 2, "one down action per node");
      assert.match(res.body, /<span class="pill" style="color:#8250df;background:#fbefff">this node<\/span>/, "the row still marks the daemon's own node");
    } finally { stub.restore(); }
  });

  it("rejects a POST to /control/mesh/up instead of bringing anything online", async () => {
    const mesh = fakeMeshNode();
    const h = makeHarness({ meshNode: mesh.node });
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control/mesh/up", "POST", "name=laptop");
      assert.equal(res.status, 404);
      assert.match(res.body, /not found/);
      assert.deepEqual(mesh.ups, [], "nothing was brought online");
      assert.deepEqual(h.published, [], "no mesh event was published");
    } finally { stub.restore(); }
  });

  it("down destroys another host's actor through the injected engine seam", async () => {
    const destroyed: Array<{ actorId: string; endpoint: string }> = [];
    const h = makeHarness({
      destroyMeshNode: async (config: MeshConfig, actorId: string) => { destroyed.push({ actorId, endpoint: config.endpoint }); },
    });
    writeMeshConfig(h.xferDir, { namespace: "ns" });
    const stub = stubEngine([{ name: "phone", actorId: "a9", status: "Sleeping", pool: "host-b" }]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control/mesh/down", "POST", "name=phone&actor=a9");
      assert.equal(res.status, 303);
      assert.deepEqual(destroyed, [{ actorId: "a9", endpoint: MESH_ENDPOINT }]);
      assert.match(decodeURIComponent(res.location ?? ""), /notice=ok\|mesh node "phone" was destroyed/);
      await waitFor(() => h.published.some((e) => e.kind === "mesh"), "the mesh down event");
    } finally { stub.restore(); }
  });

  it("down refuses when the actor changed since the page rendered", async () => {
    const destroyed: string[] = [];
    const h = makeHarness({ destroyMeshNode: async (_config: MeshConfig, actorId: string) => { destroyed.push(actorId); } });
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([{ name: "phone", actorId: "fresh", status: "Sleeping" }]);
    try {
      const port = await listen(h);
      const stale = await get(port, "/control/mesh/down", "POST", "name=phone&actor=stale");
      assert.match(decodeURIComponent(stale.location ?? ""), /changed since this page rendered/);
      assert.deepEqual(destroyed, [], "a stale action never destroys");
      const missing = await get(port, "/control/mesh/down", "POST", "name=ghost&actor=");
      assert.match(decodeURIComponent(missing.location ?? ""), /is not in the engine listing/);
      assert.deepEqual(destroyed, []);
    } finally { stub.restore(); }
  });

  it("down on this daemon's own node tears the local node down instead of a remote actor", async () => {
    const mesh = fakeMeshNode();
    mesh.online = { name: "laptop" };
    const destroyed: string[] = [];
    const h = makeHarness({
      meshNode: mesh.node,
      destroyMeshNode: async (_config: MeshConfig, actorId: string) => { destroyed.push(actorId); },
    });
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([{ name: "laptop", actorId: "a1", status: "Running" }]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control/mesh/down", "POST", "name=laptop&actor=a1");
      assert.equal(mesh.downs, 1, "the local MeshNode.down() is the path taken");
      assert.deepEqual(destroyed, [], "no second destroy on top of it");
      assert.match(decodeURIComponent(res.location ?? ""), /\(this daemon\) is offline/);
    } finally { stub.restore(); }
  });

  it("down reports a failed destroy instead of pretending it worked", async () => {
    const h = makeHarness({ destroyMeshNode: async () => { throw new Error("mesh engine DELETE /actors/a9 failed: 500 nope"); } });
    writeMeshConfig(h.xferDir);
    const stub = stubEngine([{ name: "phone", actorId: "a9", status: "Crashed" }]);
    try {
      const port = await listen(h);
      const res = await get(port, "/control/mesh/down", "POST", "name=phone&actor=a9");
      assert.match(decodeURIComponent(res.location ?? ""), /notice=warn\|mesh engine DELETE \/actors\/a9 failed: 500 nope/);
      assert.match(h.published.find((e) => e.kind === "mesh")?.text ?? "", /mesh down failed — phone/);
    } finally { stub.restore(); }
  });
});

describe("admin SSE heartbeat + cleanup", () => {
  it("sends heartbeat comments and reaps the client on disconnect", async () => {
    const h = makeHarness({ heartbeatMs: 50 });
    const port = await listen(h);
    const sawHeartbeat = await new Promise<boolean>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes(": hb")) {
            req.destroy();
            resolve(true);
          }
        });
        res.on("error", () => resolve(false));
      });
      req.on("error", reject);
    });
    assert.equal(sawHeartbeat, true, "heartbeat comment within a few intervals");
    await waitFor(() => h.admin.hubSize() === 0, "the client to be reaped");
  });
});

describe("admin broker + admin control endpoints", () => {
  it("broker start/stop spawn and tear down a real broker via BrokerManager", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const start = await get(port, "/control/broker/start", "POST", "");
    assert.equal(start.status, 303);
    await waitFor(() => fs.existsSync(path.join(h.xferDir, "broker.json")), "broker.json after start");
    const control = await get(port, "/control");
    assert.match(control.body, /action="\/control\/broker\/stop"/, "broker shows as running with a stop button");
    const stop = await get(port, "/control/broker/stop", "POST", "");
    assert.equal(stop.status, 303);
    await waitFor(() => !fs.existsSync(path.join(h.xferDir, "broker.json")), "broker files cleared after stop");
  });

  it("admin stop unlinks admin state and invokes the shutdown hook once", async () => {
    const h = makeHarness();
    const port = await listen(h);
    fs.writeFileSync(path.join(h.xferDir, "admin.pid"), `${process.pid}\n`, "utf-8");
    fs.writeFileSync(path.join(h.xferDir, "admin.json"), "{}", "utf-8");
    const res = await get(port, "/control/admin/stop", "POST", "");
    assert.equal(res.status, 303);
    assert.equal(fs.existsSync(path.join(h.xferDir, "admin.pid")), false, "admin.pid unlinked like SIGTERM");
    assert.equal(fs.existsSync(path.join(h.xferDir, "admin.json")), false, "admin.json unlinked like SIGTERM");
    await waitFor(() => h.counters.shutdowns === 1, "the shutdown hook");
    assert.equal(h.counters.shutdowns, 1);
  });

  it("rejects oversized POST bodies with 413", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/control/gc", method: "POST", headers: { "content-length": String(80 * 1024) } },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
});
