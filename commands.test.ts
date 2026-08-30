/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts —
 * see the header there). The `/xfer` command is exercised through a stubbed ExtensionAPI:
 * `registerXferCommand` captures the command definition, tests invoke its handler and
 * completions with a fake `ctx.ui`, and remote peers come from a temp settings.json
 * injected via the `settingsPath` option — `~/.pi/xfer/settings.json` is never touched.
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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { XferController } from "./controller.js";
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
let settingsPath: string;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-commands-test-"));
  settingsPath = path.join(tmpDir, "settings.json");

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

function writeSettings(content: string): void {
  fs.writeFileSync(settingsPath, content, "utf-8");
}

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
function harness(): {
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
  } as unknown as ExtensionAPI;
  const controller = {
    state: { identity: makeIdentity(), sessionName: () => undefined },
    bridgeInfo: () => ({ up: false }),
    listenerSetup: async () => {},
    listenerStop: async () => {},
    listenerLogs: () => {
      notifications.push({ message: "bridge not running", type: "warning" });
    },
  } as unknown as XferController;

  registerXferCommand(pi, controller, { settingsPath });
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

/** Harness backed by a REAL XferController (+ XferState) for bridge-listener tests. */
function realHarness(): {
  handler: (args: string) => Promise<void>;
  completions: (prefix: string) => AutocompleteItem[] | null;
  notifications: Notification[];
  controller: XferController;
} {
  const notifications: Notification[] = [];
  let def: CapturedCommand | undefined;
  const pi = {
    registerCommand: (_name: string, command: CapturedCommand) => { def = command; },
    sendUserMessage: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const controller = new XferController(pi, new XferState());
  controller.state.identity = makeIdentity();
  // Bridge notifications route through state.runtimeContext.ui — wire them into the capture.
  controller.state.runtimeContext = {
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  } as never;

  registerXferCommand(pi, controller, { settingsPath });
  assert.ok(def, "registerCommand was not captured");

  const ctx = {
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  };
  return {
    handler: (args: string) => def!.handler(args, ctx as never),
    completions: (prefix: string) => def!.getArgumentCompletions?.(prefix) ?? null,
    notifications,
    controller,
  };
}

/** True when the process group no longer exists. macOS reports EPERM (not ESRCH)
 *  for kill(-pgid, 0) once the group leader has been reaped — treat both as gone. */
function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return true;
    throw err;
  }
}

describe("xfer command: peer subcommand", () => {
  it("reports a usage error when the request is missing", async () => {
    const h = harness();
    await h.handler("peer codex");
    await h.handler("peer");
    assert.equal(h.notifications.length, 2);
    for (const n of h.notifications) {
      assert.equal(n.type, "error");
      assert.match(n.message, /Usage: \/xfer peer <name> <request>/);
    }
  });

  it("names the settings path for an unknown remote peer", async () => {
    writeSettings(`{"peers": {"codex": {"send": "send-codex %msgfile"}}}`);
    const h = harness();
    await h.handler("peer ghost review the diff");
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].type, "error");
    assert.match(h.notifications[0].message, /ghost/);
    assert.match(h.notifications[0].message, new RegExp(settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(h.sent.length, 0);
  });

  it("notifies instead of crashing on malformed settings", async () => {
    writeSettings("{ not json");
    const h = harness();
    await h.handler("peer codex review the diff");
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].type, "error");
    assert.match(h.notifications[0].message, /Malformed JSON/);
    assert.match(h.notifications[0].message, new RegExp(settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(h.sent.length, 0);
  });

  it("sends a followUp user message naming the target, xfer_peer_to and the return address", async () => {
    writeSettings(`{"peers": {"codex": {"send": "send-codex %msgfile"}}}`);
    const h = harness();
    await h.handler("peer codex review the diff");
    assert.equal(h.notifications.length, 0);
    assert.equal(h.sent.length, 1);

    const { content, options } = h.sent[0];
    assert.match(content, /\bcodex\b/);
    assert.match(content, /xfer_peer_to/);
    assert.match(content, /use xfer_peer_to, not xfer_to/);
    assert.match(content, /from=`test-agent`/);
    assert.match(content, /review the diff/);
    assert.match(content, /Context summary/);
    assert.match(content, /Suggested skills/);
    assert.match(content, /Return address/);
    assert.match(content, /Notes/);
    assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
  });
});

