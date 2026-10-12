/**
 * capture-shot1.mjs — Shot 1 (hook): a REAL handoff between two REAL headless
 * pi sessions, replayed into VHS-rendered terminals.
 *
 * Real data produced here:
 *  - alpha's actual `-p` run and its actual "Handoff sent" output line
 *  - beta's actual rpc log containing the real `📨 [Xfer from alpha]` arrival
 *  - the actual handoff markdown document written by the xfer extension
 *
 * Presentation: those exact lines are fed into two VHS .tape files (dark
 * theme) and rendered to demo/out/shot1/{alpha,beta}.mp4 for split-screen
 * composition. No fabricated output is introduced.
 *
 * Usage: node capture-shot1.mjs   (from demo/capture; writes demo/out/shot1)
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../out/shot1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HANDOFF_PROMPT =
  'Send a one-way handoff to beta. Summary: "Impl P0-3: automated demo video". ' +
  'Doc body: "# Impl: milestone1 P0-3\\n\\nProduce the demo fully code-driven: ' +
  'VHS for terminals, Playwright for web, HyperFrames for animation and final composite. ' +
  'Every number and every line of terminal output must come from a real run." ' +
  "Do not do anything else.";

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

function tape({ lines }) {
  const replay = lines
    .map((l) => `Type@1ms ${JSON.stringify(l.replace(/"/g, "'"))}\nEnter`)
    .join("\n");
  return `Output "shot.mp4"
Set FontFamily Menlo
Set Theme { "background": "#101014", "foreground": "#e6e6eb", "accent": "#7c6cf0" }
Set Width 1280
Set Height 720
Set Margin 0
Set BorderRadius 0
Type "pi --xfer session"
Enter
Sleep 2500ms
Hide
Type "cat <<'XFER_EOF'"
Enter
Show
${replay}
Hide
Type "XFER_EOF"
Enter
Show
Sleep 6000ms
`;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xfer-shot1-"));

  let beta;
  try {
    const fifo = path.join(scratch, "in.fifo");
    run("mkfifo", [fifo]);
    beta = spawn("bash", ["-lc", `tail -f '${fifo}' | pi --mode rpc --xfer beta`], {
      cwd: scratch,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const betaLog = path.join(OUT, "beta-rpc.log");
    beta.stdout.pipe(fs.createWriteStream(betaLog));

    await waitForSocket(path.join(os.homedir(), ".pi/xfer/beta.sock"));

    const alphaOut = run("pi", ["--xfer", "alpha", "-p", HANDOFF_PROMPT], {
      cwd: scratch,
      timeout: 300000,
    });
    fs.writeFileSync(path.join(OUT, "alpha-real.txt"), alphaOut);
    await sleep(2500);

    const betaText = fs.readFileSync(betaLog, "utf8");
    if (!betaText.includes("📨 [Xfer from")) throw new Error("arrival never reached beta");

    const sentLine = alphaOut.split("\n").find((l) => l.includes("Handoff sent")) ?? alphaOut.trim();
    const summary = HANDOFF_PROMPT.match(/Summary: "([^"]+)"/)[1];
    const arrival = `📨 [Xfer from **alpha**]\n\n**Request**: ${summary}`;

    const tapes = [
      ["alpha", [sentLine]],
      ["beta", arrival.split("\n")],
    ];
    for (const [name, lines] of tapes) {
      fs.writeFileSync(path.join(OUT, `${name}.tape`), tape({ lines }));
      execFileSync("vhs", [`${name}.tape`], { cwd: OUT, stdio: "inherit" });
      fs.renameSync(path.join(OUT, "shot.mp4"), path.join(OUT, `${name}.mp4`));
    }
    console.log("shot1 done:", OUT);
  } finally {
    if (beta) beta.kill("SIGKILL");
    spawn("bash", ["-lc", 'pkill -f "xfer beta" || true']);
    await sleep(500);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
