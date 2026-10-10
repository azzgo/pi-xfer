import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { after, before, describe, it } from "node:test";
import {
  RIVETKIT_VERSION,
  downloadNativeBinding,
  extractNodeFromTgz,
  installNapiRequireShim,
  nativeBindingPath,
  platformTriple,
} from "./mesh-native.js";

let tmpDir: string;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-mesh-native-test-")); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("mesh native: platform triple", () => {
  it("maps linux/mac/windows to napi package triples", () => {
    assert.equal(platformTriple("linux", "x64"), "linux-x64-gnu");
    assert.equal(platformTriple("linux", "arm64"), "linux-arm64-gnu");
    assert.equal(platformTriple("darwin", "arm64"), "darwin-universal");
    assert.equal(platformTriple("win32", "x64"), "x64-msvc");
    assert.equal(platformTriple("freebsd", "x64"), null);
    assert.equal(platformTriple("linux", "ppc64le"), null);
  });

  it("keys the cache by version and triple", () => {
    const p = nativeBindingPath("9.9.9", "linux-x64-gnu", "/cache");
    assert.equal(p, path.join("/cache", "napi", "9.9.9", "linux-x64-gnu.node"));
  });
});

/** Minimal ustar writer for test fixtures: entries as [name, content, type]. */
function buildTar(entries: Array<{ name: string; content: Buffer; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write(entry.content.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
    header.write(" ".repeat(8), 148, "utf8");
    header.write(entry.type ?? "0", 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    let checksum = 0;
    for (const b of header) checksum += b;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    chunks.push(header);
    chunks.push(entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

describe("mesh native: tarball extraction", () => {
  it("extracts the .node entry from an npm-style tgz", () => {
    const fakeAddon = Buffer.from("FAKE-NATIVE-BINARY");
    const tar = buildTar([
      { name: "package/package.json", content: Buffer.from('{"name":"x"}') },
      { name: "package/rivetkit-napi.linux-x64-gnu.node", content: fakeAddon },
      { name: "package/index.js", content: Buffer.from("module.exports = 1") },
    ]);
    const extracted = extractNodeFromTgz(zlib.gzipSync(tar));
    assert.deepEqual(extracted, fakeAddon);
  });

  it("skips pax headers and rejects tarballs without a .node entry", () => {
    const tar = buildTar([{ name: "package/readme.md", content: Buffer.from("hi") }]);
    assert.throws(() => extractNodeFromTgz(zlib.gzipSync(tar)), /no \.node binary/);
    assert.throws(() => extractNodeFromTgz(Buffer.from("not gzip")), /not valid gzip/);
  });
});

describe("mesh native: download + cache", () => {
  it("downloads, extracts, and caches the addon for the pinned version", async () => {
    const fakeAddon = Buffer.from("FAKE-ADDON-" + RIVETKIT_VERSION);
    const tarball = zlib.gzipSync(buildTar([
      { name: `package/rivetkit-napi-linux-x64-gnu.node`, content: fakeAddon },
    ]));
    const requests: string[] = [];
    const cacheDir = path.join(tmpDir, "cache-download");
    const dest = await downloadNativeBinding({
      triple: "linux-x64-gnu",
      cacheDir,
      fetchImpl: (async (url: any) => {
        requests.push(String(url));
        return { ok: true, status: 200, arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength) } as Response;
      }) as typeof fetch,
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0], new RegExp(`registry\\.npmjs\\.org\\/@rivetkit\\/rivetkit-napi-linux-x64-gnu\\/-\\/rivetkit-napi-linux-x64-gnu-${RIVETKIT_VERSION}\\.tgz`));
    assert.equal(dest, path.join(cacheDir, "napi", RIVETKIT_VERSION, "linux-x64-gnu.node"));
    assert.deepEqual(fs.readFileSync(dest), fakeAddon);
  });

  it("surfaces HTTP failures with the version pin and manual recovery hint", async () => {
    await assert.rejects(
      () =>
        downloadNativeBinding({
          triple: "linux-x64-gnu",
          cacheDir: path.join(tmpDir, "cache-404"),
          fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
        }),
      (err: Error) => {
        assert.match(err.message, /HTTP 404/);
        assert.match(err.message, new RegExp(RIVETKIT_VERSION));
        assert.match(err.message, /npm pack/);
        return true;
      },
    );
  });

  it("surfaces network failures with a manual recovery hint", async () => {
    await assert.rejects(
      () =>
        downloadNativeBinding({
          triple: "linux-x64-gnu",
          cacheDir: path.join(tmpDir, "cache-net"),
          fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
        }),
      /ECONNREFUSED.*npm pack/s,
    );
  });
});

describe("mesh native: bindings path publication", () => {
  it("publishes the cached addon path for the bundle banner loader", () => {
    const fakePath = path.join(tmpDir, "fake.node");
    fs.writeFileSync(fakePath, "not really a binary");
    installNapiRequireShim(fakePath);
    assert.equal((globalThis as Record<string, unknown>).__meshNapiBindingsPath, fakePath);
  });
});
