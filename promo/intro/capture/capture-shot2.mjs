#!/usr/bin/env node
// Capture Shot 2 (web-picker) for the pi-xfer demo video.
//
// Everything shown is REAL:
//   - a real broker daemon (broker-main.ts) on a temp xfer dir + ephemeral port
//   - a real headless receiver pi session (`--xfer pickerdemo`, isolated HOME)
//   - the real built userscript (repo root web-picker.user.js) injected with
//     minimal GM_* shims, driven through its own UI/pick/send code paths
//   - a real annotation.submit → broker → pi handoff delivery (verified via
//     the peer rpc log `📨 [Xfer from`)
//
// The browser recording and the terminal recording share one clock: the capture
// notes when the submit click happened, when the broker acked and when the peer
// logged the arrival, all relative to the first video frame. The terminal tape
// is then built so that nothing it prints can appear before the submit — the
// shot reads left-to-right as cause then effect.
//
// Outputs: ../out/shot2/{page.webm, terminal.mp4, timing.json, logs/}

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildTape, inboundHighlights, runVhs, writeStub } from "./lib/vhs.mjs";

/** This video's directory, and the repository root above it. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = path.resolve(HERE, "..");
const REPO = path.resolve(VIDEO, "../..");
const PAGE_DIR = path.join(VIDEO, "page");
const OUT = path.join(VIDEO, "out", "shot2");
const LOGS = path.join(OUT, "logs");
const USERSCRIPT = fs.readFileSync(path.join(REPO, "web-picker.user.js"), "utf8");
const TARGET_NAME = "pickerdemo";

/* Short paths keep the real log lines on one or two terminal rows. */
if (fs.existsSync("/tmp")) process.env.TMPDIR = "/tmp";

/** Browser frame geometry; the composition frames this 1:1. */
const PAGE_VIEW = { width: 1280, height: 720 };
/** Terminal geometry; the composition frames this 1:1. */
const TERM = { width: 800, height: 840, fontSize: 26 };
const TOTAL_MS = 16_400;
const TYPE_MS_PER_CHAR = 6;

/** Pacing marks, in ms from the first recorded browser frame. */
const MARK = { pickMode: 3000, picks: [3600, 5700, 7800], panel: 9900, send: 11_700 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}
function probeDurationMs(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ], { encoding: "utf8" });
  return Math.round(parseFloat(out.trim()) * 1000);
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const file = path.join(PAGE_DIR, req.url === "/" ? "index.html" : req.url);
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("nope"); return; }
        res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const GM_SHIM = `
(() => {
  const KEY = '__pi_wp_gm_store__';
  const store = JSON.parse(localStorage.getItem(KEY) || '{}');
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; localStorage.setItem(KEY, JSON.stringify(store)); };
  window.GM_registerMenuCommand = () => {};
  window.GM_setClipboard = () => {};
  window.unsafeWindow = window;
  localStorage.setItem('__pi_wp_gm_store__', JSON.stringify(Object.assign(store, {
    'wp.brokerUrl': '__BROKER_URL__',
    'wp.lastTarget': '${TARGET_NAME}',
  })));
})();
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const tmp = fs.mkdtempSync("/tmp/xfer2-");
  const homeDir = path.join(tmp, "home");
  fs.mkdirSync(homeDir, { recursive: true });
let t0 = 0;
  const cleanups = [];
  const cleanup = () => { for (const fn of cleanups.reverse()) { try { fn(); } catch {} } };
  /** Sleep until `ms` after the first recorded browser frame. */
  const at = async (ms) => {
    const delta = t0 + ms - Date.now();
    if (delta > 0) await sleep(delta);
  };
  const since = () => Date.now() - t0;

  try {
    // 1. Real broker daemon (temp xfer dir so we never touch ~/.pi/xfer).
    const brokerLogPath = path.join(tmp, "broker.log");
    const brokerLog = fs.openSync(brokerLogPath, "a");
    const broker = spawn(process.execPath, [
      path.join(REPO, "broker-main.ts"), "--port", "0", "--xfer-dir", path.join(homeDir, ".pi", "xfer"),
    ], { stdio: ["ignore", brokerLog, brokerLog] });
    cleanups.push(() => { broker.kill("SIGTERM"); fs.closeSync(brokerLog); });
    const brokerInfo = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "xfer", "broker.json"), "utf8")); } catch { return null; }
    }, "broker.json");
    const brokerUrl = `ws://127.0.0.1:${brokerInfo.port}`;
    console.log(`[shot2] broker up: ${brokerUrl} (pid ${brokerInfo.pid})`);

    // 2. Real headless receiver pi session with an isolated HOME.
    const peerLog = fs.openSync(path.join(LOGS, "peer-rpc.log"), "a");
    const pi = spawn("pi", [
      "--mode", "rpc", "--no-extensions", "-e", path.join(REPO, "index.ts"),
      "--xfer", TARGET_NAME, "--no-session",
    ], { env: { ...process.env, HOME: homeDir }, stdio: ["pipe", peerLog, peerLog], cwd: tmp });
    cleanups.push(() => { try { pi.stdin.end('{"type":"prompt","message":"exit"}\n'); } catch {} pi.kill("SIGTERM"); fs.closeSync(peerLog); });
    await waitFor(() => fs.existsSync(path.join(homeDir, ".pi", "xfer", `${TARGET_NAME}.sock`)), `${TARGET_NAME}.sock`);
    console.log(`[shot2] receiver pi session "${TARGET_NAME}" registered`);

    // 3. Static server for the demo page.
    const server = await startStaticServer();
    const pageUrl = `http://127.0.0.1:${server.address().port}/`;
    cleanups.push(() => server.close());
    console.log(`[shot2] demo page at ${pageUrl}`);

    // 4. Playwright chromium + video, GM shims, then the real userscript.
    //    The clock origin is stamped here: Playwright has just started recording, so
