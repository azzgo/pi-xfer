import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { MESH_CACHE_DIR } from "./constants.ts";
/**
 * `require` that works both in the CJS bundle (where esbuild provides
 * __filename) and in the ESM source/tests (import.meta.url).
 */
function nodeRequire(): NodeRequire {
  return createRequire(typeof __filename === "string" ? __filename : import.meta.url);
}

/** RivetKit version the bundle was built against; download pin + cache key. */
export const RIVETKIT_VERSION = "2.3.26";

const NAPI_SCOPE = "@rivetkit";
const NAPI_BASE = "rivetkit-napi";

/**
 * Platform triple for the napi addon package name, mirroring
 * @rivetkit/rivetkit-napi's own loader. Null on unsupported platforms.
 */
export function platformTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === "darwin") return arch === "arm64" || arch === "x64" ? "darwin-universal" : null;
  if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") return null;
    return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
  }
  if (platform === "win32") {
    if (arch !== "x64" && arch !== "arm64") return null;
    return `${arch === "x64" ? "x64" : "arm64"}-msvc`;
  }
  return null;
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return true;
  }
}

/** Cache path for this platform+version's addon: ~/.pi/xfer/cache/napi/<version>/<triple>.node */
export function nativeBindingPath(version: string = RIVETKIT_VERSION, triple = platformTriple(), cacheDir = MESH_CACHE_DIR): string {
  if (!triple) throw new Error(`mesh: no rivetkit native binary exists for ${process.platform}-${process.arch}`);
  return path.join(cacheDir, "napi", version, `${triple}.node`);
}

function napiPackageName(triple: string): string {
  return `${NAPI_SCOPE}/${NAPI_BASE}-${triple}`;
}

/**
 * Download the pinned napi platform package tarball from npm and extract the
 * single `.node` addon into the cache. Returns the cached file path.
 */
export async function downloadNativeBinding(opts: {
  triple: string;
  version?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  registry?: string;
}): Promise<string> {
  const version = opts.version ?? RIVETKIT_VERSION;
  const registry = opts.registry ?? "https://registry.npmjs.org";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pkg = napiPackageName(opts.triple);
  const fileName = `${NAPI_BASE}-${opts.triple}-${version}.tgz`;
  const url = `${registry}/${pkg}/-/${fileName}`;
  const dest = nativeBindingPath(version, opts.triple, opts.cacheDir);

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `mesh: failed to download ${pkg}@${version} (${err instanceof Error ? err.message : String(err)}) — ` +
      `check network, or install manually: \`npm pack ${pkg}@${version}\` and copy ${NAPI_BASE}.${opts.triple}.node to ${dest}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `mesh: download of ${pkg}@${version} failed: HTTP ${response.status} — ` +
      `check the version pin (${version}) or install manually: \`npm pack ${pkg}@${version}\` and copy ${NAPI_BASE}.${opts.triple}.node to ${dest}`,
    );
  }
  const tgz = Buffer.from(await response.arrayBuffer());
  const addon = extractNodeFromTgz(tgz);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, addon, { mode: 0o600 });
  return dest;
}

/** Extract the first `.node` entry from an npm package .tgz buffer. */
export function extractNodeFromTgz(tgz: Buffer): Buffer {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(tgz);
  } catch {
    throw new Error("mesh: downloaded napi tarball is not valid gzip data");
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/[\0 ]*$/g, "").trim(), 8);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    const padded = size + ((512 - (size % 512)) % 512);
    if (offset + size > tar.length) throw new Error("mesh: napi tarball is truncated");
    const body = tar.subarray(offset, offset + size);
    offset += padded;
    if ((type === "0" || type === "\0") && name.endsWith(".node")) return Buffer.from(body);
  }
  throw new Error("mesh: napi tarball contains no .node binary");
}

