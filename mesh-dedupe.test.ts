import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DELIVERED_WINDOW_SIZE,
  createRivetEngine,
  isDuplicateMeshHandoff,
  meshDuplicateLogLine,
  recordMeshDelivery,
  type MeshHandoffMessage,
  type RivetEngineDeps,
  type XferInstanceState,
} from "./mesh-engine.ts";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-mesh-dedupe-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function logPath(label: string): string {
  return path.join(tmpDir, `${label}-${Math.random().toString(36).slice(2)}.log`);
}

function handoff(id: string, from = "web"): MeshHandoffMessage {
  return { id, from, to: "phone", summary: `summary ${id}`, document: `document ${id}` };
}

function freshState(): XferInstanceState {
  return { description: "", delivered: [] };
}

interface ActorSeam {
  run: (c: unknown) => Promise<void>;
  state: XferInstanceState;
}

interface RunLoopOptions {
  logPath: string;
  onHandoff: (message: MeshHandoffMessage, selfKey: string) => void;
}

/** The actor definition createRivetEngine hands to rivetkit, without the addon. */
async function runLoop(
  messages: MeshHandoffMessage[],
  options: RunLoopOptions,
  selfKey = "phone",
): Promise<XferInstanceState> {
  let captured: ActorSeam | null = null;
  const deps: RivetEngineDeps = {
    ensureRuntimeReady: async () => {},
    importRivetkit: async () => ({
      actor: (definition: ActorSeam) => {
        captured = definition;
        return { definition };
      },
      queue: () => ({}),
      setup: () => ({ startAndWait: async () => {}, shutdown: async () => {} }),
    }),
    importClient: async () => ({
      createClient: () => ({
        getOrCreate: () => ({ resolve: async () => {} }),
        get: () => ({ send: async () => {}, action: async () => "" }),
      }),
    }),
  };
  const engine = createRivetEngine({ endpoint: "http://localhost:6420" }, options.onHandoff, deps, { logPath: options.logPath });
  await engine.ensureNode(selfKey);
  assert.ok(captured, "the actor definition reached the seam");
  const definition = captured as ActorSeam;
  const actorState: XferInstanceState = { ...definition.state, delivered: [...(definition.state.delivered ?? [])] };
  const queue = {
    async *iter() {
      for (const body of messages) yield { body };
    },
  };
  await definition.run({ key: [selfKey], state: actorState, queue });
  return actorState;
}

function logLines(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf-8").trim().split("\n").filter((line) => line !== "");
}

function duplicateLines(logPath: string): string[] {
  return logLines(logPath).filter((line) => line.includes("mesh duplicate"));
}

describe("mesh receiver dedupe (pure window)", () => {
  it("starts empty and treats every id as new", () => {
    const state = freshState();
    assert.equal(isDuplicateMeshHandoff(state, handoff("a")), false);
    assert.equal(isDuplicateMeshHandoff({ description: "" }, handoff("a")), false, "an actor that never received one has no window");
  });

  it("records after deciding, idempotently, and never mutates on a lookup", () => {
    const state = freshState();
    assert.equal(isDuplicateMeshHandoff(state, handoff("a")), false);
    assert.deepEqual(recordMeshDelivery(state, handoff("a")), ["a"]);
    assert.equal(isDuplicateMeshHandoff(state, handoff("a")), true);
    assert.deepEqual(state.delivered, ["a"], "a hit leaves the window as it was");
    recordMeshDelivery(state, handoff("a"));
    assert.deepEqual(state.delivered, ["a"], "re-recording one id does not duplicate it");
  });

  it("holds at most the sliding-window bound, evicting the oldest", () => {
    const state = freshState();
    for (const id of ["a", "b", "c", "d"]) recordMeshDelivery(state, handoff(id));
    assert.equal(DELIVERED_WINDOW_SIZE, 3);
    assert.deepEqual(state.delivered, ["b", "c", "d"]);
    assert.equal(isDuplicateMeshHandoff(state, handoff("a")), false, "the edge of the window is accepted as new");
    assert.equal(isDuplicateMeshHandoff(state, handoff("b")), true);
  });

  it("writes exactly one duplicate record, carrying the id on every line", () => {
    const written: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
    meshDuplicateLogLine((level, event, fields) => written.push({ level, event, fields }), handoff("dup-1", "web"), "phone");
    assert.equal(written.length, 1);
    assert.equal(written[0].event, "mesh duplicate");
    assert.equal(written[0].fields.id, "dup-1");
    assert.equal(written[0].fields.from, "web");
    assert.equal(written[0].fields.to, "phone");
  });
});

