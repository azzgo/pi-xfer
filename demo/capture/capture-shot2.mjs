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
// Outputs: demo/out/shot2/{page.webm, terminal.mp4, logs/}

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = path.join(REPO, "demo/capture");
const PAGE_DIR = path.join(REPO, "demo/page");
const OUT = path.join(REPO, "demo/out/shot2");
const LOGS = path.join(OUT, "logs");
const USERSCRIPT = fs.readFileSync(path.join(REPO, "web-picker.user.js"), "utf8");
const TARGET_NAME = "pickerdemo";

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
  localStorage.setItem('${'__pi_wp_gm_store__'}', JSON.stringify(Object.assign(store, {
    'wp.brokerUrl': '__BROKER_URL__',
    'wp.lastTarget': '${TARGET_NAME}',
  })));
})();
`;

async function main() {
  fs.mkdirSync(LOGS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shot2-"));
  const xferDir = path.join(tmp, "xfer");
  const homeDir = path.join(tmp, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(xferDir);
  const t0 = Date.now();
  const cleanups = [];
  const cleanup = () => { for (const fn of cleanups.reverse()) { try { fn(); } catch {} } };

  try {
    // 1. Real broker daemon (temp xfer dir so we never touch ~/.pi/xfer).
    const brokerLog = fs.openSync(path.join(LOGS, "broker.log"), "a");
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
    await waitFor(() => fs.existsSync(path.join(homeDir, ".pi/xfer", `${TARGET_NAME}.sock`)), `${TARGET_NAME}.sock`);
    console.log(`[shot2] receiver pi session "${TARGET_NAME}" registered`);

    // 3. Static server for the demo page.
    const server = await startStaticServer();
    const pageUrl = `http://127.0.0.1:${server.address().port}/`;
    cleanups.push(() => server.close());
    console.log(`[shot2] demo page at ${pageUrl}`);

    // 4. Playwright chromium + video, GM shims, then the real userscript.
    const browser = await chromium.launch({ headless: true });
    cleanups.push(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
    });
    cleanups.push(() => context.close());
    const page = await context.newPage();

    await page.addInitScript(GM_SHIM.replace("__BROKER_URL__", brokerUrl));
    await page.addInitScript(USERSCRIPT);
    await page.goto(pageUrl, { waitUntil: "networkidle" });
    const api = () => page.evaluate(() => !!window.__PI_WP_API__);
    await waitFor(api, "__PI_WP_API__");
    await sleep(1000);

    // Connect through the userscript's real code path.
    await page.evaluate(() => window.__PI_WP_API__.connect());
    await waitFor(() => page.evaluate(
      () => document.querySelector("[data-pi-wp-host]")?.shadowRoot?.querySelector("#dot")?.className === "on"
    ), "broker connected (green dot)", 15000);
    await sleep(1500);

    // Pick mode via the userscript's own entry, then real mouse picks.
    await page.evaluate(() => window.__PI_WP_API__.start());
    await sleep(600);

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
      await sleep(400);
    }
    await pick("#plan-pro .price", "Pro shows $12/user/month — check this matches the billing page");
    await pick("#cta-pro", "Primary trial CTA — is the free-trial duration stated anywhere?");
    await pick("#nav-signin", "Sign-in entry point: does it preserve the current page for redirect?");
    console.log("[shot2] 3 picks with notes submitted via the userscript UI");

    // Open the note panel, write the prompt, send through the real send flow.
    await page.evaluate(() => window.__PI_WP_API__.panel());
    await sleep(800);
    await page.locator("[data-pi-wp-host] >> #prompt").fill(
      "Review this pricing page. I marked the Pro plan price, the trial CTA and the sign-in link — please check each against my notes and confirm what the page actually renders."
    );
    await sleep(400);
    await page.locator("[data-pi-wp-host] >> #sendbtn").click();
    console.log("[shot2] annotation.submit sent — waiting for broker delivery + peer receipt…");

    const brokerLogPath = path.join(LOGS, "broker.log");
    await waitFor(() => fs.readFileSync(brokerLogPath, "utf8").includes("[xfer] delivered to pickerdemo"), "broker delivery ack", 20000);
    const peerLogPath = path.join(LOGS, "peer-rpc.log");
    await waitFor(() => fs.readFileSync(peerLogPath, "utf8").includes("📨 [Xfer from"), "peer 📨 line", 20000);
    console.log("[shot2] handoff CONFIRMED delivered to the receiver pi session");
    await sleep(4000); // let the toast + panel linger on video

    await context.close(); // flush video
    const videos = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
    if (!videos.length) throw new Error("no video recorded");
    fs.renameSync(path.join(OUT, videos[0]), path.join(OUT, "page.webm"));
    console.log(`[shot2] browser video: demo/out/shot2/page.webm`);

    await browser.close();
    cleanup(); cleanups.length = 0;

    // 5. Terminal visual: replay the REAL broker + peer log lines via VHS.
    await renderTerminalTape();
    console.log(`[shot2] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → demo/out/shot2/`);
  } catch (err) {
    console.error("[shot2] FAILED:", err);
    cleanup();
    process.exitCode = 1;
  } finally {
    // belt-and-braces: nothing from this run may outlive the script
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function renderTerminalTape() {
  const brokerAll = fs.readFileSync(path.join(LOGS, "broker.log"), "utf8")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const listenIdx = brokerAll.map((l, i) => (l.startsWith("[broker] listening") ? i : -1));
  const start = Math.max(...listenIdx);
  const broker = brokerAll.slice(start).filter((l) => !l.startsWith("[targets]"));
  const peer = fs.readFileSync(path.join(LOGS, "peer-rpc.log"), "utf8").split("\n")
    .filter((l) => l.includes("📨") || l.includes("**Request**")).slice(0, 4);
  const clean = (s) => s.replace(/['"\\]/g, "").trimEnd();
  const body = [
    "# real broker daemon (broker-main.ts)",
    ...broker.map(clean),
    "",
    "# receiver pi session — the handoff lands:",
    ...peer.map(clean),
  ];
  const replay = body.map((l) => `Type@1ms ${JSON.stringify(l)}\nEnter`).join("\n");
  const tape = `Output ${JSON.stringify(path.join(OUT, "terminal.mp4"))}
Set FontFamily Menlo
Set FontSize 20
Set Theme { "background": "#101014", "foreground": "#e6e6eb", "accent": "#7c6cf0", "green": "#7ee787", "purple": "#c297ff" }
Set Width 1280
Set Height 720
Set Margin 0
Type "pi-xfer · broker + peer"
Enter
Sleep 1200ms
Hide
Type "cat <<'XFER_EOF'"
Enter
Show
${replay}
Hide
Type "XFER_EOF"
Enter
Show
Sleep 3000ms
`;
  const tapePath = path.join(HERE, "tape-shot2.tape");
  fs.writeFileSync(tapePath, tape);
  await new Promise((resolve, reject) => {
    const vhs = spawn("vhs", [tapePath], { stdio: "inherit", cwd: OUT });
    vhs.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`vhs exited ${c}`))));
  });
}

main();