/** Generalized tarball downloader: fetch a scoped npm package tarball. */
async function downloadTarball(pkg: string, version: string, registry: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const fileName = `${pkg.split("/")[1]}-${version}.tgz`;
  const url = `${registry}/${pkg}/-/${fileName}`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `mesh: failed to download ${pkg}@${version} (${err instanceof Error ? err.message : String(err)}) — ` +
      `check network, or install manually: \`npm pack ${pkg}@${version}\``,
    );
  }
  if (!response.ok) {
    throw new Error(
      `mesh: download of ${pkg}@${version} failed: HTTP ${response.status} — ` +
      `check the version pin (${version}) or install manually: \`npm pack ${pkg}@${version}\``,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Extract every regular file/dir of an npm .tgz into destDir (strips package/). */
export function extractTgzToDir(tgz: Buffer, destDir: string): void {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(tgz);
  } catch {
    throw new Error("mesh: downloaded tarball is not valid gzip data");
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/[\0 ]*$/g, "").trim(), 8);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    const padded = size + ((512 - (size % 512)) % 512);
    if (offset + size > tar.length) throw new Error("mesh: tarball is truncated");
    const body = tar.subarray(offset, offset + size);
    offset += padded;
    const rel = name.replace(/^package\/?/, "");
    if (!rel || rel.startsWith("/") || rel.includes("..")) continue;
    const dest = path.join(destDir, rel);
    const mode = Number.parseInt(header.subarray(100, 108).toString("utf8").replace(/[\0 ]*$/g, "").trim(), 8) & 0o777;
    if (type === "5") {
      fs.mkdirSync(dest, { recursive: true });
    } else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(body), { mode: mode || 0o644 });
    }
  }
}

/**
 * RivetKit's native runtime also resolves an engine binary via the
/**
 * engine-cli ships only musl (static) builds on linux, so glibc systems use the
 * musl package; darwin is per-arch, windows x64/arm64.
 */
export function engineCliTriple(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") return null;
    return `linux-${arch}-musl`;
  }
  if (platform === "darwin") return arch === "arm64" || arch === "x64" ? `darwin-${arch}` : null;
  if (platform === "win32") {
    if (arch !== "x64" && arch !== "arm64") return null;
    return arch === "x64" ? "win32-x64" : "win32-arm64";
  }
  return null;
}

/**
 * RivetKit's native runtime also resolves an engine binary via the
 * @rivetkit/engine-cli wrapper. Download wrapper + platform package into a
 * mini node_modules layout under the cache and return the wrapper's entry file.
 */
export async function ensureEngineCliReady(cacheDir = MESH_CACHE_DIR, fetchImpl?: typeof fetch): Promise<string> {
  const triple = engineCliTriple();
  if (!triple) throw new Error("mesh: no engine-cli package exists for this platform");
  const root = path.join(cacheDir, "napi", RIVETKIT_VERSION, "engine-cli");
  const entry = path.join(root, "node_modules", "@rivetkit", "engine-cli", "index.js");
  if (fs.existsSync(entry)) return entry;
  const registry = "https://registry.npmjs.org";
  const fetchImpl0 = fetchImpl ?? fetch;
  const wrapper = await downloadTarball("@rivetkit/engine-cli", RIVETKIT_VERSION, registry, fetchImpl0);
  extractTgzToDir(wrapper, path.join(root, "node_modules", "@rivetkit", "engine-cli"));
  const platformPkg = `@rivetkit/engine-cli-${triple}`;
  const platform = await downloadTarball(platformPkg, RIVETKIT_VERSION, registry, fetchImpl0);
  extractTgzToDir(platform, path.join(root, "node_modules", "@rivetkit", `engine-cli-${triple}`));
  return entry;
}

/**
/**
 * Publish the cached addon path for the bundle's banner loader, which rivetkit's
 * rewritten `__meshLoadNapiBindings()` call resolves at dynamic-import time.
 */
export function installNapiRequireShim(bindingsPath: string): void {
  (globalThis as Record<string, unknown>).__meshNapiBindingsPath = bindingsPath;
}

/**
 * Idempotently ensure the native runtime pieces (napi addon + engine-cli) are
 * cached and the bundle loaders pointed at them.
 */
export async function ensureNativeRuntimeReady(cacheDir = MESH_CACHE_DIR, fetchImpl?: typeof fetch): Promise<void> {
  const triple = platformTriple();
  if (!triple) {
    throw new Error(
      `mesh: rivetkit has no native runtime for ${process.platform}-${process.arch} — mesh up is unavailable on this machine`,
    );
  }
  const dest = nativeBindingPath(RIVETKIT_VERSION, triple, cacheDir);
  if (!fs.existsSync(dest)) {
    await downloadNativeBinding({ triple, cacheDir, fetchImpl });
  }
  installNapiRequireShim(dest);
  const engineCliEntry = await ensureEngineCliReady(cacheDir, fetchImpl);
  (globalThis as Record<string, unknown>).__meshEngineCliEntry = engineCliEntry;
}
