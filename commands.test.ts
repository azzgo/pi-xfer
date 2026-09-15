/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts —
 * see the header there). The `/xfer` command is exercised through a stubbed ExtensionAPI:
 * `registerXferCommand` captures the command definition, tests invoke its handler and
 * completions with a fake `ctx.ui`.
 *
 * commands.ts value-imports `copyToClipboard` from the pi runtime package. At real runtime
 * pi aliases that specifier to its own bundle (jiti aliases in the extension loader), so
 * plain Node resolution can't see it; `before()` registers a resolve hook mapping it to a
 * minimal stub, then imports commands.ts. Each `node --test` file runs in its own process,
 * so the hook never leaks into other test files.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { XferController } from "./controller.js";
import { BrokerManager } from "./broker-manager.js";
import { XferState } from "./state.js";
import type { Identity } from "./types.js";

let registerXferCommand: typeof import("./commands.js").registerXferCommand;
interface CapturedCommand {
  description?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: never) => Promise<void>;
}

interface SentMessage {
  content: string;
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

interface Notification {
  message: string;
  type?: string;
}

let tmpDir: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-commands-test-"));

  const stubPath = path.join(tmpDir, "pi-runtime-stub.mjs");
  fs.writeFileSync(stubPath, "export async function copyToClipboard() {}\n");
  const stubUrl = pathToFileURL(stubPath).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@earendil-works/pi-coding-agent") return { url: stubUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  ({ registerXferCommand } = await import("./commands.js"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeIdentity(): Identity {
  return {
    name: "test-agent",
    cwd: tmpDir,
    endpoint: path.join(tmpDir, "test-agent.sock"),
    metadata: path.join(tmpDir, "test-agent.json"),
    server: null,
    startedAt: Date.now(),
  };
}

/** Register against stubs; return the captured definition plus invoke helpers. */
function harness(options: { brokerManager?: BrokerManager; brokerXferDir?: string; xferDir?: string; boardDir?: string } = {}): {
  description: string | undefined;
  handler: (args: string) => Promise<void>;
  completions: (prefix: string) => AutocompleteItem[] | null;
  sent: SentMessage[];
  notifications: Notification[];
} {
  const sent: SentMessage[] = [];
  const notifications: Notification[] = [];
  let def: CapturedCommand | undefined;
  const pi = {
    registerCommand: (_name: string, command: CapturedCommand) => { def = command; },
    sendUserMessage: (content: string, options?: SentMessage["options"]) => { sent.push({ content, options }); },
    on: () => {},
  } as unknown as ExtensionAPI;
  const controller = {
    state: { identity: makeIdentity(), sessionName: () => undefined },
  } as unknown as XferController;

  registerXferCommand(pi, controller, { brokerManager: options.brokerManager, brokerXferDir: options.brokerXferDir, xferDir: options.xferDir, boardDir: options.boardDir });
  assert.ok(def, "registerCommand was not captured");
  const ctx = {
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  };
  return {
    description: def.description,
    handler: (args: string) => def!.handler(args, ctx as never),
    completions: (prefix: string) => def!.getArgumentCompletions?.(prefix) ?? null,
    sent,
    notifications,
  };
}

/** BrokerManager stub for command smoke tests — records calls, returns canned strings. */
function stubBrokerManager(
  overrides: Partial<Record<"start" | "stop" | "status", () => Promise<string>>> = {},
): BrokerManager & { calls: string[] } {
  const calls: string[] = [];
  const make = (name: "start" | "stop" | "status", fallback: string) =>
    async (...args: number[]): Promise<string> => {
      // Record the port arg so tests can assert start(portOverride) plumbing.
      const port = args[0];
      calls.push(typeof port === "number" ? `${name} ${port}` : name);
      const fn = overrides[name];
      return fn ? fn() : fallback;
    };
  return {
    start: make("start", "broker started (pid 4242, port 4719)"),
    stop: make("stop", "broker stopped (pid 4242)"),
    status: make("status", "broker: alive\n  port: 4719\n  pid: 4242"),
    calls,
  } as unknown as BrokerManager & { calls: string[] };
}

describe("xfer command: list", () => {
  it("keeps the local section and shows the listener line", async () => {
    const h = harness();
    await h.handler("list");
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].type, "info");
    const message = h.notifications[0].message;
    assert.match(message, /📡 Peers:\n/);
    assert.match(message, /📡 Listener:/);
    assert.match(message, /unix socket/);
  });
});

describe("xfer command: completions", () => {
  it("keeps existing completions working", () => {
    const h = harness();
    assert.deepEqual((h.completions("li") ?? []).map((i) => i.value), ["list"]);
    assert.deepEqual((h.completions("na") ?? []).map((i) => i.value), ["name"]);
  });
});

