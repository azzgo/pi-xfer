import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  appendMeshLogLine,
  createMeshLogSink,
  formatMeshLogLine,
  logMeshEvent,
  MESH_LOG_LEVEL,
  shouldLog,
} from "./mesh-log.js";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-mesh-log-test-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function tmpLog(label: string): string {
  return path.join(tmpDir, `${label}-${Math.random().toString(36).slice(2)}.log`);
}

describe("mesh log formatting", () => {
  it("writes ts, level, message, then the fields", () => {
    const line = formatMeshLogLine("warn", "mesh misroute", { id: "m1", reached: "web" });
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=warn msg="mesh misroute" id=m1 reached=web$/);
  });

  it("quotes values that would break the line and drops unsafe key characters", () => {
    const line = formatMeshLogLine("error", 'failed "hard"', { "my key": "two words", empty: "", retries: 3, circular: { ok: true } });
    assert.match(line, /msg="failed \\"hard\\""/);
    assert.match(line, /mykey="two words"/);
    assert.match(line, /empty=""/);
    assert.match(line, /retries=3/);
    assert.match(line, /circular="\{\\"ok\\":true\}"/);
  });

  it("keeps rivetkit's object-only records message-free instead of writing an empty msg", () => {
    const line = formatMeshLogLine("info", "", { rivetkitVersion: "2.3.26" });
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z level=info rivetkitVersion=2\.3\.26$/);
  });

  it("gates on the file level, which is a constant and not an env knob", () => {
    assert.equal(MESH_LOG_LEVEL, "info");
    assert.equal(shouldLog("debug"), false, "rivetkit's debug chatter stays out of the file");
    assert.equal(shouldLog("warn"), true);
  });
});

describe("mesh log sink", () => {
  it("captures the pino call shapes rivetkit uses, including child bindings", () => {
    const logPath = tmpLog("sink");
    const sink = createMeshLogSink({ path: logPath });
    sink.info("starting rivetkit envoy", { riverkitVersion: "2.3.26" });
    sink.warn({ error: new Error("boom") }, "auto-listen failed");
    sink.child({ actorName: "web", actorId: "a1" }).error({ code: "E1" }, "action failed");
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    assert.match(lines[0] ?? "", /level=info msg="starting rivetkit envoy"/);
    assert.match(lines[1] ?? "", /level=warn msg="auto-listen failed" error=boom/);
    assert.match(lines[2] ?? "", /level=error msg="action failed" actorName=web actorId=a1 code=E1/);
    assert.equal(lines.length, 3);
  });

  it("drops records below the file level", () => {
    const logPath = tmpLog("gated");
    const sink = createMeshLogSink({ path: logPath });
    sink.trace("too detailed");
    sink.debug("also dropped");
    assert.equal(fs.existsSync(logPath), false, "nothing is written at all when everything is gated out");
  });

  it("never throws, so a broken log target cannot break the mesh", () => {
    const sink = createMeshLogSink({ path: path.join(tmpDir, "no-such-dir", "mesh.log") });
    sink.error("this goes nowhere");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => sink.warn({ circular }, "still fine"));
    assert.doesNotThrow(() => appendMeshLogLine(path.join(tmpDir, "no-such-dir", "mesh.log"), "line"));
  });
});

describe("mesh log events", () => {
  it("appends extension events as their own records", () => {
    const logPath = tmpLog("events");
    logMeshEvent(logPath, "info", "mesh up", { node: "web", endpoint: "http://localhost:6420" });
    logMeshEvent(logPath, "error", "mesh up failed", { node: "web", error: "engine unreachable" });
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    assert.match(lines[0] ?? "", /level=info msg="mesh up" node=web endpoint=http:\/\/localhost:6420/);
    assert.match(lines[1] ?? "", /level=error msg="mesh up failed" node=web error="engine unreachable"/);
  });
});
