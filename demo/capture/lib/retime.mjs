/**
 * retime.mjs — turn a long real-time recording into a short, correctly cut clip.
 *
 * A real pi TUI cannot be rushed: the model call after `/xfer beta …` takes as
 * long as it takes, and the shot budget is ten seconds. So the raw recordings are
 * cut here, against measured wall-clock events rather than guesses:
 *
 *  - `videoOrigin` finds the frame where the first visible ink appears and lines
 *    it up with the tape's own schedule, which pins video-time to wall-clock;
 *  - `retime` then assembles segments from the raw take, compressing the model
 *    wait into a short, busy spinner instead of cutting it away entirely.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const FPS = 30;

function sh(args) {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
}

/**
 * Video time (ms) of the first frame that is no longer flat background.
 *
 * The tape hides its setup and clears the screen, so the first thing the viewer
 * ever sees is the launch command being typed. Pinning that frame to the tape's
 * known schedule offset calibrates the recording against wall-clock events.
 */
export function firstInkFrameMs(video) {
  const out = execFileSync("ffmpeg", [
    "-v", "error", "-i", video,
    "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
    "-f", "null", "-",
  ], { encoding: "utf8" });
  const luma = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  if (!luma.length) throw new Error(`no frame stats for ${video}`);
  const floor = luma[0];
  const idx = luma.findIndex((v) => v > floor + 0.4);
  if (idx < 0) throw new Error(`${video}: no visible content found`);
  return Math.round((idx / FPS) * 1000);
}

function encodeSegment(src, startSec, srcDurSec, outDurSec, speed, file) {
  const filters = [`setpts=${speed.toFixed(6)}*PTS`, `fps=${FPS}`];
  if (outDurSec - srcDurSec * speed > 0.01) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${(outDurSec - srcDurSec * speed + 1).toFixed(3)}`);
  }
  sh([
    "-y", "-ss", startSec.toFixed(3), "-t", srcDurSec.toFixed(3), "-i", src,
    "-an", "-vf", filters.join(","), "-t", outDurSec.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    file,
  ]);
}

function concat(parts, out, seconds) {
  const listFile = `${out}.txt`;
  fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
  sh([
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-t", seconds.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", out,
  ]);
}

/**
 * Assemble `segments` into one clip.
 *
 * A segment is `{ startSec, srcDurSec, outDurSec }`; when `outDurSec` differs
 * from `srcDurSec` the segment is retimed, which is how the model wait becomes a
 * quick spin instead of a dead pause. `speed` is overridable per segment.
 */
export function retime(src, segments, out, seconds, scratch) {
  const parts = segments.map((seg, i) => {
    const file = `${scratch}/seg-${i}.mp4`;
    const speed = seg.speed ?? seg.outDurSec / seg.srcDurSec;
    encodeSegment(src, seg.startSec, seg.srcDurSec, seg.outDurSec, speed, file);
    return file;
  });
  concat(parts, out, seconds);
  return out;
}

export { FPS };