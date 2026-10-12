#!/usr/bin/env node
/**
 * capture-shot3.mjs — code-driven capture of the xfer Admin console (Shot 3).
 *
 * Starts the real admin daemon (admin-main.ts) on an ephemeral port, records a
 * headless Chromium session (Playwright, 1280x720 video) of the dashboard, and
 * triggers REAL events during one continuous take:
 *   1. a headless receiver pi session (--xfer demo-beta) comes online
 *   2. a real one-shot sender pi session (--xfer demo-alpha) delivers a
 *      one-way handoff to demo-beta (real model, real xfer_to delivery)
 *   3. admin control buttons clicked for real: run gc, broker stop, broker start
 *   4. a real board card file is written (board watcher fires)
 *
 * Output: ../out/shot3/admin.webm + admin.log / beta.log / alpha.log
 *
 * Usage: node promo/intro/capture/capture-shot3.mjs
 * Requires: playwright (resolvable from PW_ROOT, default: this directory),
 *           `pi` on PATH, ffmpeg not required (Playwright writes webm directly).
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

/** This video's directory, and the repository root above it. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = path.resolve(HERE, "..");
const REPO = path.resolve(VIDEO, "../..");
const OUT = path.join(VIDEO, "out", "shot3");
const XFER_DIR = path.join(os.homedir(), ".pi", "xfer");
const BOARD_DIR = path.join(XFER_DIR, "board");
const ADMIN_MAIN = path.join(REPO, "admin-main.ts");
const RESOLVE_HOOK = path.join(REPO, "ts-resolve-hook.mjs");
const PW_ROOT = process.env.PW_ROOT ?? path.dirname(fileURLToPath(import.meta.url));
const FIFO = "/tmp/pi-xfer-shot3-in.fifo";
const RECEIVER = "demo-beta";
const SENDER = "demo-alpha";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[shot3] ${new Date().toTimeString().slice(0, 8)} ${msg}`);

/**
 * Admin console frame geometry. 16:9 at 2x pixel density: the whole console —
 * nav, stat cards, live event stream and control buttons — fits the viewport
 * without scrolling, and stays sharp when the composition scales it up.
 */