describe("xfer command: broker subcommand", () => {
  it("starts the broker and notifies with pid/port; already-running is a no-op", async () => {
    const broker = stubBrokerManager();
    const h = harness({ brokerManager: broker });
    await h.handler("broker start");
    assert.deepEqual(broker.calls, ["start"]);
    assert.equal(h.notifications[0].type, "info");
    assert.match(h.notifications[0].message, /broker started \(pid 4242, port 4719\)/);

    const running = stubBrokerManager({ start: async () => "already running" });
    const h2 = harness({ brokerManager: running });
    await h2.handler("broker start");
    assert.equal(h2.notifications[0].type, "info");
    assert.match(h2.notifications[0].message, /already running/);
  });

  it("passes --port N from 'broker start --port N' to the manager", async () => {
    const broker = stubBrokerManager();
    const h = harness({ brokerManager: broker });
    await h.handler("broker start --port 5000");
    assert.deepEqual(broker.calls, ["start 5000"]);
    assert.equal(h.notifications[0].type, "info");
    assert.match(h.notifications[0].message, /broker started \(pid 4242, port 4719\)/);
  });

  it("rejects an invalid --port without touching the manager", async () => {
    const broker = stubBrokerManager();
    const h = harness({ brokerManager: broker });
    await h.handler("broker start --port abc");
    assert.deepEqual(broker.calls, []);
    assert.equal(h.notifications[0].type, "error");
    assert.match(h.notifications[0].message, /--port/);
  });

  it("notifies an error when start rejects", async () => {
    const broker = stubBrokerManager({
      start: async () => {
        throw new Error("broker: not ready within 5000ms");
      },
    });
    const h = harness({ brokerManager: broker });
    await h.handler("broker start");
    assert.equal(h.notifications[0].type, "error");
    assert.match(h.notifications[0].message, /not ready/);
  });

  it("shows the manager status text as info (never throws)", async () => {
    const broker = stubBrokerManager();
    const h = harness({ brokerManager: broker });
    await h.handler("broker status");
    assert.deepEqual(broker.calls, ["status"]);
    assert.equal(h.notifications[0].type, "info");
    assert.match(h.notifications[0].message, /broker: alive/);
    assert.match(h.notifications[0].message, /pid: 4242/);
  });

  it("stops the broker and notifies stopped / not-running", async () => {
    const broker = stubBrokerManager();
    const h = harness({ brokerManager: broker });
    await h.handler("broker stop");
    assert.deepEqual(broker.calls, ["stop"]);
    assert.equal(h.notifications[0].type, "info");
    assert.match(h.notifications[0].message, /broker stopped \(pid 4242\)/);

    const idle = stubBrokerManager({ stop: async () => "broker not running" });
    const h2 = harness({ brokerManager: idle });
    await h2.handler("broker stop");
    assert.equal(h2.notifications[0].type, "info");
    assert.match(h2.notifications[0].message, /not running/);
  });

  it("errors on missing/unknown subcommands", async () => {
    const h = harness();
    await h.handler("broker");
    await h.handler("broker restart");
    assert.equal(h.notifications.length, 2);
    for (const n of h.notifications) {
      assert.equal(n.type, "error");
      assert.match(n.message, /Usage: \/xfer broker <start\|status\|stop\|logs>/);
    }
  });

  it("drives the real broker end-to-end through the command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-commands-broker-"));
    const broker = new BrokerManager({ xferDir: dir, port: 0 });
    const h = harness({ brokerManager: broker, brokerXferDir: dir });
    try {
      await h.handler("broker start");
      assert.match(h.notifications[0].message, /broker started \(pid \d+, port \d+\)/, `got: ${h.notifications[0].message}`);

      await h.handler("broker start"); // idempotent — probe finds the live daemon
      assert.match(h.notifications[1].message, /already running/);

      await h.handler("broker status");
      assert.match(h.notifications[2].message, /broker: alive/);
      assert.match(h.notifications[2].message, /port: \d+/);

      await h.handler("broker stop");
      assert.match(h.notifications[3].message, /broker stopped \(pid \d+\)/);
    } finally {
      await broker.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("xfer command: broker logs", () => {
  it("tails ~50 lines of <xferDir>/broker.log honoring the xferDir override", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(tmpDir, "broker.log"), lines.join("\n") + "\n", "utf-8");
    const h = harness({ brokerXferDir: tmpDir });
    await h.handler("broker logs");
    assert.equal(h.notifications[0].type, "info");
    const message = h.notifications[0].message;
    assert.match(message, /^line 10\n/);
    assert.match(message, /line 59$/);
    assert.ok(!message.includes("line 0"), "log head must be dropped");
  });

  it("reports an unavailable broker.log without crashing", async () => {
    const h = harness({ brokerXferDir: path.join(tmpDir, "no-such-dir") });
    await h.handler("broker logs");
    assert.equal(h.notifications[0].type, "info");
    assert.match(h.notifications[0].message, /broker\.log unavailable/);
  });
});

