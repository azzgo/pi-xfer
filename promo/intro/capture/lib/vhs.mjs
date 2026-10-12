/**
 * vhs.mjs — shared VHS tape construction for the demo captures.
 *
 * Every terminal shot is a *replay* of lines that a real run produced: the
 * capture scripts hand us the real stdout/log lines, we drop them into a stub
 * `pi` executable, and VHS types the real command line and presses Enter. The
 * stub replays the recorded output on the stub's own schedule, so the moment a
 * line appears on screen is decided by real timings the caller measured.
 *
 * This keeps three properties the demo depends on:
 *  - the command line is genuinely typed and visible (no startup banner, no
 *    interactive TUI swallowing the replay),
 *  - output cannot appear before the event it belongs to,
 *  - the terminal geometry is known, so the composition can frame it without
 *    cropping.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const THEME = {
  background: "#101014",
  foreground: "#e6e6eb",
  accent: "#7c6cf0",
  green: "#7ee787",
  purple: "#c297ff",
  yellow: "#e3b341",
  red: "#ff7b72",
};

/** A VHS tape string literal. */
export const q = (s) => JSON.stringify(String(s));

/** Geometry + theme preamble shared by every terminal tape. */
export function tapeHeader({ output, width, height, fontSize, typingSpeed = "6ms" }) {
  return [
    `Output ${q(output)}`,
    `Set Shell "bash"`,
    `Set FontFamily Menlo`,
    `Set FontSize ${fontSize}`,
    `Set LineHeight 1.2`,
    `Set Theme ${JSON.stringify(THEME)}`,
    `Set Width ${width}`,
    `Set Height ${height}`,
    `Set Padding 28`,
    `Set Margin 0`,
    `Set BorderRadius 0`,
    `Set TypingSpeed ${typingSpeed}`,
  ];
}

/**
 * Write an executable stub that ignores its arguments and replays `chunks`.
 * Each chunk is `{ afterMs, text }`: `afterMs` is measured from the moment the
 * stub is invoked, so the caller controls exactly when a line lands on screen.
 */
export function writeStub(binDir, name, chunks) {
  fs.mkdirSync(binDir, { recursive: true });
  const body = ["#!/bin/bash", "set -u"];
  for (const chunk of chunks) {
    body.push(`sleep ${(chunk.afterMs / 1000).toFixed(3)}`);
    body.push("cat <<'XFER_STUB_EOF'");
    body.push(chunk.text.replace(/\n$/, ""));
    body.push("XFER_STUB_EOF");
  }
  const file = path.join(binDir, name);
  fs.writeFileSync(file, body.join("\n") + "\n", { mode: 0o755 });
  return file;
}

/**
 * Assemble a full tape: hidden environment setup, a visible typed command, and
 * a trailing hold that lands the recording on `totalMs`.
 */
export function buildTape({ output, width, height, fontSize, binDir, command, commandAtMs, totalMs }) {
  const typeMsPerChar = 6;
  const lines = tapeHeader({ output, width, height, fontSize });

  lines.push("Hide");
  lines.push(`Type@1ms ${q(`export PATH=${binDir}:$PATH; PS1='$ '; clear`)}`);
  lines.push("Enter");
  lines.push("Show");

  let cursor = 250;
  const sleepTo = (target) => {
    const delta = target - cursor;
    if (delta < 0) throw new Error(`tape cursor ${cursor}ms already past ${target}ms`);
    lines.push(`Sleep ${delta}ms`);
    cursor = target;
  };

  sleepTo(commandAtMs);
  lines.push(`Type@${typeMsPerChar}ms ${q(command)}`);
  cursor += command.length * typeMsPerChar;
  lines.push("Enter");
  cursor += 120;

  const tailMs = Math.max(400, totalMs - cursor - 200);
  lines.push(`Sleep ${tailMs}ms`);
  lines.push("");

  return lines.join("\n");
return lines.join("\n");
}
/**
 * A tape that drives a real interactive `pi` session: it types the launch
 * command into a clean shell and lets the real TUI own the terminal from there.
 *
 * Returns the tape plus the tape-schedule timestamps the caller needs to line
 * real wall-clock events up with the recording:
 *  - `inkAtMs` when the first character of the launch command is typed, which
 *    is the first thing visible in the video (everything before it is hidden
 *    and the screen is cleared), so it doubles as the origin anchor;
 *  - `typeAtMs` when a follow-up keystroke is submitted.
 */
export function buildTuiTape({
  output, width, height, fontSize, cwd, marker, alias, launch, launchAtMs = 900, submit, submitAtMs, holdMs,
}) {
  const typeMsPerChar = 10;
  const lines = tapeHeader({ output, width, height, fontSize, typingSpeed: `${typeMsPerChar}ms` });

  /* One setup line that ends in `clear`: VHS's Hide does not reliably suppress
   * echoed input, but a cleared screen does, so nothing of the harness shows.
   *
   * The `touch` in the middle is the capture's wall-clock reading from inside
   * the very recording it is about to cut, which pins real events to the
   * timeline without guessing how long VHS took to boot. `touch` keeps that
   * instant free of interpreter start-up; the caller reads it back as mtimeMs. */
  const setup =
    `cd ${cwd} && export PS1='$ '` +
    (alias ? ` && alias pi='${alias}'` : "") +
    ` && touch ${marker} && clear`;
  lines.push("Hide");
  lines.push(`Type@1ms ${q(setup)}`);
  lines.push("Enter");
  const markerTapeMs = setup.length + 1;
  lines.push("Show");
  lines.push("Sleep 700ms");

  let cursor = 700;
  const sleepTo = (target) => {
    lines.push(`Sleep ${target - cursor}ms`);
    cursor = target;
  };

  sleepTo(launchAtMs);
  const inkAtMs = cursor;
  lines.push(`Type@${typeMsPerChar}ms ${q(launch)}`);
  cursor += launch.length * typeMsPerChar;
  lines.push("Enter");
  cursor += 120;

  let typeAtMs = null;
  if (submit) {
    sleepTo(submitAtMs);
    typeAtMs = cursor;
    lines.push(`Type@${typeMsPerChar}ms ${q(submit)}`);
    cursor += submit.length * typeMsPerChar;
    lines.push("Enter");
    cursor += 120;
  }

  lines.push(`Sleep ${Math.max(1000, holdMs - cursor)}ms`);
  lines.push("");
  return { tape: lines.join("\n"), inkAtMs, typeAtMs, markerTapeMs };
}

/**
 * The parts of a real inbound handoff doc worth putting on screen: who sent it,
 * what they asked for, which document to read. The trailing "how to answer"
 * guidance the extension appends is real but it is not the story of this shot.
 */
export function inboundHighlights(doc) {
  const keep = [];
  for (const para of String(doc).split("\n\n")) {
    const head = para.trimStart();
    if (
      head.startsWith("📨") ||
      head.startsWith("**Request**") ||
      head.startsWith("**Doc**") ||
      head.startsWith("Read the doc and handle")
    ) {
      keep.push(para);
    }
  }
  if (!keep.length) throw new Error("inbound doc carried no request or doc line");
  return keep.join("\n\n");
}

/** Render a tape file with VHS; resolves on exit code 0. */
export function runVhs(tapePath, cwd) {
  return new Promise((resolve, reject) => {
    const vhs = spawn("vhs", [path.basename(tapePath)], { stdio: "inherit", cwd });
    vhs.on("error", reject);
    vhs.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vhs exited ${code} rendering ${tapePath}`))
    );
  });
}