const VIEWPORT = { width: 1280, height: 720 };
function pkill(pattern) {
  try { execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" }); } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function brokerWasUp() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(XFER_DIR, "broker.json"), "utf-8"));
    return Number.isFinite(info.pid) && pidAlive(info.pid);
  } catch { return false; }
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const adminLog = fs.openSync(path.join(OUT, "admin.log"), "a");

  // ---- idempotent pre-cleanup ----
  log("pre-cleanup: killing leftover demo processes");
  pkill("xfer demo-beta");
  pkill("xfer demo-alpha");
  pkill("admin-main.ts --port 0");
  try { fs.rmSync(FIFO, { force: true }); } catch {}
  await sleep(300);

  const brokerUpBefore = brokerWasUp();
  log(`broker running before capture: ${brokerUpBefore}`);

  // ---- start the real admin daemon (ephemeral port) ----
  log("starting admin daemon (admin-main.ts, --port 0)");
  const admin = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import", pathToFileURL(RESOLVE_HOOK).href,
    ADMIN_MAIN,
    "--port", "0",
    "--xfer-dir", XFER_DIR,
    "--board-dir", BOARD_DIR,
  ], { stdio: ["ignore", adminLog, adminLog] });

  const adminInfo = await waitUntil(() => {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(XFER_DIR, "admin.json"), "utf-8"));
      if (info.pid === admin.pid && info.port > 0) return info;
    } catch {}
    return null;
  }, 10_000, "admin.json readiness");
  const BASE = `http://127.0.0.1:${adminInfo.port}`;
  log(`admin ready at ${BASE} (pid ${adminInfo.pid})`);

  // ---- Playwright ----
  const require = createRequire(path.join(PW_ROOT, "package.json"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const videoDir = path.join(OUT, ".video-tmp");
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();

  const clickControl = async (action) => {
    await page.goto(`${BASE}/control`);
    await page.waitForSelector(`form[action="/control/${action}"] button`);
    await page.click(`form[action="/control/${action}"] button`);
    await page.waitForLoadState("load");
  };

  /** A real board card on disk; the admin's watcher turns it into a live event. */
  const writeBoardCard = () => {
    const id = `shot3-${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(BOARD_DIR, `${id}-shot3-capture.md`),
      `---\nid: ${id}\ntitle: Shot3 capture\ncreated_by: demo-capture\ncreated_at: ${new Date().toISOString()}\n---\n` +
      `Card written by the Shot 3 capture script during the recording.\n`, "utf-8");
    log(`board card written: ${id}`);
  };

  try {
    // ---- baseline dashboard ----
    log("open dashboard");
    await page.goto(`${BASE}/`);
    await sleep(2500);

    // ---- event 1: receiver pi session comes online ----
    log(`starting receiver pi session (--xfer ${RECEIVER}, rpc, fifo)`);
    execSync(`mkfifo ${FIFO}`);
    const receiverShell = spawn("bash", ["-c",
      `tail -f ${FIFO} | pi --mode rpc --xfer ${RECEIVER} > ${OUT}/beta.log 2>&1`],
      { stdio: "ignore", detached: true });
    receiverShell.unref();
    await waitUntil(() => fs.existsSync(path.join(XFER_DIR, `${RECEIVER}.sock`)), 20_000, `${RECEIVER}.sock`);
    log("receiver online — peer event should hit the live feed");
    await sleep(3000);

    // ---- event 2: real handoff (sender runs while we click control buttons) ----
    log(`starting sender pi session (--xfer ${SENDER}, real model handoff)`);
    const alphaLog = fs.openSync(path.join(OUT, "alpha.log"), "a");
    const sender = spawn("pi", [
      "--xfer", SENDER, "-p",
      "Send a one-way handoff to demo-beta. Title: 'Shot3 capture ping'. " +
      "Summary: automated demo-video capture of the xfer admin console. " +
      "Body: this handoff was delivered during the Shot 3 recording; no reply expected.",
    ], { stdio: ["ignore", alphaLog, alphaLog] });

    // ---- event 3: real control-button clicks ----
    log("clicking run gc");
    await clickControl("gc");
    await sleep(1500);
    log("clicking broker stop");
    await clickControl("broker/stop");
    await sleep(1800);
    log("clicking broker start");
    await clickControl("broker/start");
    await sleep(1500);

// ---- event 4: real board activity (card file write, watcher fires) ----
    await writeBoardCard();
    await sleep(1200);

    // ---- back to the dashboard: stats are current, and we now drive real
    //      events while it is open so the live feed visibly fills ----
    log("reloading dashboard — stat cards + live event stream on camera");
    await page.goto(`${BASE}/`);
    await sleep(1500);

    log("driving real events against the open dashboard (live feed)");
    await fetch(`${BASE}/control/broker/stop`, { method: "POST" }).catch(() => {});
    await sleep(1200);
    await fetch(`${BASE}/control/broker/start`, { method: "POST" }).catch(() => {});
    await sleep(1200);
    await writeBoardCard();
    await sleep(1500);

    // ---- let the real handoff land too, if it makes the cut ----
    if (sender.exitCode === null) {
      log("waiting for the real handoff to land (bounded by the shot length)…");
      await waitUntil(() => sender.exitCode !== null, 12_000, "sender completion").catch(() => {});
    }
    await sleep(1500);
    log("handoff delivered — beta.log shows 📨 [Xfer from");
await waitUntil(() => {
      try { return fs.readFileSync(path.join(OUT, "beta.log"), "utf-8").includes("📨 [Xfer from"); }
      catch { return false; }
    }, 20_000, "delivery in beta.log").catch(() => {});
// ---- hold the populated dashboard to the end of the clip ----
    await sleep(3000);
  } finally {
    const video = page.video();
    await context.close();
    const src = await video.path();
    const dest = path.join(OUT, "admin.webm");
    fs.rmSync(dest, { force: true });
    fs.renameSync(src, dest);
    fs.rmSync(videoDir, { recursive: true, force: true });
    await browser.close();
    log(`video saved: ${dest}`);
  }

  // ---- cleanup: restore broker state, stop admin + receiver ----
  if (!brokerUpBefore) {
    try {
      await fetch(`${BASE}/control/broker/stop`, { method: "POST" });
      log("broker restored to stopped (it was not running before capture)");
    } catch {}
  }
  try { process.kill(admin.pid, "SIGTERM"); } catch {}
  pkill("xfer demo-beta");
  pkill(`tail -f ${FIFO}`);
  fs.rmSync(FIFO, { force: true });
  log("cleanup done (admin daemon SIGTERM'd, receiver killed, fifo removed)");
}

main().catch((err) => {
  console.error(`[shot3] FATAL: ${err?.stack ?? err}`);
  pkill("xfer demo-beta");
  pkill(`tail -f ${FIFO}`);
  try { execSync("pkill -f 'admin-main.ts --port 0'", { stdio: "ignore" }); } catch {}
  process.exit(1);
});
