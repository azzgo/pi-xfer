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
import { DEFAULT_SETTINGS_PATH, interpolate, loadSettings, validateSettings } from "./settings.js";

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

describe("interpolate", () => {
  it("returns the empty template unchanged", () => {
    assert.equal(interpolate("", { p: "1", n: "n", peer: "peer", msgfile: "m" }), "");
  });

  it("interpolates each var individually", () => {
    assert.equal(interpolate("%p", { p: "4711" }), "4711");
    assert.equal(interpolate("%n", { n: "pi" }), "pi");
    assert.equal(interpolate("%peer", { peer: "codex" }), "codex");
    assert.equal(interpolate("%msgfile", { msgfile: "/tmp/handoff.md" }), "/tmp/handoff.md");
  });

  it("emits a literal % for %% without consulting vars", () => {
    assert.equal(interpolate("%%", {}), "%");
    assert.equal(interpolate("a%%b%%c", {}), "a%b%c");
    assert.equal(interpolate("send %p%%", { p: "4711" }), "send 4711%");
  });

  it("matches tokens maximal-munch", () => {
    assert.equal(interpolate("%peer", { p: "P", peer: "codex" }), "codex");
    assert.equal(interpolate("%msgfile", { msgfile: "/m.md", p: "P" }), "/m.md");
    assert.throws(() => interpolate("%pfile", { p: "P" }), /Unknown template token '%pfile'/);
  });

  it("interpolates a combined template with multiple tokens and literals", () => {
    const tpl = "pi xfer send --to %peer --name %n --file %msgfile --port %p";
    assert.equal(
      interpolate(tpl, { p: "4711", n: "pi", peer: "codex", msgfile: "/tmp/h.md" }),
      "pi xfer send --to codex --name pi --file /tmp/h.md --port 4711",
    );
  });

  it("throws on unknown tokens, naming the token and the template", () => {
    const cases: Array<[string, string]> = [
      ["%msg", "%msg"],
      ["%P", "%P"],
      ["%x", "%x"],
      ["100%", "%"],
    ];
    for (const [tpl, token] of cases) {
      assert.throws(
        () => interpolate(tpl, { p: "1", n: "n", peer: "peer", msgfile: "m" }),
        (err: Error) => err.message.includes(token) && err.message.includes(tpl),
        `expected ${tpl} to be rejected`,
      );
    }
  });

  it("throws when a referenced var is undefined, naming var and token", () => {
    assert.throws(
      () => interpolate("send to %peer", {}),
      (err: Error) =>
        err.message.includes("%peer") && err.message.includes("vars.peer") && err.message.includes("send to %peer"),
    );
    assert.throws(() => interpolate("%p %n", { p: "1" }), /vars\.n/);
  });

  it("interpolates repeated occurrences of the same token", () => {
    assert.equal(interpolate("%p:%p:%p", { p: "7" }), "7:7:7");
    assert.equal(interpolate("cp %msgfile %msgfile.bak", { msgfile: "/m.md" }), "cp /m.md /m.md.bak");
  });

  it("tolerates supplied-but-unused vars", () => {
    assert.equal(interpolate("run %p", { p: "4711", n: "x", peer: "y", msgfile: "z" }), "run 4711");
  });

  it("keeps adjacent literal text intact", () => {
    assert.equal(interpolate("--peer=%peer,x", { peer: "c" }), "--peer=c,x");
    assert.equal(interpolate("50%% done", {}), "50% done");
  });
});