//    pacing marks below map onto frames of page.webm and onto the terminal tape.
    const browser = await chromium.launch({ headless: true });
    cleanups.push(() => browser.close());
    const context = await browser.newContext({
      viewport: PAGE_VIEW,
      recordVideo: { dir: OUT, size: PAGE_VIEW },
    });
    cleanups.push(() => context.close());
    const page = await context.newPage();
    t0 = Date.now();
    await page.addInitScript(GM_SHIM.replace("__BROKER_URL__", brokerUrl));
    await page.addInitScript(USERSCRIPT);
    await page.goto(pageUrl, { waitUntil: "networkidle" });
    const api = () => page.evaluate(() => !!window.__PI_WP_API__);
    await waitFor(api, "__PI_WP_API__");

    // Connect through the userscript's real code path.
    await page.evaluate(() => window.__PI_WP_API__.connect());
    await waitFor(() => page.evaluate(
      () => document.querySelector("[data-pi-wp-host]")?.shadowRoot?.querySelector("#dot")?.className === "on"
    ), "broker connected (green dot)", 15000);
    console.log(`[shot2] broker connected at +${since()}ms`);

    // Pick mode via the userscript's own entry, then real mouse picks.
    await at(MARK.pickMode);
    await page.evaluate(() => window.__PI_WP_API__.start());
    await sleep(400);

    async function pick(selector, note) {
      const el = page.locator(selector);
      await el.scrollIntoViewIfNeeded();
      const box = await el.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(400); // note card opens, textarea focused
      await page.keyboard.type(note, { delay: 12 });
      await sleep(200);
      await page.locator("[data-pi-wp-host] >> #ok").click();
      await sleep(300);
    }

    const notes = [
      ["#plan-pro .price", "Pro shows $12/user/month — check this matches the billing page"],
      ["#cta-pro", "Primary trial CTA — is the free-trial duration stated anywhere?"],
      ["#nav-signin", "Sign-in entry point: does it preserve the current page for redirect?"],
    ];
    for (let i = 0; i < notes.length; i++) {
      await at(MARK.picks[i]);
      await pick(...notes[i]);
    }
    console.log(`[shot2] 3 picks with notes submitted via the userscript UI at +${since()}ms`);

    // Open the note panel, write the prompt, send through the real send flow.
    await at(MARK.panel);
    await page.evaluate(() => window.__PI_WP_API__.panel());
    await sleep(800);
    await page.locator("[data-pi-wp-host] >> #prompt").fill(
      "Review this pricing page. I marked the Pro plan price, the trial CTA and the sign-in link — please check each against my notes and confirm what the page actually renders."
    );
    await at(MARK.send);
    await page.locator("[data-pi-wp-host] >> #sendbtn").click();
    const tSubmit = since();
    console.log(`[shot2] annotation.submit sent at +${tSubmit}ms`);

await waitFor(() => fs.readFileSync(brokerLogPath, "utf8").includes("[xfer] delivered to pickerdemo"), "broker delivery ack", 20000);
    const tBroker = since();
    const peerLogPath = path.join(LOGS, "peer-rpc.log");
    await waitFor(() => fs.readFileSync(peerLogPath, "utf8").includes("📨 [Xfer from"), "peer 📨 line", 20000);
    const tPeer = since();
    console.log(`[shot2] handoff CONFIRMED — broker ack +${tBroker}ms, peer receipt +${tPeer}ms`);

