// Loads the recorded speech in test/fixtures/voice (16 kHz mono WAV, made with Windows'
// built-in text-to-speech voices: "David", a male voice, and "Zira", a female voice) and
// cuts it into the ~50 ms frames the exam app analyses.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fixtures', 'voice');
const FRAME = 768;  // samples per analysed frame at 16 kHz (48 ms)
const HOP = 800;    // 50 ms between frames, like the app's 20 checks a second

function readWav(name) {
  const buf = fs.readFileSync(path.join(DIR, name));
  let offset = 12;
  let rate = 16000;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(offset + 12);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768;
      return { samples, rate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${name}`);
}

// A quiet room: low-level noise under everything, as a laptop microphone hears it
function withRoomNoise(samples, seed = 1, level = 0.002) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] + rand() * level;
  return out;
}

function silence(seconds, rate = 16000) {
  return new Float32Array(Math.round(seconds * rate));
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function slice(samples, fromSec, toSec, rate = 16000) {
  return samples.slice(Math.round(fromSec * rate), Math.round(toSec * rate));
}

/** Frames with their start time in ms. */
function* frames(samples) {
  for (let start = 0, i = 0; start + FRAME <= samples.length; start += HOP, i++) {
    yield { t: i * 50, data: samples.subarray(start, start + FRAME) };
  }
}

module.exports = { readWav, withRoomNoise, silence, concat, slice, frames, RATE: 16000 };
