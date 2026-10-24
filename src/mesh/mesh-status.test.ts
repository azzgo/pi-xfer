import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meshListing, type MeshNodeInfo, type MeshRunnerInfo } from "./mesh-engine.ts";
import {
  MESH_STATE_MARKS,
  MESH_STATE_ORDER,
  meshLegendLine,
  meshRows,
  meshSelfAdvice,
  meshSelfStatus,
  meshStatusLines,
  meshTableLines,
  poolLabel,
} from "./mesh-status.ts";

const node = (name: string, status: MeshNodeInfo["status"], pool?: string): MeshNodeInfo => ({
  name,
  actorId: `actor-${name}`,
  status,
  ...(pool ? { pool } : {}),
});

const runner = (pool: string): MeshRunnerInfo => ({ pool, envoyKey: `envoy-${pool}`, lastPingTs: 1 });

describe("mesh status vocabulary", () => {
  it("assigns one glyph per state and never labels anything offline", () => {
    assert.deepEqual(MESH_STATE_ORDER.map((state) => MESH_STATE_MARKS[state].glyph), ["●", "◐", "○", "⚠", "·", "✗", "?"]);
    assert.deepEqual(MESH_STATE_ORDER.map((state) => MESH_STATE_MARKS[state].label), [
      "running",
      "sleeping",
      "no runner",
      "mismatch",
      "pending",
      "crashed",
      "unknown",
    ]);
    for (const state of MESH_STATE_ORDER) {
      assert.doesNotMatch(MESH_STATE_MARKS[state].label, /offline/i);
    }
  });

  it("legends every state once, in scan order", () => {
    const legend = meshLegendLine();
    assert.match(legend, /● running · ◐ sleeping · ○ no runner · ⚠ mismatch · · pending · ✗ crashed · \? unknown/);
  });

  it("keeps the engine's default pool spelled (default)", () => {
    assert.equal(poolLabel(undefined), "(default)");
    assert.equal(poolLabel(""), "(default)");
    assert.equal(poolLabel("host-a"), "host-a");
  });
});

describe("mesh row derivation", () => {
  it("gives every live node a state from the raw actor record joined with the pool's runners", () => {
    const listing = meshListing(
      [
        node("running", "Running", "host-a"),
        node("asleep", "Sleeping", "host-a"),
        node("idle", "Idle", "host-a"),
        node("pending", "Pending"),
        node("broken", "Crashed", "host-a"),
        node("lonely", "Sleeping", "host-b"),
      ],
      [runner("host-a"), runner("default")],
    );
    assert.deepEqual(meshRows(listing, null).map((row) => row.state), [
      "Running",
      "Sleeping",
      "Mismatch",
      "Pending",
      "Crashed",
      "NoRunner",
    ]);
  });

  it("reads a runner-less pool as no runner whatever the actor record claims", () => {
    const listing = meshListing([node("idle", "Idle", "host-b"), node("asleep", "Sleeping", "host-b")], [runner("host-a")]);
    assert.deepEqual(meshRows(listing, null).map((row) => row.state), ["NoRunner", "NoRunner"]);
  });

  it("renders every row unknown when the engine did not answer /envoys", () => {
    const listing = meshListing([node("phone", "Running", "host-a"), node("idle", "Idle", "host-b")], null);
    assert.deepEqual(meshRows(listing, null).map((row) => row.state), ["Unknown", "Unknown"]);
    const lines = meshTableLines(listing, null);
    assert.match(lines[0]!, /\? phone\s+unknown/);
    assert.match(lines[0]!, /did not answer \/envoys/);
    assert.doesNotMatch(lines.join("\n"), /offline/i);
  });

  it("marks this node and leaves the others unmarked", () => {
    const listing = meshListing([node("phone", "Sleeping", "host-a"), node("web", "Running", "host-a")], [runner("host-a")]);
    const rows = meshRows(listing, "web");
    assert.deepEqual(rows.map((row) => row.isSelf), [false, true]);
    const lines = meshTableLines(listing, "web");
    assert.match(lines[1]!, /web \(this node\)/);
    assert.doesNotMatch(lines[0]!, /this node/);
  });

  it("names the pool, never the node, as the reason a row is not deliverable", () => {
    const listing = meshListing([node("phone", "Idle", "host-b")], [runner("host-a")]);
    const line = meshTableLines(listing, null)[0]!;
    assert.match(line, /○/);
    assert.match(line, /no runner in pool "host-b"/);
    assert.match(line, /pool host-b/);
    assert.doesNotMatch(line, /phone.*(offline|down)/i);
  });

  it("says why a mismatch row is flagged, crediting the pool's runner", () => {
    const listing = meshListing([node("phone", "Idle", "host-b")], [runner("host-b")]);
    const line = meshTableLines(listing, null)[0]!;
    assert.match(line, /⚠/);
    assert.match(line, /pool "host-b" has a runner, but the actor record still reads idle/);
  });

  it("spells the default pool the same way in the table and in the reason", () => {
    const listing = meshListing([node("phone", "Sleeping")], [runner("host-a")]);
    const line = meshTableLines(listing, null)[0]!;
    assert.match(line, /pool \(default\)/);
    assert.match(line, /no runner in pool "\(default\)"/);
  });

  it("keeps a live node's row distinct from a runner-less one", () => {
    const listing = meshListing([node("live", "Sleeping", "host-a"), node("dead", "Sleeping", "host-b")], [runner("host-a")]);
    const [live, dead] = meshTableLines(listing, null);
    assert.match(live!, /◐ live\s+sleeping/);
    assert.match(dead!, /○ dead\s+no runner/);
    assert.notEqual(live, dead);
  });
});

