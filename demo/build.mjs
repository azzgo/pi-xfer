/**
 * build.mjs — one-command demo build: capture everything, render, compress.
 *
 *   node build.mjs            full pipeline (real captures + render)
 *   node build.mjs --compose  reuse existing demo/out captures, render only
 *
 * Output: demo/pi-xfer-demo.mp4 (GitHub-friendly, <10MB target)
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBgm } from "./capture/lib/bgm.mjs";

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(DEMO, "capture");
const OUT = path.join(DEMO, "out");
const COMP = path.join(DEMO, "composition");
const ASSETS = path.join(COMP, "assets");
const FINAL = path.join(DEMO, "pi-xfer-demo.mp4");
/** Composition length; the music bed is rendered to match it. */
const DURATION_SECONDS = 76;

const MOVE_MAP = [
  ["shot1/alpha.mp4", "shot1-alpha.mp4"],
  ["shot1/beta.mp4", "shot1-beta.mp4"],
  ["shot2/page.webm", "shot2-page.mp4"],
  ["shot2/terminal.mp4", "shot2-terminal.mp4"],
  ["shot3/admin.webm", "shot3-admin.mp4"],
];

/* [asset, seconds the composition plays it for]. A capture shorter than its
 * slot freezes on its last frame, which reads as a bug in the cut — fail the
 * build instead of shipping it. */
const SLOT_SECONDS = {
  "shot1-alpha.mp4": 10,
  "shot1-beta.mp4": 10,
  "shot2-page.mp4": 16,
  "shot2-terminal.mp4": 16,
  "shot3-admin.mp4": 22,
};

function assertCoversSlots() {
  const short = [];
  for (const [asset, seconds] of Object.entries(SLOT_SECONDS)) {
    const file = path.join(ASSETS, asset);
    if (!fs.existsSync(file)) continue;
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ], { encoding: "utf8" });
    const have = parseFloat(out.trim());
    if (have + 0.05 < seconds) short.push(`${asset}: ${have.toFixed(2)}s < ${seconds}s slot`);
  }
  if (short.length) {
    console.error("Captures too short for their composition slots:\n  " + short.join("\n  "));
    process.exit(1);
  }
}
function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: COMP, ...opts });
}

function collect() {
  fs.mkdirSync(ASSETS, { recursive: true });
  /* No third-party audio ships in this repo: the bed is synthesized on demand,
   * so a fresh clone can build without any download step. */
  if (ensureBgm(path.join(ASSETS, "bgm.m4a"), DURATION_SECONDS)) {
    console.log("bgm: synthesized demo/capture/lib/bgm.mjs (public domain, this repo)");
  }
  const missing = [];
  for (const [from, to] of MOVE_MAP) {
    const src = path.join(OUT, from);
    if (!fs.existsSync(src)) {
      missing.push(src);
      continue;
    }
    fs.copyFileSync(src, path.join(ASSETS, to));
  }
  if (missing.length) {
    console.error("Missing capture outputs (run their capture scripts first):\n" + missing.join("\n"));
    process.exit(1);
  }
}

function renderComposition() {
  sh("npx", ["--yes", "hyperframes@0.8.149", "render"]);
}

function findRendered() {
  const candidates = ["out/main.mp4", "render/main.mp4", "main.mp4", "out.mp4"];
  for (const c of candidates) {
    const p = path.join(COMP, c);
    if (fs.existsSync(p)) return p;
  }
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "assets") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mp4")) found.push(p);
    }
  })(COMP);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) throw new Error("render produced no mp4");
  return found[0];
}

function compress(src) {
  const tmp = FINAL + ".tmp.mp4";
  sh("ffmpeg", [
    "-y", "-i", src,
    "-vf", "scale=1280:720:flags=lanczos,fps=30",
    "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-ar", "32000",
    "-movflags", "+faststart", tmp,
  ]);
  fs.renameSync(tmp, FINAL);
}

function main() {
  const composeOnly = process.argv.includes("--compose");
  if (!composeOnly) {
    sh("node", [path.join(CAPTURE, "capture-shot1.mjs")], { cwd: CAPTURE });
    // shot2 / shot3 captures are run by their own scripts when present.
    for (const script of ["capture-shot2.mjs", "capture-shot3.mjs"]) {
      const p = path.join(CAPTURE, script);
      if (fs.existsSync(p)) sh("node", [p], { cwd: CAPTURE });
    }
  }
  collect();
  assertCoversSlots();
  renderComposition();
  const rendered = findRendered();
  compress(rendered);
  const audio = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
    "-of", "csv=p=0", FINAL,
  ], { encoding: "utf8" }).trim();
  const mb = fs.statSync(FINAL).size / 1024 / 1024;
  console.log(`done: ${FINAL} (${mb.toFixed(2)} MB, audio: ${audio || "none"})`);
}

main();
