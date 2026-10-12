/**
 * capture-shot1.mjs — Shot 1 (hook): a REAL handoff between two REAL interactive
 * pi sessions, recorded through VHS.
 *
 * Nothing is replayed in this shot. Both sides run pi's real TUI — input box,
 * streaming output, spinner, syntax colours — and the handoff really happens:
 *
 *   beta   sits in an interactive `pi --xfer beta` session
 *   alpha  runs `pi --xfer alpha` and types `/xfer beta <request>`, which makes a
 *          real model call and delivers a real handoff over beta's socket
 *
 * Because the model call takes as long as it takes, the recordings are cut after
 * the fact against measured wall-clock events (see lib/retime.mjs): the send is
 * anchored to beta's arrival, and the wait between them is compressed into a
 * quick spin rather than cut away.
 *
 * Usage: node capture-shot1.mjs   (from demo/capture; writes demo/out/shot1)
 * Env:   SHOT1_HOLD_MS   how long each tape stays open (default 210s)
 *        SHOT1_RECUT     re-cut from the saved raw takes, no model calls
 *
 * The raw takes stay in demo/out/shot1 so the cut can be re-tuned in seconds
 * instead of paying for another pair of live model calls.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTuiTape } from "./lib/vhs.mjs";
import { firstInkFrameMs, retime } from "./lib/retime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../out/shot1");
/** The extension under demonstration, loaded by path so the shot runs this repo. */
const EXTENSION = path.resolve(HERE, "..", "..", "index.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Short paths keep real log lines inside one terminal row. */
if (fs.existsSync("/tmp")) process.env.TMPDIR = "/tmp";

/** Terminal geometry; the composition frames this 1:1. */
const TUI = { width: 1100, height: 780, fontSize: 22 };
/** How long the finished clips run, matching the composition's shot-1 slot. */
const SLOT_MS = 10_000;
/** Where the delivery lands inside the finished clips — both sides share it. */
const ANCHOR_MS = 6200;
/**
 * Shot budget on alpha, in order: a beat of the idle TUI, the command being
 * typed and submitted, the compressed model wait, then the delivery landing.
 * ALPHA_PRE + ALPHA_SUBMIT_TAIL + ALPHA_SPIN is the first third of the clip;
 * whatever is left carries the delivery.
 */
const ALPHA_PRE_MS = 1000;
const ALPHA_SUBMIT_TAIL_MS = 450;
const ALPHA_THINK_MS = 2800;
const ALPHA_THINK_WINDOW_MS = 4000;
const ALPHA_AFTER_CALL_MS = 1350;
const ALPHA_PREROLL_MS = 600;
const ALPHA_DELIVERY_MS =
  SLOT_MS - ALPHA_PRE_MS - ALPHA_SUBMIT_TAIL_MS - ALPHA_THINK_MS - ALPHA_AFTER_CALL_MS;
const LAUNCH_AT_MS = 900;
const SUBMIT_AT_MS = 9000;
const HOLD_MS = Number(process.env.SHOT1_HOLD_MS ?? 210_000);

/* Alpha's own task is self-contained on purpose: ask it to look for a file it
 * cannot see and it goes hunting, and the failed search lands in the shot.
 * "In this session only" likewise keeps the receiver from handing the reply
 * back over xfer, which would turn a one-way shot into a two-way exchange. */
const REQUEST =
  "The demo cut is final. In this session only, list three things a reviewer " +
  "should check on a 76-second product demo. Keep it short.";

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

/** Session logs written by pi sessions started in `cwd`. */
function sessionsFor(cwd, sessionsRoot) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(sessionsRoot);
  return found.filter((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]).cwd === cwd;
    } catch {
      return false;
    }
  });
}

function readEvents(file) {
  const events = { startedAt: null, sentAt: null, confirmedAt: null, arrivedAt: null, doc: null };
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return events;
  }
  for (const raw of lines) {
    if (!raw.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!events.startedAt && o.type === "session") events.startedAt = Date.parse(o.timestamp);
    if (o.type === "custom_message" && o.customType === "xfer-inbound" && !events.arrivedAt) {
      events.arrivedAt = Date.parse(o.timestamp);
      events.doc = String(o.content);
    }
    if (o.type === "message" && o.message?.role === "toolResult" && !events.sentAt) {
      const text = JSON.stringify(o.message.content ?? "");
      // The `/xfer` tool result carries the handoff id: that is the moment the
      // handoff actually went out. Matching the model's prose instead would
      // break the moment it answers in another language.
      if (text.includes("handoff_id")) events.sentAt = Date.parse(o.timestamp);
    }
    /* Alpha confirms out loud some seconds after the call returns, and that
     * line is what the viewer sees land on beta. Take the first text it writes
     * afterwards, whatever language it uses. */
    if (events.sentAt && !events.confirmedAt && o.type === "message" && o.message?.role === "assistant") {
      const blocks = o.message.content;
      const hasText = Array.isArray(blocks)
        ? blocks.some((b) => b?.type === "text" && String(b.text).trim())
        : typeof blocks === "string" && blocks.trim().length > 0;
      if (hasText) events.confirmedAt = Date.parse(o.timestamp);
    }
  }
  return events;
}

