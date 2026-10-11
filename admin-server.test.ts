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
import { createAdminServer, type AdminEvent, type AdminServer } from "./admin-main.js";

const tmpDirs: string[] = [];
const servers: AdminServer[] = [];

interface Harness {
  admin: AdminServer;
  port: number;
  xferDir: string;
  boardDir: string;
  published: AdminEvent[];
}

function makeHarness(): Harness {
  const xferDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-admin-server-test-"));
  tmpDirs.push(xferDir);
  const boardDir = path.join(xferDir, "board");
  const published: AdminEvent[] = [];
  const admin = createAdminServer({ xferDir, boardDir, onEvent: (event) => published.push(event) });
  servers.push(admin);
  return { admin, port: 0, xferDir, boardDir, published };
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
    for (const p of ["/events", "/board", "/control"]) {
      const res = await get(port, p);
      assert.equal(res.status, 200, p);
    }
    const dark = await get(port, "/?theme=dark");
    assert.match(dark.body, /#14110d/, "dark theme background");
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

  it("board/open delegates to the system and never writes content", async () => {
    const h = makeHarness();
    const port = await listen(h);
    const res = await get(port, "/board/open", "POST", "card=");
    assert.equal(res.status, 303);
    assert.equal(res.location, "/board");
    await waitFor(() => h.published.length > 0, "the open event");
    assert.equal(h.published[0]!.kind, "board");
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