describe("mesh self status", () => {
  it("reports the runner count of this host's own pool, not the engine total", () => {
    const status = meshSelfStatus(
      meshListing([node("web", "Running", "host-a")], [runner("host-a"), runner("host-b"), runner("host-b")]),
      { online: true, name: "web" },
      "host-a",
    );
    assert.equal(status.pool, "host-a");
    assert.equal(status.poolHasRunner, true);
    assert.equal(status.runnerCount, 1);
    assert.equal(status.actorState, "Running");
  });

  it("falls back to the default pool when the config sets none", () => {
    const status = meshSelfStatus(meshListing([], [runner("default")]), { online: false, name: null }, undefined);
    assert.equal(status.pool, "default");
    assert.equal(status.poolHasRunner, true);
  });

  it("keeps actor state unknown when this node is not listed", () => {
    const status = meshSelfStatus(meshListing([node("other", "Running")], []), { online: true, name: "web" }, "host-a");
    assert.equal(status.actorState, null);
    assert.equal(status.poolHasRunner, false);
  });
});

describe("mesh status rendering", () => {
  it("summarises an online node with its pool, its runners and the listing size", () => {
    const status = meshSelfStatus(
      meshListing([node("web", "Running", "host-a"), node("phone", "Sleeping", "host-b")], [runner("host-a")]),
      { online: true, name: "web" },
      "host-a",
    );
    const lines = meshStatusLines(status, "https://engine.example").join("\n");
    assert.match(lines, /● this node\s+"web" — online in this session/);
    assert.match(lines, /◐ engine\s+https:\/\/engine\.example/);
    assert.match(lines, /● runner\s+1 live runner\(s\) in pool "host-a"/);
    assert.match(lines, /· listing\s+2 node\(s\) on the engine/);
    assert.doesNotMatch(lines, /→ fix/);
  });

  it("says a runner-less pool cannot receive and names the fix", () => {
    const status = meshSelfStatus(meshListing([], []), { online: false, name: null }, "host-a");
    const lines = meshStatusLines(status, "https://engine.example").join("\n");
    assert.match(lines, /○ this node\s+not up in this session/);
    assert.match(lines, /○ runner\s+no runner in pool "host-a" — this machine cannot receive a handoff/);
    assert.match(lines, /→ fix\s+run a runner in pool "host-a" on this machine/);
  });

  it("reports an unanswered /envoys as unknown rather than as a missing runner", () => {
    const status = meshSelfStatus(meshListing([node("web", "Running", "host-a")], null), { online: true, name: "web" }, "host-a");
    const lines = meshStatusLines(status, "https://engine.example").join("\n");
    assert.match(lines, /\? runner\s+the engine did not answer \/envoys/);
    assert.doesNotMatch(lines, /cannot receive/);
    assert.doesNotMatch(lines, /→ fix/);
  });

  it("advises about the listing only when this host is up and its pool is empty", () => {
    const offline = meshSelfStatus(meshListing([], []), { online: false, name: null }, "host-a");
    assert.equal(meshSelfAdvice(offline), null, "an offline node gets no listing advice");
    const unreachable = meshSelfStatus(meshListing([], null), { online: true, name: "web" }, "host-a");
    assert.equal(meshSelfAdvice(unreachable), null, "an unanswered /envoys is not a missing runner");
    const stranded = meshSelfStatus(meshListing([], []), { online: true, name: "web" }, "host-a");
    assert.match(meshSelfAdvice(stranded) ?? "", /pool "host-a" has no runner — handoffs sent here queue until one appears/);
    const healthy = meshSelfStatus(meshListing([], [runner("host-a")]), { online: true, name: "web" }, "host-a");
    assert.equal(meshSelfAdvice(healthy), null);
  });
});

describe("mesh status: one vocabulary for every surface", () => {
  it("is the only module that spells a verdict glyph", async () => {
    const fs = await import("node:fs");
    const root = import.meta.dirname;
    const surfaces = [["commands.ts", "../commands.ts"], ["admin-main.ts", "../../admin-main.ts"]]
      .filter(([, p]) => fs.existsSync(`${root}/${p}`))
      .map(([name]) => name);
    assert.deepEqual(surfaces.sort(), ["admin-main.ts", "commands.ts"], "sanity: both surfaces exist");
    for (const name of surfaces) {
      const source = fs.readFileSync(new URL(name === "commands.ts" ? "../commands.ts" : "../../admin-main.ts", import.meta.url), "utf-8");
      const verdictShapes = MESH_STATE_ORDER
        .map((state) => `${MESH_STATE_MARKS[state].glyph} ${MESH_STATE_MARKS[state].label}`)
        .filter((shape) => source.includes(shape));
      assert.deepEqual(verdictShapes, [], `${name} must take verdict glyph/label pairs from mesh-status.ts, not spell them`);
    }
  });

  it("keeps the labels the legend and the rows both show", () => {
    const legend = meshLegendLine();
    for (const state of MESH_STATE_ORDER) {
      assert.ok(legend.includes(MESH_STATE_MARKS[state].label), `${state} label missing from the legend`);
      assert.ok(legend.includes(MESH_STATE_MARKS[state].glyph), `${state} glyph missing from the legend`);
    }
  });
});
