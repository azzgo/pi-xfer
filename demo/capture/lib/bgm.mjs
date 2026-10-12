/**
 * bgm.mjs — synthesize the demo's music bed.
 *
 * The demo ships no third-party audio: this writes the bed itself, so there is
 * no licence to attribute, no download step, and the file is byte-identical on
 * every machine. `demo/build.mjs` calls this when the track is missing.
 *
 * What it makes: a slow, light pad in A minor with a sparse arpeggio over it —
 * Am – F – C – G, one chord every 6.4s — low-passed to stay soft and mixed low
 * enough to sit under the captions. Silence would be a louder signal than this:
 * it is bed, not content.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 32_000;
const TAIL_SECONDS = 3;
const CHORD_SECONDS = 6.4;
const FADE_IN = 2;
const FADE_OUT = 3.5;

/** i – VI – III – VII in A minor. Three tones each, Hz. */
const CHORDS = [
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
  [261.63, 329.63, 392.0],
  [196.0, 246.94, 293.66],
];

const track = (seconds) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

/** Sum a tone's harmonics with per-harmonic decay and an ADSR-ish shape. */
function pad(out, startSec, durationSec, freq, gain) {
  const start = Math.round(startSec * SAMPLE_RATE);
  const length = Math.min(out.length - start, Math.round(durationSec * SAMPLE_RATE));
  const partials = [
    [1, 1.0, 1.4],
    [2, 0.28, 0.9],
    [3, 0.09, 0.6],
  ];
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, t / 1.6);
    const release = Math.min(1, (durationSec - t) / 1.8);
    const env = Math.max(0, Math.min(attack, release));
    const wobble = 1 + 0.004 * Math.sin(2 * Math.PI * 0.13 * t + freq);
    let sample = 0;
    for (const [ratio, amp, decay] of partials) {
      sample += amp * Math.exp(-decay * t) * Math.sin(2 * Math.PI * freq * ratio * wobble * t);
    }
    out[start + i] += sample * env * gain;
  }
}

/** One plucked note, fast attack, exponential decay. */
function pluck(out, startSec, freq, gain) {
  const start = Math.round(startSec * SAMPLE_RATE);
  const length = Math.min(out.length - start, Math.round(1.1 * SAMPLE_RATE));
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, t / 0.006) * Math.exp(-t * 4.2);
    out[start + i] += Math.sin(2 * Math.PI * freq * t) * env * gain;
  }
}

/** One-pole low-pass: take the edge off so the bed never gets shrill. */
function lowpass(buf, cutoffHz) {
  const alpha = (1 - Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE));
  let last = 0;
  for (let i = 0; i < buf.length; i++) {
    last += alpha * (buf[i] - last);
    buf[i] = last;
  }
}

function shape(buf) {
  lowpass(buf, 2400);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const norm = peak > 0 ? 0.62 / peak : 1;
  const fadeIn = Math.round(FADE_IN * SAMPLE_RATE);
  const fadeOut = Math.round(FADE_OUT * SAMPLE_RATE);
  for (let i = 0; i < buf.length; i++) {
    let g = norm;
    if (i < fadeIn) g *= i / fadeIn;
    const tail = buf.length - i;
    if (tail < fadeOut) g *= tail / fadeOut;
    buf[i] = Math.max(-1, Math.min(1, buf[i] * g));
  }
}

function writeWav(samples, file) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

export function renderBgm(outFile, seconds) {
  const duration = seconds + TAIL_SECONDS;
  const bed = track(duration);

  let step = 0;
  for (let c = 0; c * CHORD_SECONDS < seconds; c++) {
    const chord = CHORDS[c % CHORDS.length];
    const at = c * CHORD_SECONDS;
    for (const freq of chord) pad(bed, at, CHORD_SECONDS * 1.05, freq, 0.3);
    // Two notes per chord, walking up then back down.
    for (let k = 0; k < 2; k++) {
      const tone = chord[(step + k) % chord.length] * (k === 0 ? 2 : 4);
      pluck(bed, at + k * CHORD_SECONDS * 0.5, tone, k === 0 ? 0.09 : 0.05);
    }
    step += 2;
  }

  shape(bed);
  const wav = `${outFile}.wav`;
  writeWav(bed, wav);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-i", wav,
    "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-movflags", "+faststart", outFile,
  ]);
  fs.rmSync(wav, { force: true });
  return outFile;
}

/** Render the bed if it is not already on disk. */
export function ensureBgm(outFile, seconds) {
  if (fs.existsSync(outFile)) return false;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  renderBgm(outFile, seconds);
  return true;
}