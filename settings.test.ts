/**
 * Run via `npm test` in this directory. The script injects a `module.registerHooks`
 * resolve hook (see package.json) because Node's type stripping resolves the repo's
 * `.js`-suffixed relative imports (e.g. `./settings.js`) only if the hook remaps
 * them to the co-located `.ts` files; plain `node --test` discovery of `*.test.ts`
 * works fine on this Node, only specifier resolution needs the fallback.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SETTINGS_PATH, loadSettings, validateSettings } from "./settings.js";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-settings-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSettings(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadSettings", () => {
  it("returns {} when the file is absent", () => {
    assert.deepEqual(loadSettings(path.join(tmpDir, "missing.json")), {});
  });

  it("round-trips a valid settings file", () => {
    const p = writeSettings("valid.json", `{
  "listen": { "bridge": "pi" },
  "peers": {
    "codex": { "send": "codex e-notify --file {file}", "timeoutMs": 3000, "note": "main peer" }
  }
}`);
    assert.deepEqual(loadSettings(p), {
      listen: { bridge: "pi" },
      peers: {
        codex: { send: "codex e-notify --file {file}", timeoutMs: 3000, note: "main peer" },
      },
    });
  });

  it("tolerates unknown top-level keys", () => {
    const p = writeSettings("unknown.json", `{"listen": {"bridge": "pi"}, "experimental": {"x": 1}}`);
    assert.deepEqual(loadSettings(p), { listen: { bridge: "pi" } });
  });

  it("honors the custom path argument", () => {
    const first = writeSettings("custom.json", `{"peers": {"a": {"send": "run"}}}`);
    assert.deepEqual(loadSettings(first), { peers: { a: { send: "run" } } });
    const second = writeSettings("other.json", `{"listen": {"bridge": "other"}}`);
    assert.deepEqual(loadSettings(second), { listen: { bridge: "other" } });
  });

  it("throws with path + line info for malformed JSON", () => {
    const p = writeSettings("malformed.json", `{
  "listen": {
    "bridge": "pi"`);
    assert.throws(
      () => loadSettings(p),
      (err: Error) => err.message.includes(p) && err.message.includes("line 3"),
    );
  });

  it("throws with path + aggregated errors for shape-invalid JSON", () => {
    const p = writeSettings("invalid.json", `{"listen": {}, "peers": {"codex": {}}}`);
    assert.throws(
      () => loadSettings(p),
      (err: Error) =>
        err.message.includes(p)
        && err.message.includes("listen.bridge")
        && err.message.includes("peers.codex.send"),
    );
  });
});

describe("validateSettings", () => {
  function rejects(name: string, raw: unknown, expected: string): void {
    it(name, () => {
      const result = validateSettings(raw);
      assert.equal(result.valid, false);
      if (!result.valid) {
        assert.ok(
          result.errors.some((e) => e.includes(expected)),
          `expected an error containing ${JSON.stringify(expected)}, got ${JSON.stringify(result.errors)}`,
        );
      }
    });
  }

  it("accepts an empty object", () => {
    assert.deepEqual(validateSettings({}), { valid: true, settings: {} });
  });

  it("accepts fully-specified settings", () => {
    const raw = {
      listen: { bridge: "pi" },
      peers: { codex: { send: "run {file}", timeoutMs: 1500, note: "n" } },
    };
    assert.deepEqual(validateSettings(raw), { valid: true, settings: raw });
  });

  it("tolerates unknown top-level keys", () => {
    const result = validateSettings({ listen: { bridge: "pi" }, mystery: true });
    assert.deepEqual(result, { valid: true, settings: { listen: { bridge: "pi" } } });
  });

  it("collects one error per problem", () => {
    const result = validateSettings({ listen: {}, peers: { a: { send: "run", timeoutMs: -1 }, b: "x" } });
    assert.equal(result.valid, false);
    if (!result.valid) assert.equal(result.errors.length, 3);
  });

  rejects("rejects a non-object root (null)", null, "settings: must be a JSON object");
  rejects("rejects a non-object root (array)", [], "settings: must be a JSON object");
  rejects("rejects a non-object root (number)", 7, "settings: must be a JSON object");
  rejects("rejects non-object listen", { listen: "pi" }, "listen: must be an object");
  rejects("rejects missing listen.bridge", { listen: {} }, "listen.bridge: must be a non-empty string");
  rejects("rejects non-string listen.bridge", { listen: { bridge: 3 } }, "listen.bridge");
  rejects("rejects empty-string listen.bridge", { listen: { bridge: "" } }, "listen.bridge");
  rejects("rejects non-object peers", { peers: [] }, "peers: must be an object");
  rejects("rejects non-object peer entry", { peers: { codex: "run" } }, "peers.codex: must be an object");
  rejects("rejects missing peer send", { peers: { codex: { timeoutMs: 100 } } }, "peers.codex.send");
  rejects("rejects non-string peer send", { peers: { codex: { send: 9 } } }, "peers.codex.send");
  rejects("rejects empty-string peer send", { peers: { codex: { send: "" } } }, "peers.codex.send");
  rejects("rejects zero timeoutMs", { peers: { codex: { send: "run", timeoutMs: 0 } } }, "peers.codex.timeoutMs");
  rejects("rejects negative timeoutMs", { peers: { codex: { send: "run", timeoutMs: -1 } } }, "peers.codex.timeoutMs");
  rejects("rejects NaN timeoutMs", { peers: { codex: { send: "run", timeoutMs: Number.NaN } } }, "peers.codex.timeoutMs");
  rejects(
    "rejects Infinity timeoutMs",
    { peers: { codex: { send: "run", timeoutMs: Number.POSITIVE_INFINITY } } },
    "peers.codex.timeoutMs",
  );
  rejects(
    "rejects non-number timeoutMs",
    { peers: { codex: { send: "run", timeoutMs: "100" } } },
    "peers.codex.timeoutMs",
  );
  rejects("rejects non-string note", { peers: { codex: { send: "run", note: 1 } } }, "peers.codex.note");
});

describe("DEFAULT_SETTINGS_PATH", () => {
  it("points at ~/.pi/xfer/settings.json", () => {
    assert.equal(DEFAULT_SETTINGS_PATH, path.join(os.homedir(), ".pi", "xfer", "settings.json"));
  });
});
