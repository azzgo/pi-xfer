/**
 * capture-shot1.mjs — Shot 1 (hook): a REAL handoff between two REAL pi sessions,
 * replayed into two VHS-rendered terminals.
 *
 * Real data produced here:
 *  - alpha's actual `-p` run and its actual "Handoff sent" output line
 *  - beta's actual rpc log containing the real `📨 [Xfer from alpha]` arrival
 *  - the real wall-clock latency between the send and beta receiving it
 *
 * Presentation: the tape types the real command line and presses Enter against a
 * stub `pi` that replays the recorded output. No pi startup banner, no model
 * list, no interactive TUI — the shot opens on a clean `$` prompt.
 *
 * Usage: node capture-shot1.mjs   (from demo/capture; writes demo/out/shot1)
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTape, inboundHighlights, runVhs, writeStub } from "./lib/vhs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../out/shot1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Short handoff-doc paths: os.tmpdir() on macOS is a 60-char /var/folders path
 * that eats two terminal lines. /tmp holds the same real documents. */
if (fs.existsSync("/tmp")) process.env.TMPDIR = "/tmp";

/** Terminal geometry. The composition frames these 1:1 — see demo/README.md. */
const SHOT = { width: 880, height: 700, fontSize: 26, totalMs: 12_000 };

const SUMMARY = "Impl P0-3: automated demo video";
const HANDOFF_PROMPT =
  `Send a one-way handoff to beta. Summary: ${SUMMARY}. Body: ` +
  "every frame of the demo is code-produced from real runs. Do nothing else.";

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

async function waitForSocket(sock, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) return;
    await sleep(300);
  }
  throw new Error(`socket never appeared: ${sock}`);
}

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}
/** The one line alpha actually printed, trimmed of pi's own status noise. */
function handoffLine(stdout) {
  const lines = stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  return lines.find((l) => l.includes("Handoff sent")) ?? lines.at(-1) ?? "";
}

/** The real inbound markdown beta received, pulled out of its rpc log. */
function inboundDoc(logText) {
  for (const raw of logText.split("\n")) {
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
  throw new Error("no xfer-inbound message in beta rpc log");
}

/** Keep the header, the request and the doc pointer; drop the shared boilerplate. */
function arrivalLines(doc) {
  return inboundHighlights(doc).split("\n");
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-shot1-"));
  const binDir = path.join(scratch, "bin");
  let beta;
  try {
    const fifo = path.join(scratch, "in.fifo");
    run("mkfifo", [fifo]);
    beta = spawn("bash", ["-lc", `tail -f '${fifo}' | pi --mode rpc --xfer beta`], {
      cwd: scratch,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const betaLog = path.join(OUT, "beta-rpc.log");
    beta.stdout.pipe(fs.createWriteStream(betaLog));

    await waitForSocket(path.join(os.homedir(), ".pi/xfer/beta.sock"));

    const sentAt = Date.now();
    const alphaOut = run("pi", ["--xfer", "alpha", "-p", HANDOFF_PROMPT], {
      cwd: scratch,
      timeout: 300000,
    });
    fs.writeFileSync(path.join(OUT, "alpha-real.txt"), alphaOut);

    await waitFor(() => {
      try {
        return fs.readFileSync(betaLog, "utf8").includes("📨 [Xfer from");
      } catch {
        return false;
      }
    }, 30000, "arrival at beta");
    const latencyMs = Date.now() - sentAt;
    const replayDelayMs = Math.max(1400, Math.min(latencyMs, 4200));

    const sent = handoffLine(alphaOut);
    const arrival = arrivalLines(inboundDoc(fs.readFileSync(betaLog, "utf8")));
    if (!sent) throw new Error("alpha produced no handoff line");

    const shots = [
      {
        name: "alpha",
        command: `pi --xfer alpha -p '${HANDOFF_PROMPT}'`,
        commandAtMs: 900,
        chunks: [{ afterMs: 1800, text: sent }],
      },
      {
        name: "beta",
        command: "pi --mode rpc --xfer beta",
        commandAtMs: 900,
        chunks: [
          { afterMs: replayDelayMs, text: arrival[0] },
          { afterMs: 650, text: arrival.slice(1).join("\n") },
        ],
      },
    ];

    for (const shot of shots) {
      writeStub(binDir, "pi", shot.chunks);
      const tape = buildTape({
        output: "shot.mp4",
        width: SHOT.width,
        height: SHOT.height,
        fontSize: SHOT.fontSize,
        binDir,
        command: shot.command,
        commandAtMs: shot.commandAtMs,
        totalMs: SHOT.totalMs,
      });
      fs.writeFileSync(path.join(OUT, `${shot.name}.tape`), tape);
      await runVhs(path.join(OUT, `${shot.name}.tape`), OUT);
      fs.renameSync(path.join(OUT, "shot.mp4"), path.join(OUT, `${shot.name}.mp4`));
    }

    fs.writeFileSync(
      path.join(OUT, "shot1.json"),
      JSON.stringify({ latencyMs, summary: SUMMARY, command: shots[0].command }, null, 2)
    );
    console.log(`shot1 done: ${OUT} (real send→arrival latency ${latencyMs}ms)`);
  } finally {
    if (beta?.pid) {
      try { process.kill(-beta.pid, "SIGKILL"); } catch {}
    }
    await sleep(500);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});