describe("xfer command: broker completions", () => {
  it("offers start/status/stop/logs for the 'broker ' prefix", () => {
    const h = harness();
    const items = h.completions("broker ") ?? [];
    assert.deepEqual(items.map((i) => i.value), ["broker start", "broker status", "broker stop", "broker logs"]);
  });

  it("offers broker among top-level subcommands", () => {
    const h = harness();
    const values = (h.completions("") ?? []).map((i) => i.value);
    assert.ok(values.includes("broker"));
  });
});

describe("xfer command: broker description and help text", () => {
  it("mentions the broker subcommand group in the description and help", async () => {
    const h = harness();
    assert.match(h.description ?? "", /\/xfer broker <start\|status\|stop\|logs>/);
    await h.handler("help");
    assert.match(h.notifications[0].message, /broker start\|status\|stop\|logs/);
  });
});

describe("xfer command: gc subcommand", () => {
  /** A pid that is guaranteed gone: spawn `true` and let it exit. */
  function deadPid(): number {
    const r = spawnSync("true");
    assert.equal(r.status, 0);
    assert.ok(typeof r.pid === "number" && r.pid > 0);
    return r.pid;
  }

  it("reaps zombies in the injected xferDir, keeps broker files, reports the list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-commands-gc-"));
    const pid = deadPid();
    fs.writeFileSync(path.join(dir, "ghost.json"), JSON.stringify({ xferName: "ghost", pid }));
    fs.writeFileSync(path.join(dir, "ghost.sock"), "");
    fs.writeFileSync(path.join(dir, "broker.json"), '{"pid": 1}');
    const h = harness({ xferDir: dir });
    try {
      await h.handler("gc");
      assert.equal(h.notifications.length, 1);
      assert.equal(h.notifications[0].type, "info");
      assert.match(h.notifications[0].message, /Removed 1 zombie/);
      assert.match(h.notifications[0].message, /ghost — dead-pid \(pid \d+\)/);
      assert.match(h.notifications[0].message, /kept 0 live peer/);
      assert.ok(!fs.existsSync(path.join(dir, "ghost.sock")), "zombie sock removed");
      assert.ok(!fs.existsSync(path.join(dir, "ghost.json")), "zombie json removed");
      assert.ok(fs.existsSync(path.join(dir, "broker.json")), "broker files must survive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no zombies for a clean dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-commands-gc-"));
    const h = harness({ xferDir: dir });
    try {
      await h.handler("gc");
      assert.match(h.notifications[0].message, /No zombie sockets/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mentions gc in the description, help and top-level completions", async () => {
    const h = harness();
    assert.match(h.description ?? "", /\/xfer gc/);
    await h.handler("help");
    assert.match(h.notifications[0].message, /\/xfer gc/);
    const values = (h.completions("") ?? []).map((i) => i.value);
    assert.ok(values.includes("gc"));
  });
});

describe("xfer command: board subcommand", () => {
  it("creates a card with an explicit title immediately", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    await h.handler("board new my topic");
    assert.match(h.notifications[0].message, /c-0001 — my topic/);
  });

  it("new without a title enters the two-phase write via followUp message", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    await h.handler("board new");
    assert.match(h.sent[0].content, /Board Card Request/);
    assert.match(h.sent[0].content, /board-entry/);
  });

  it("read injects the card body as a followUp message", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    await h.handler("board new my topic");
    await h.handler("board read c-0001");
    assert.match(h.sent[0].content, /my topic/);
  });

  it("read/write/del with an unknown id error out", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    await h.handler("board read c-9999");
    assert.equal(h.notifications[0].type, "error");
    await h.handler("board write c-9999 hi");
    assert.equal(h.notifications[1].type, "error");
    await h.handler("board del c-9999");
    assert.equal(h.notifications[2].type, "error");
  });

  it("list reports an empty board, then the created card", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    await h.handler("board list");
    assert.match(h.notifications[0].message, /empty/);
    await h.handler("board new another");
    await h.handler("board list");
    assert.match(h.notifications[2].message, /c-0001 — another/);
  });

  it("completions offer board subs, then card ids after read/write/del", async () => {
    const h = harness({ boardDir: fs.mkdtempSync(path.join(tmpDir, "board-")) });
    const subs = (h.completions("board ") ?? []).map((i) => i.value);
    assert.ok(subs.includes("board list"));
    assert.ok(subs.includes("board open"));
    await h.handler("board new my topic");
    const ids = (h.completions("board read ") ?? []).map((i) => i.value);
    assert.deepEqual(ids, ["board read c-0001"]);
  });
});