describe("xfer command: list", () => {
  it("keeps the local section and adds a Remote peers (settings.json) section", async () => {
    writeSettings(`{"peers": {"codex": {"send": "send-codex %msgfile", "note": "codex relay"}, "zeta": {"send": "send-zeta %msgfile"}}}`);
    const h = harness();
    await h.handler("list");
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].type, "info");
    const message = h.notifications[0].message;
    assert.match(message, /📡 Peers:\n/);
    assert.match(message, /Remote peers \(settings\.json\)/);
    assert.match(message, /codex\n    codex relay/);
    assert.match(message, /zeta\n    send: send-zeta %msgfile/);
  });

  it("shows an empty remote section without settings peers and still does not throw on malformed settings", async () => {
    const h = harness();
    fs.rmSync(settingsPath, { force: true });
    await h.handler("list");
    assert.match(h.notifications[0].message, /Remote peers \(settings\.json\):\n  \(none\)/);

    writeSettings("{ not json");
    await h.handler("list");
    assert.equal(h.notifications.length, 2);
    assert.equal(h.notifications[1].type, "info");
    assert.match(h.notifications[1].message, /Failed to load remote peers from/);
    assert.match(h.notifications[1].message, new RegExp(settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("xfer command: completions", () => {
  before(() => {
    writeSettings(`{"peers": {"codex": {"send": "send-codex %msgfile", "note": "codex relay"}, "zeta": {"send": "send-zeta %msgfile"}}}`);
  });

  it("offers the peer subcommand alongside the existing items for an empty prefix", () => {
    const h = harness();
    const items = h.completions("") ?? [];
    const values = items.map((i) => i.value);
    assert.ok(values.includes("list"));
    assert.ok(values.includes("name"));
    assert.ok(values.includes("peer"));
  });

  it("keeps existing completions working", () => {
    const h = harness();
    assert.deepEqual((h.completions("li") ?? []).map((i) => i.value), ["list", "listener"]);
    assert.deepEqual((h.completions("na") ?? []).map((i) => i.value), ["name"]);
  });

  it("completes remote names only after `peer `", () => {
    const h = harness();
    assert.deepEqual((h.completions("peer ") ?? []).map((i) => i.value), ["codex", "zeta"]);
    assert.deepEqual((h.completions("peer co") ?? []).map((i) => i.value), ["codex"]);
    assert.equal(h.completions("peer nope"), null);
  });

  it("returns null instead of crashing on malformed settings", () => {
    writeSettings("{ not json");
    const h = harness();
    assert.equal(h.completions("peer "), null);
  });
});

describe("xfer command: description and help text", () => {
  it("mentions the peer subcommand", async () => {
    const h = harness();
    assert.match(h.description ?? "", /\/xfer peer <name> <req>/);

    await h.handler("help");
    assert.match(h.notifications[0].message, /peer <name> <req>/);
  });
});

describe("xfer command: listener subcommand", () => {
  it("errors with the settings path when listen.bridge is unconfigured", async () => {
    writeSettings(JSON.stringify({ peers: {} }));
    const h = harness();

    await h.handler("listener setup");

    const note = h.notifications[0];
    assert.equal(note.type, "error");
    assert.match(note.message, /listen\.bridge/);
    assert.match(note.message, /settings\.json/);
  });

  it("errors on bad subcommands and handles logs while down", async () => {
    const h = harness();

    await h.handler("listener");
    assert.match(h.notifications[0].message, /Usage/);

    await h.handler("listener logs");
    assert.match(h.notifications[1].message, /bridge not running/);
  });

  it("sets up, shows the bridge line in list/status, then stops", async () => {
    writeSettings(JSON.stringify({ listen: { bridge: "exec sleep 30" } }));
    const h = realHarness();
    try {
      await h.handler("listener setup");
      assert.ok(
        h.notifications.some((n) => /Bridge up/.test(n.message)),
        `setup should notify success, got: ${JSON.stringify(h.notifications)}`,
      );
      assert.ok(h.controller.bridgeInfo().up, "bridge should be up after setup");

      await h.handler("list");
      assert.match(h.notifications.at(-1)!.message, /bridge: up/);
      assert.match(h.notifications.at(-1)!.message, /exec sleep 30/);

      await h.handler("status");
      assert.match(h.notifications.at(-1)!.message, /bridge: up/);
    } finally {
      await h.handler("listener stop"); // never leave a live child hanging the suite
    }
    assert.equal(h.controller.bridgeInfo().up, false);

    await h.handler("list");
    assert.match(h.notifications.at(-1)!.message, /bridge: down/);
  });

  it("reaps the bridge on controller shutdown without blocking", async () => {
    writeSettings(JSON.stringify({ listen: { bridge: "exec sleep 30" } }));
    const h = realHarness();
    try {
      await h.handler("listener setup");
      const info = h.controller.bridgeInfo();
      assert.ok(info.up && info.pid, "bridge up before shutdown");

      h.controller.shutdown(); // sync, fire-and-forget reap

      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !groupGone(info.pid!)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(groupGone(info.pid!), "bridge group must be reaped");
    } finally {
      // Belt and braces: the reap is fire-and-forget — make sure no child survives
      // the suite even if the assertion above failed.
      await h.controller.listenerStop().catch(() => {});
    }
  });
});

describe("xfer command: listener completions", () => {
  it("offers setup/stop/logs for the 'listener ' prefix", () => {
    const h = harness();
    const items = h.completions("listener ") ?? [];
    assert.deepEqual(items.map((i) => i.value), ["setup", "stop", "logs"]);
  });

  it("offers listener and status among top-level subcommands", () => {
    const h = harness();
    const items = h.completions("") ?? [];
    const values = items.map((i) => i.value);
    assert.ok(values.includes("listener"));
    assert.ok(values.includes("status"));
  });
});
