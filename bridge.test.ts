/**
 * Run via `npm test` in this directory (same resolve-hook setup as settings.test.ts —
 * see the header there). These tests spawn real `sh` bridge commands against a real
 * `XferController` TCP listener (127.0.0.1:0); BridgeContext is a stub that captures
 * notifications. Every manager is registered for the `after()` cleanup so a failing
 * assertion can never leave a listener or child holding the event loop open.
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import { BridgeManager, type BridgeContext } from "./bridge.js";
import { XferController } from "./controller.js";
import { XferState } from "./state.js";

interface CapturedNotify {
  message: string;
  level: "info" | "error" | "warning";
}

interface Harness {
  manager: BridgeManager;
  ctx: BridgeContext;
  notes: CapturedNotify[];
}

const cleaners: BridgeManager[] = [];

/** Manager over a real controller (sendMessage is never reached in these tests). */
function makeManager(echoWindowMs?: number): Harness {
  const controller = new XferController({ sendMessage() {} } as never, new XferState());
  const notes: CapturedNotify[] = [];
  const ctx: BridgeContext = {
    notify: (message, level) => {
      notes.push({ message, level: level ?? "info" });
    },
  };
  const manager = new BridgeManager(
    echoWindowMs === undefined ? { controller } : { controller, echoWindowMs },
  );
  cleaners.push(manager);
  return { manager, ctx, notes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await sleep(20);
  }
}

async function assertConnects(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

/** Bind the given port with a throwaway server to prove the bridge released it. */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });
}

after(async () => {
  for (const manager of cleaners) {
    await manager.stop({ notify() {} });
  }
});

describe("BridgeManager setup", () => {
  it("spawns the command, reports pid/port and accepts TCP connections", async () => {
    const { manager, ctx, notes } = makeManager();
    const info = await manager.setup(ctx, "exec sleep 5");

    assert.ok(info.pid > 0, "pid should be positive");
    assert.ok(info.port > 0, "port should be positive");
    assert.equal(manager.isUp(), true);
    assert.equal(manager.pid(), info.pid);
    assert.equal(manager.port(), info.port);
    assert.ok(
      notes.some((n) => n.message === `🌉 Bridge up — pid ${info.pid}, port ${info.port}`),
      `success notify missing, got: ${JSON.stringify(notes)}`,
    );
    await assertConnects(info.port);

    await manager.stop(ctx);
  });

  it("interpolates %p to the listener port in the command output", async () => {
    const { manager, ctx, notes } = makeManager(1_000);
    await manager.setup(ctx, "echo PORT=%p");

    await waitFor(
      () => notes.some((n) => n.message.includes(`PORT=${manager.port()}`)),
      "echoed PORT=<port> line",
    );

    await manager.stop(ctx);
  });

  it("throws and notifies on an empty template", async () => {
    const { manager, ctx, notes } = makeManager();
    await assert.rejects(() => manager.setup(ctx, ""), /template/);
    assert.equal(manager.isUp(), false);
    const errorNote = notes.find((n) => n.level === "error" && n.message.includes("empty"));
    assert.ok(errorNote, `error notify missing, got: ${JSON.stringify(notes)}`);
  });
});