function runVhs(tapePath, cwd) {
  const child = spawn("vhs", [path.basename(tapePath)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve(log) : reject(new Error(`vhs ${code}\n${log}`))));
  });
}

/**
 * A private HOME holding only what pi needs to run: credentials, models and the
 * user's own settings minus extension discovery. Two things fall out of this —
 * the startup package-update notice has nothing to report, and both sessions
 * get their own ~/.pi/xfer instead of registering peers on the real machine.
 */
function isolatedHome(root) {
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  fs.mkdirSync(agent, { recursive: true });
  const src = path.join(os.homedir(), ".pi", "agent");
  for (const file of ["auth.json", "models.json", "models-store.json", "keybindings.json", "settings.json"]) {
    const from = path.join(src, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(agent, file));
  }
  const settingsPath = path.join(agent, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  for (const key of ["extensions", "packages", "skills", "prompts"]) delete settings[key];
  /* pi's own setting for exactly this: "header" keeps the logo/version splash
   * an everyday session starts with, and drops the model-scope list below it. */
  settings.quietStartup = "header";
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return home;
}

async function main() {
  const recut = process.argv.includes("--recut");
  if (!recut) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const scratch = fs.realpathSync(fs.mkdtempSync("/tmp/x1-"));
  const home = isolatedHome(scratch);
  const sessionsHere = (cwd) => sessionsFor(cwd, path.join(home, ".pi", "agent", "sessions"));
  const sessionsBefore = new Set(sessionsHere(scratch));
  console.log(`[shot1] scratch ${scratch}`);

  const alphaTape = buildTuiTape({
    output: path.join(OUT, "alpha-raw.mp4"),
    ...TUI,
    cwd: scratch,
    marker: path.join(scratch, "alpha.marker"),
    alias: `HOME=${home} pi --no-extensions -e ${EXTENSION}`,
    launch: "pi --xfer alpha",
    launchAtMs: LAUNCH_AT_MS,
    submit: `/xfer beta ${REQUEST}`,
    submitAtMs: SUBMIT_AT_MS,
    holdMs: HOLD_MS,
  });
  const betaTape = buildTuiTape({
    output: path.join(OUT, "beta-raw.mp4"),
    ...TUI,
    cwd: scratch,
    marker: path.join(scratch, "beta.marker"),
    alias: `HOME=${home} pi --no-extensions -e ${EXTENSION}`,
    launch: "pi --xfer beta",
    launchAtMs: LAUNCH_AT_MS,
    holdMs: HOLD_MS,
  });
  fs.writeFileSync(path.join(OUT, "alpha.tape"), alphaTape.tape);
  fs.writeFileSync(path.join(OUT, "beta.tape"), betaTape.tape);

  if (recut) {
    const meta = JSON.parse(fs.readFileSync(path.join(OUT, "recut.json"), "utf8"));
    console.log("[shot1] re-cutting from the saved raw takes");
    await cut(alphaTape, betaTape, meta);
    fs.rmSync(scratch, { recursive: true, force: true });
    return;
  }

  const alpha = runVhs(path.join(OUT, "alpha.tape"), OUT);
  const beta = runVhs(path.join(OUT, "beta.tape"), OUT);
  const recordings = Promise.all([alpha, beta]).catch((e) => {
    console.error("[shot1] recording failed:", e.message);
  });

  /* If a peer never registers, say so now rather than after the full hold. */
  const xferDir = path.join(home, ".pi", "xfer");
  await waitFor(
    () => fs.existsSync(path.join(xferDir, "alpha.sock")) && fs.existsSync(path.join(xferDir, "beta.sock")),
    40_000,
    "both peers to register their sockets"
  ).catch(async (e) => {
    await recordings;
    throw e;
  });
  console.log(`[shot1] both peers online — recording (up to ${(HOLD_MS / 1000).toFixed(0)}s)…`);

  /* Both events come from the sessions' own logs, so nothing here has to guess
   * when the model finished or when the handoff landed. */
  const events = await waitFor(() => {
    const files = sessionsHere(scratch).filter((f) => !sessionsBefore.has(f));
    /* Pick the roles apart by which session received the handoff, so a reply
     * sent back can never be mistaken for the original send. */
    const parsed = files.map((file) => readEvents(file));
    const receiver = parsed.find((e) => e.arrivedAt);
    const sender = parsed.find((e) => e !== receiver && e.sentAt);
    return sender?.sentAt && sender.confirmedAt && receiver
      ? {
          sentAt: sender.sentAt,
          confirmedAt: sender.confirmedAt,
          arrivedAt: receiver.arrivedAt,
          doc: receiver.doc,
        }
      : null;
  }, HOLD_MS - 25_000, "handoff send + arrival").catch(async (e) => {
    /* Never leave the recordings unwritten: VHS only flushes on a clean exit. */
    await recordings;
    throw e;
  });
  console.log(
    `[shot1] real handoff: sent ${new Date(events.sentAt).toISOString().slice(14, 22)}, ` +
    `confirmed ${new Date(events.confirmedAt).toISOString().slice(14, 22)}, ` +
    `arrived at beta ${new Date(events.arrivedAt).toISOString().slice(14, 22)}`
  );
  if (!events.doc.startsWith("📨 [Xfer from **alpha**]")) {
    throw new Error(`beta did not receive an alpha handoff: ${events.doc.split("\n")[0]}`);
  }

  await recordings;
  fs.writeFileSync(path.join(OUT, "recut.json"), JSON.stringify({
    sentAt: events.sentAt,
    confirmedAt: events.confirmedAt,
    arrivedAt: events.arrivedAt,
    doc: events.doc,
    markers: {
      alpha: Math.round(fs.statSync(path.join(scratch, "alpha.marker")).mtimeMs),
      beta: Math.round(fs.statSync(path.join(scratch, "beta.marker")).mtimeMs),
    },
  }));
  await cut(alphaTape, betaTape, {
    sentAt: events.sentAt,
    confirmedAt: events.confirmedAt,
    arrivedAt: events.arrivedAt,
    doc: events.doc,
    markers: {
      alpha: Math.round(fs.statSync(path.join(scratch, "alpha.marker")).mtimeMs),
      beta: Math.round(fs.statSync(path.join(scratch, "beta.marker")).mtimeMs),
    },
  });
  for (const file of sessionsHere(scratch)) fs.rmSync(file, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
}

/**
 * Turn the two raw takes into the two finished clips.
 *
 * Wall-clock events are placed on each recording's own timeline: a hidden
 * `touch` marker inside the tape gives a wall-clock reading, and the first frame
 * of ink on screen gives the tape-schedule position it landed on, which between
 * them pin the recording to the events the sessions logged.
 */
async function cut(alphaTape, betaTape, meta) {
  const timeline = (tape, name, raw, markerAt) => {
    const inkVideoMs = firstInkFrameMs(raw);
    const bootMs = inkVideoMs - tape.inkAtMs;
    return {
      bootMs,
      at: (wallMs) => wallMs - markerAt + tape.markerTapeMs + bootMs,
      tapeAt: (tapeMs) => inkVideoMs + (tapeMs - tape.inkAtMs),
    };
  };
  const a = timeline(alphaTape, "alpha", path.join(OUT, "alpha-raw.mp4"), meta.markers.alpha);
  const b = timeline(betaTape, "beta", path.join(OUT, "beta-raw.mp4"), meta.markers.beta);

  const tType = a.tapeAt(alphaTape.typeAtMs);
  const tCall = a.at(meta.sentAt);
  const tConfirm = a.at(meta.confirmedAt);
  const tArrive = b.at(meta.arrivedAt);

  /* Alpha waits twice: once for the model to compose the doc, then again while
   * it writes its confirmation. Both are squeezed so the agent reads as brisk,
   * and it is the confirmation that gets lined up with beta's arrival. */
  const beat = (fromMs, toMs, leadMs, outMs, availableMs) => {
    const srcMs = Math.max(200, Math.min(toMs - leadMs - fromMs, availableMs ?? Infinity));
    return {
      startSec: Math.max(0, fromMs) / 1000,
      srcDurSec: srcMs / 1000,
      outDurSec: outMs / 1000,
      speed: outMs / srcMs,
    };
  };
  /* Keep only the tail of the thinking window: the opening of a long model turn
   * is where exploratory tool calls (and their failures) live, and none of it
   * survives the squeeze anyway. */
  const thinkWindowMs = tCall - ALPHA_PREROLL_MS - (tType + ALPHA_SUBMIT_TAIL_MS);
  const thinkSrcMs = Math.min(thinkWindowMs, ALPHA_THINK_WINDOW_MS);
  const afterCallSrcMs = Math.max(200, tConfirm - tCall);
  const openSrcSec = (ALPHA_PRE_MS + ALPHA_SUBMIT_TAIL_MS) / 1000;
  const alphaSegs = [
    { startSec: Math.max(0, tType - ALPHA_PRE_MS) / 1000, srcDurSec: openSrcSec, outDurSec: openSrcSec, speed: 1 },
    beat(tCall - ALPHA_THINK_WINDOW_MS, tCall, ALPHA_PREROLL_MS, ALPHA_THINK_MS, thinkWindowMs),
    beat(tCall, tConfirm, 0, ALPHA_AFTER_CALL_MS),
    {
      startSec: Math.max(0, tConfirm - ALPHA_PREROLL_MS) / 1000,
      srcDurSec: ALPHA_DELIVERY_MS / 1000,
      outDurSec: ALPHA_DELIVERY_MS / 1000,
      speed: 1,
    },
  ];

  /* Beta needs no retiming: it idles until the handoff lands, so a straight
   * window ending the same distance after the arrival lines the two sides up. */
  const betaSegs = [{
    startSec: Math.max(0, (tArrive - ANCHOR_MS) / 1000),
    srcDurSec: SLOT_MS / 1000,
    outDurSec: SLOT_MS / 1000,
  }];

  const cuts = path.join(OUT, ".cuts");
  fs.rmSync(cuts, { recursive: true, force: true });
  fs.mkdirSync(cuts, { recursive: true });
  retime(path.join(OUT, "alpha-raw.mp4"), alphaSegs, path.join(OUT, "alpha.mp4"), SLOT_MS / 1000, cuts);
  retime(path.join(OUT, "beta-raw.mp4"), betaSegs, path.join(OUT, "beta.mp4"), SLOT_MS / 1000, cuts);

  const alphaAnchorMs =
    ALPHA_PRE_MS + ALPHA_SUBMIT_TAIL_MS + ALPHA_THINK_MS + ALPHA_AFTER_CALL_MS + ALPHA_PREROLL_MS;
  if (Math.abs(alphaAnchorMs - ANCHOR_MS) > 1) {
    throw new Error(`alpha anchor ${alphaAnchorMs}ms does not match beta anchor ${ANCHOR_MS}ms`);
  }

  fs.writeFileSync(path.join(OUT, "shot1.json"), JSON.stringify({
    sendAt: new Date(meta.sentAt).toISOString(),
    confirmAt: new Date(meta.confirmedAt).toISOString(),
    arriveAt: new Date(meta.arrivedAt).toISOString(),
    modelWaitMs: Math.round(thinkWindowMs),
    confirmWaitMs: Math.round(afterCallSrcMs),
    spedUp: {
      think: `last ${(thinkSrcMs / 1000).toFixed(1)}s of ${(thinkWindowMs / 1000).toFixed(1)}s \u2192 ${(ALPHA_THINK_MS / 1000).toFixed(2)}s`,
      confirm: `${(afterCallSrcMs / 1000).toFixed(1)}s \u2192 ${(ALPHA_AFTER_CALL_MS / 1000).toFixed(2)}s`,
    },
    vhsBootMs: { alpha: a.bootMs, beta: b.bootMs },
    alphaAnchorMs,
    betaAnchorMs: ANCHOR_MS,
    doc: meta.doc.split("\n").slice(0, 3),
  }, null, 2));

  console.log(
    `[shot1] cut to ${SLOT_MS / 1000}s — model composed the doc in ` +
    `${(thinkSrcMs / 1000).toFixed(1)}s (\u2192${(ALPHA_THINK_MS / 1000).toFixed(2)}s), confirmed in ` +
    `${(afterCallSrcMs / 1000).toFixed(1)}s (\u2192${(ALPHA_AFTER_CALL_MS / 1000).toFixed(2)}s); ` +
    `arrival and confirmation both land at ${ANCHOR_MS / 1000}s`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});