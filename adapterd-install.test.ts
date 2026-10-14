import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_HOSTS, findSkillsRoot, installAgentSkill } from "./adapterd.src/install.js";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-adapterd-install-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function freshDir(): string {
  return fs.mkdtempSync(path.join(tmpDir, "case-"));
}

const LAUNCH = 'node "/opt/xfer/xfer-adapterd.cjs" up --name "agent-x"';

describe("xfer-agent installer", () => {
  it("writes SKILL.md, install.md, the host overlay and .xfer-agent.json", () => {
    const into = freshDir();
    const result = installAgentSkill({
      host: "cursor",
      into,
      name: "agent-x",
      launchCommand: LAUNCH,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    for (const file of ["SKILL.md", "install.md", "overlay-cursor.md"]) {
      assert.ok(fs.existsSync(path.join(into, file)), `${file} written`);
    }
    const config = JSON.parse(fs.readFileSync(result.configPath, "utf-8"));
    assert.deepEqual(config, {
      host: "cursor",
      name: "agent-x",
      launchCommand: LAUNCH,
      generatedAt: "2026-01-02T03:04:05.000Z",
    });

    const skill = fs.readFileSync(path.join(into, "SKILL.md"), "utf-8");
    assert.ok(skill.includes(LAUNCH), "launch command is baked in");
    assert.ok(!skill.includes("{{LAUNCH_COMMAND}}"), "no unrendered placeholder");
    const overlay = fs.readFileSync(path.join(into, "overlay-cursor.md"), "utf-8");
    assert.match(overlay, /Cursor host overlay/);
    assert.ok(!overlay.includes("{{NAME}}"));
    assert.ok(result.files.length >= 4);
  });

  it("renders the generic overlay distinctly", () => {
    const into = freshDir();
    installAgentSkill({ host: "generic", into, name: "agent-g", launchCommand: LAUNCH });
    assert.match(fs.readFileSync(path.join(into, "overlay-generic.md"), "utf-8"), /Generic host overlay/);
  });

  it("rejects an unknown host", () => {
    assert.throws(
      () => installAgentSkill({ host: "emacs", into: freshDir(), name: "a", launchCommand: LAUNCH }),
      /unknown host/,
    );
  });

  it("supports exactly the documented hosts", () => {
    assert.deepEqual([...AGENT_HOSTS], ["cursor", "generic"]);
  });

  it("resolves the in-repo template root from the bundle and the source layouts", () => {
    const fromSource = findSkillsRoot();
    const fromBundle = findSkillsRoot(process.cwd());
    assert.ok(fs.existsSync(path.join(fromSource, "SKILL.md")));
    assert.equal(fs.realpathSync(fromSource), fs.realpathSync(fromBundle));
  });

  it("the bundle install command writes a usable skill and launch command", async () => {
    const into = freshDir();
    const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");
    const child = spawn(
      process.execPath,
      [bundle, "install", "--host", "generic", "--into", into, "--name", "agent-cli"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    const config = JSON.parse(fs.readFileSync(path.join(into, ".xfer-agent.json"), "utf-8"));
    assert.equal(config.host, "generic");
    assert.equal(config.name, "agent-cli");
    assert.match(config.launchCommand, /xfer-adapterd\.cjs" up --name "agent-cli" --mesh$/);
    assert.ok(fs.existsSync(path.join(into, "SKILL.md")));
    assert.ok(fs.readFileSync(path.join(into, "SKILL.md"), "utf-8").includes(config.launchCommand));
  });
});

describe("adapterd install CLI: mesh flag", () => {
  it("includes --mesh by default and honours --no-mesh", async () => {
    const bundle = path.join(import.meta.dirname, "xfer-adapterd.cjs");
    const run = async (...args: string[]): Promise<{ code: number | null; stdout: string }> => {
      const into = freshDir();
      const child = spawn(process.execPath, [bundle, "install", "--host", "generic", "--into", into, "--name", "agent-cli", ...args],
        { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout!.on("data", (c: Buffer) => { stdout += c; });
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      const config = JSON.parse(fs.readFileSync(path.join(into, ".xfer-agent.json"), "utf-8")) as { launchCommand: string };
      return { code: code ?? 1, stdout: config.launchCommand };
    };
    const withMesh = await run();
    assert.equal(withMesh.code, 0);
    assert.match(withMesh.stdout, / up --name "agent-cli" --mesh$/);
    const withoutMesh = await run("--no-mesh");
    assert.equal(withoutMesh.code, 0);
    assert.match(withoutMesh.stdout, / up --name "agent-cli"$/);
    assert.doesNotMatch(withoutMesh.stdout, /--mesh/);
  });
});