// Hold the toast on camera until the clip reaches its target length.
    await at(TOTAL_MS);
    const closeAt = since();
    await context.close(); // flush video
    const videos = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
    if (!videos.length) throw new Error("no video recorded");
    const pageVideo = path.join(OUT, "page.webm");
    fs.renameSync(path.join(OUT, videos[0]), pageVideo);
    await browser.close();
    cleanup(); cleanups.length = 0;

    /* The browser video has its own clock: it starts when Playwright starts
     * recording, not at t0. Re-derive its origin from the file we just wrote so
     * the terminal tape can be cut against the submit event as it appears on
     * screen, rather than against wall-clock guesswork. */
    const videoMs = probeDurationMs(pageVideo);
    const origin = closeAt - videoMs;
    const timing = {
      tSubmit: Math.round(tSubmit - origin),
      tBroker: Math.round(tBroker - origin),
      tPeer: Math.round(tPeer - origin),
      videoMs,
      brokerLogPath,
      peerLogPath,
    };
    fs.copyFileSync(brokerLogPath, path.join(LOGS, "broker.log"));
    fs.writeFileSync(path.join(OUT, "timing.json"), JSON.stringify(timing, null, 2));
    console.log(
      `[shot2] page.webm ${videoMs}ms — submit at +${timing.tSubmit}ms, ` +
      `peer receipt at +${timing.tPeer}ms (video clock)`
    );

    // 5. Terminal visual: replay the REAL broker + peer log lines via VHS,
    //    on a clock aligned to the browser video's submit event.
    await renderTerminalTape(timing);
    console.log(`[shot2] done in ${since() / 1000}s → out/shot2/`);
  } catch (err) {
    console.error("[shot2] FAILED:", err);
    cleanup();
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** The broker log for this run only, minus the repeat-noise. */
function brokerLines(logPath) {
  const all = fs.readFileSync(logPath, "utf8")
    .split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const starts = all.map((l, i) => (l.startsWith("[broker] listening") ? i : -1)).filter((i) => i >= 0);
  return all.slice(starts.at(-1)).filter((l, i, arr) => l !== arr[i - 1]);
}

/** The real inbound markdown the receiver session logged, not raw JSON. */
function inboundDoc(logPath) {
  for (const raw of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (!raw.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg.type === "message_start" && msg.message?.customType === "xfer-inbound") {
      return String(msg.message.content);
    }
  }
  throw new Error("no xfer-inbound message in peer rpc log");
}

async function renderTerminalTape({ tSubmit, tPeer, videoMs, brokerLogPath, peerLogPath }) {
  const log = brokerLines(brokerLogPath);
  const docIdx = log.findIndex((l) => l.startsWith("[doc] "));
  if (docIdx < 0) throw new Error("no [doc] line in broker log");
  const steady = log.slice(0, docIdx);
  const delivered = log.slice(docIdx);

  const peer = inboundHighlights(inboundDoc(peerLogPath));

const command = `tail -f ${brokerLogPath}`;
  const commandAtMs = 700;
  const enterMs = commandAtMs + command.length * TYPE_MS_PER_CHAR + 120;
  const steadyAtMs = enterMs + 400;

  const chunks = [{ afterMs: 400, text: steady.join("\n") }];

  // Causality: the delivery lines may not appear before the left pane submitted.
  const deliveredAtMs = Math.max(steadyAtMs + 700, tSubmit + 500);
  chunks.push({ afterMs: deliveredAtMs - steadyAtMs, text: delivered.join("\n") });

  const peerAtMs = Math.max(deliveredAtMs + 900, tPeer + 200);
  chunks.push({ afterMs: peerAtMs - deliveredAtMs, text: `pi --mode rpc --xfer ${TARGET_NAME}\n${peer}` });

  const binDir = path.join(OUT, "stub-bin");
  writeStub(binDir, "tail", chunks);

  const tape = buildTape({
    output: path.join(OUT, "terminal.mp4"),
    width: TERM.width,
    height: TERM.height,
    fontSize: TERM.fontSize,
    binDir,
    command,
    commandAtMs,
    totalMs: Math.max(videoMs + 1500, peerAtMs + 1400),
  });
  const tapePath = path.join(OUT, "terminal.tape");
  fs.writeFileSync(tapePath, tape);
  await runVhs(tapePath, OUT);
}

main();