describe("mesh receiver dedupe (actor run loop)", () => {
  it("delivers a redelivered handoff id once and logs one mesh duplicate line", async () => {
    const delivered: MeshHandoffMessage[] = [];
    const log = logPath("twice");
    const state = await runLoop([handoff("dup-1"), handoff("dup-1")], {
      logPath: log,
      onHandoff: (message) => delivered.push(message),
    });
    assert.deepEqual(delivered.map((message) => message.id), ["dup-1"]);
    assert.deepEqual(state.delivered, ["dup-1"]);
    const duplicates = duplicateLines(log);
    assert.equal(duplicates.length, 1, "a drop writes exactly one line");
    assert.match(duplicates[0], /msg="mesh duplicate" id=dup-1 from=web to=phone/);
  });

  it("delivers a fourth distinct id, then redelivers the evicted first one", async () => {
    const delivered: MeshHandoffMessage[] = [];
    const log = logPath("window");
    const state = await runLoop(
      [handoff("a"), handoff("b"), handoff("c"), handoff("d"), handoff("a"), handoff("d")],
      { logPath: log, onHandoff: (message) => delivered.push(message) },
    );
    assert.deepEqual(delivered.map((message) => message.id), ["a", "b", "c", "d", "a"], "the evicted id is applied again");
    assert.deepEqual(state.delivered, ["c", "d", "a"], "the window slides: d stays inside it, c is now the edge");
    assert.equal(duplicateLines(log).length, 1, "only the still-windowed id is dropped");
    assert.match(duplicateLines(log)[0], /id=d from=web/);
  });

  it("records only after the delivery, so a throwing onHandoff leaves the id unrecorded", async () => {
    let calls = 0;
    const log = logPath("throw");
    const state = await runLoop([handoff("boom")], {
      logPath: log,
      onHandoff: () => {
        calls += 1;
        throw new Error("deliver failed");
      },
    }).catch((err: unknown) => {
      assert.match(err instanceof Error ? err.message : String(err), /deliver failed/);
      return null;
    });
    assert.equal(calls, 1);
    assert.equal(state, null, "the run loop propagates so the queue can redeliver");

    const retried = freshState();
    assert.equal(isDuplicateMeshHandoff(retried, handoff("boom")), false, "the failed delivery was not recorded");
    assert.deepEqual(duplicateLines(log), []);
  });

  it("writes no document and no inbound line for a duplicate (decided before the delivery)", async () => {
    const log = logPath("before-tmp");
    const payload = "-----BEGIN HANDOFF-----";
    const same = { id: "pre-tmp", from: "web", to: "phone", summary: "s", document: payload };
    let seen = 0;
    await runLoop([same, same], {
      logPath: log,
      onHandoff: () => { seen += 1; },
    });
    assert.equal(seen, 1, "onHandoff — the only writer of the /tmp document — ran once");
    const lines = logLines(log);
    assert.equal(lines.filter((line) => line.includes("mesh duplicate")).length, 1);
    assert.equal(lines.some((line) => line.includes("mesh inbound")), false, "the receiver sink never saw the duplicate");
    assert.equal(lines.some((line) => line.includes(payload)), false, "handoff bodies never reach the log");
  });
});