describe("BridgeManager output capture", () => {
  it("keeps only the newest 200 ring lines across stdout and stderr", async () => {
    const { manager, ctx, notes } = makeManager(50);
    await manager.setup(
      ctx,
      "i=0; while [ $i -lt 250 ]; do echo line$i; i=$((i+1)); done",
    );

    await waitFor(() => notes.some((n) => n.message.includes("exited")), "child exit notify");

    // The dump is any note starting with the log header; retry until the last dump
    // holds the newest line (stdio flush can trail the exit event slightly).
    const lastDump = () => {
      manager.logs(ctx); // refresh the dump — logs() is what emits the log header note
      const dumps = notes.filter((n) => n.message.startsWith("🌉 bridge log"));
      return dumps[dumps.length - 1]?.message ?? "";
    };
    await waitFor(
      () => lastDump().includes("[out] line249") && !lastDump().includes("[out] line0"),
      "ring buffer settled to the newest 200 lines",
    );

    const dump = lastDump();
    const taggedLines = dump.split("\n").filter((l) => /^\[(out|err)\] /.test(l));
    assert.equal(taggedLines.length, 200, "ring should hold exactly 200 tagged lines");
    assert.ok(dump.includes("[out] line249"), "newest line kept");
    assert.ok(!dump.includes("[out] line0"), "oldest line dropped");
    assert.ok(!dump.includes("[out] line49"), "everything past the cap dropped");

    await manager.stop(ctx);
  });

  it("echoes early output once, then latches the window shut", async () => {
    const { manager, ctx, notes } = makeManager(100);
    await manager.setup(
      ctx,
      "echo a1; echo a2; echo a3; sleep 0.4; echo b1; echo b2; echo b3",
    );

    // Wait past the 400ms mark so the b-lines have definitely arrived (or the child
    // exited), then check the echo count stopped growing after the window closed.
    await waitFor(
      () => notes.some((n) => n.message.includes("exited")),
      "child exit after b-lines",
      3_000,
    );

    const echoes = notes.filter((n) => n.message.startsWith("🌉 bridge:"));
    assert.ok(echoes.length >= 1, "at least one early line should be echoed");
    assert.ok(echoes.length <= 3, `echo must stop after the window, got ${echoes.length} lines`);
    assert.ok(
      echoes.every((n) => !n.message.includes("b1")),
      `late lines must not be echoed: ${JSON.stringify(echoes)}`,
    );

    await manager.stop(ctx);
  });

  it("reports 'bridge not running' from logs when not up", () => {
    const { manager, ctx, notes } = makeManager();
    manager.logs(ctx);
    assert.deepEqual(notes, [{ message: "🌉 bridge not running", level: "warning" }]);
  });
});

describe("BridgeManager stop", () => {
  it("SIGTERMs the group fast, closes the listener and clears state", async () => {
    const { manager, ctx } = makeManager(50);
    const info = await manager.setup(ctx, "sleep 30");
    const pid = info.pid;

    const startedAt = Date.now();
    await manager.stop(ctx);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 3_000, `stop ladder took ${elapsed}ms`);
    assert.equal(manager.isUp(), false);
    assert.equal(manager.pid(), undefined);
    assert.equal(manager.port(), undefined);
    // The whole process group is gone (ESRCH on a group-id probe).
    assert.throws(() => process.kill(-pid, 0), /ESRCH/);
    await assertPortFree(info.port);
  });

  it("is a no-op on double stop and when never started", async () => {
    const { manager, ctx } = makeManager();
    await manager.stop(ctx);
    assert.equal(manager.isUp(), false);

    await manager.setup(ctx, "sleep 30");
    await manager.stop(ctx);
    await manager.stop(ctx);
    assert.equal(manager.isUp(), false);
  });

  it("restarts cleanly when setup is called on a running bridge", async () => {
    const { manager, ctx } = makeManager(1_000);
    const first = await manager.setup(ctx, "exec sleep 30");
    const second = await manager.setup(ctx, "exec sleep 30");

    assert.ok(second.pid > 0, "second setup should spawn a fresh command");
    assert.notEqual(second.pid, first.pid, "old command should have been stopped first");
    assert.equal(manager.pid(), second.pid);
    await assertConnects(second.port);

    await manager.stop(ctx);
    assert.throws(() => process.kill(-first.pid, 0), /ESRCH/, "first command must be dead");
  });
});

describe("BridgeManager child lifecycle", () => {
  it("notifies the exit code when the bridge command exits on its own", async () => {
    const { manager, ctx, notes } = makeManager(1_000);
    await manager.setup(ctx, "exit 7");

    await waitFor(
      () => notes.some((n) => n.message.includes("exited (code 7)")),
      "exited (code 7) notify",
    );

    await manager.stop(ctx);
  });
});
