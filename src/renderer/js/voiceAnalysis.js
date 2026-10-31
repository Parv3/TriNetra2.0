/**
 * Voice analysis for exam proctoring. Pure functions with no browser APIs, so the same code
 * runs in the exam app and in the Node tests (test/voice_analysis.test.js), which use real
 * recorded speech from two different voices.
 *
 * Two signals:
 *  - OTHER_VOICE: speech is heard while the camera sees the student's lips not moving.
 *    The strongest signal: it doesn't depend on what the other voice sounds like.
 *  - MULTIPLE_VOICES: the speech splits into two clearly different pitch groups (a
 *    conversation), at least one of which doesn't match the student's voice sample.
 *
 * Pitch is the fundamental frequency of voiced speech (roughly 85–180 Hz for most men and
 * 165–255 Hz for most women), estimated by normalised autocorrelation. Differences are
 * measured in semitones (12 per octave). Two speakers with very similar pitch can't be told
 * apart this way; the lip check still catches a second speaker in that case.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_PITCH_HZ = 70;
  const MAX_PITCH_HZ = 400;
  const VOICED_CLARITY = 0.6;      // autocorrelation peak needed to call a frame voiced
  const NOISE_FLOOR_MIN_DB = -75;  // digital silence must not make every sound look like speech

  // Per exam strictness, like the camera's profiles in proctorClient.js
  const PROFILES = {
    relaxed: { sustainMs: 3000, minSpeechShare: 0.35, speechMarginDb: 14 },
    standard: { sustainMs: 2000, minSpeechShare: 0.3, speechMarginDb: 12 },
    strict: { sustainMs: 1200, minSpeechShare: 0.25, speechMarginDb: 10 }
  };

  const WINDOW_MS = 3000;          // speech is judged over the last 3 seconds
  const DROPOUT_MS = 900;          // a condition that lapses for longer than this starts over
  const COOLDOWN_MS = 10000;       // the same kind of event at most every 10 s
  const VOICE_SPLIT_SEMITONES = 6; // half an octave between two pitch groups
  const MISMATCH_SEMITONES = 5;    // away from the student's own median pitch

  const semitones = (hz) => 12 * Math.log2(hz / 440);
  const median = (values) => {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /**
   * Loudness and pitch of one frame of audio (about 40–60 ms of samples).
   * Returns { db, pitch: Hz or null when unvoiced, clarity: 0..1 }.
   */
  function analyzeFrame(input, sampleRate) {
    let samples = input;
    let rate = sampleRate;
    // Pitch needs no more than ~16 kHz; averaging pairs of samples halves the work at 48 kHz.
    const factor = Math.max(1, Math.floor(sampleRate / 16000));
    if (factor > 1) {
      const n = Math.floor(input.length / factor);
      samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < factor; k++) sum += input[i * factor + k];
        samples[i] = sum / factor;
      }
      rate = sampleRate / factor;
    }

    const n = samples.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n || 1;
    const x = new Float32Array(n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] = samples[i] - mean;
      energy += x[i] * x[i];
    }
    const rms = Math.sqrt(energy / (n || 1));
    const db = 20 * Math.log10(rms + 1e-10);

    const minLag = Math.floor(rate / MAX_PITCH_HZ);
    const maxLag = Math.min(Math.ceil(rate / MIN_PITCH_HZ), Math.floor(n / 2));
    if (energy <= 0 || maxLag <= minLag + 2) return { db, pitch: null, clarity: 0 };

    // Normalised autocorrelation: 1.0 means the waveform repeats exactly after `lag` samples
    const nr = new Float32Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let r = 0;
      let e0 = 0;
      let e1 = 0;
      for (let i = 0; i < n - lag; i++) {
        r += x[i] * x[i + lag];
        e0 += x[i] * x[i];
        e1 += x[i + lag] * x[i + lag];
      }
      nr[lag] = e0 > 0 && e1 > 0 ? r / Math.sqrt(e0 * e1) : 0;
      if (lag <= maxLag && nr[lag] > best) best = nr[lag];
    }
    if (best < VOICED_CLARITY) return { db, pitch: null, clarity: best };

    // The first peak close to the best one: later peaks are multiples of the true period
    // and would read an octave too low.
    let chosen = -1;
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (nr[lag] >= 0.9 * best && nr[lag] >= nr[lag - 1] && nr[lag] >= nr[lag + 1]) {
        chosen = lag;
        break;
      }
    }
    if (chosen < 0) return { db, pitch: null, clarity: best };

    // Parabolic interpolation around the peak for sub-sample precision
    const a = nr[chosen - 1];
    const b = nr[chosen];
    const c = nr[chosen + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const period = chosen + Math.max(-0.5, Math.min(0.5, shift));
    return { db, pitch: rate / period, clarity: b };
  }

  /** Two-group split of pitch values (in semitones): { centers, shares, spreads } or null. */
  function splitInTwo(values) {
    if (values.length < 6) return null;
    let c1 = Math.min(...values);
    let c2 = Math.max(...values);
    if (c2 - c1 < 0.5) return null;
    let g1 = [];
    let g2 = [];
    for (let iter = 0; iter < 10; iter++) {
      g1 = [];
      g2 = [];
      values.forEach(v => (Math.abs(v - c1) <= Math.abs(v - c2) ? g1 : g2).push(v));
      if (!g1.length || !g2.length) return null;
      c1 = g1.reduce((s, v) => s + v, 0) / g1.length;
      c2 = g2.reduce((s, v) => s + v, 0) / g2.length;
    }
    const spread = (g, c) => Math.sqrt(g.reduce((s, v) => s + (v - c) ** 2, 0) / g.length);
    return {
      centers: [c1, c2],
      shares: [g1.length / values.length, g2.length / values.length],
      spreads: [spread(g1, c1), spread(g2, c2)]
    };
  }

  /**
   * Builds a voice baseline from the student's spoken sample.
   * frames: [{ db, pitch, clarity, lipRange? }] from analyzeFrame (plus mouth movement).
   */
  function buildBaseline(frames) {
    const quiet = frames.map(f => f.db).sort((a, b) => a - b);
    const noiseDb = Math.max(NOISE_FLOOR_MIN_DB, quiet[Math.floor(quiet.length * 0.1)] ?? NOISE_FLOOR_MIN_DB);
    const voiced = frames.filter(f => f.pitch && f.db > noiseDb + 10);
    const voicedMs = voiced.length;
    if (voiced.length < 15) {
      return { ok: false, reason: "We couldn't hear you clearly. Read the sentence aloud, a little louder, close to the laptop." };
    }
    // Fold octave errors toward the median before taking the voice's centre
    const st = voiced.map(f => semitones(f.pitch));
    const m0 = median(st);
    const folded = st.map(v => (Math.abs(v - m0 - 12) < 1.5 ? v - 12 : Math.abs(v - m0 + 12) < 1.5 ? v + 12 : v));
    const pitchSt = median(folded);
    // How much the lips moved while speaking: the lip check needs a clear difference from stillness
    const ranges = voiced.map(f => f.lipRange).filter(v => typeof v === 'number');
    const talkingLipRange = ranges.length >= voiced.length * 0.5 ? median(ranges) : null;
    return {
      ok: true,
      pitchSt,
      pitchHz: Math.round(440 * 2 ** (pitchSt / 12)),
      noiseDb,
      voicedFrames: voicedMs,
      talkingLipRange
    };
  }

  /**
   * Turns a stream of analysed frames into proctoring events.
   *   push(features, { t, faceCount, lipsMoving }) → null or { type, details }
   * lipsMoving is true/false from the camera, or null when the camera can't tell.
   */
  class VoiceDetector {
    constructor({ strictness = 'standard', baseline = null } = {}) {
      this.profile = PROFILES[strictness] || PROFILES.standard;
      this.baseline = baseline && baseline.ok ? baseline : null;
      this.noiseDb = this.baseline ? this.baseline.noiseDb : null;
      this.frames = [];
      this.pending = {};
      this.lastEventAt = {};
    }

    updateNoiseFloor(db) {
      if (this.noiseDb === null) this.noiseDb = Math.max(db, NOISE_FLOOR_MIN_DB);
      else if (db < this.noiseDb) this.noiseDb = Math.max(NOISE_FLOOR_MIN_DB, this.noiseDb * 0.7 + db * 0.3);
      else this.noiseDb += 0.05; // creeps up slowly, so a fan turning on is absorbed
    }

    push(feat, ctx) {
      const t = ctx.t;
      const speech = Boolean(feat.pitch) && feat.db > (this.noiseDb ?? NOISE_FLOOR_MIN_DB) + this.profile.speechMarginDb;
      if (!speech) this.updateNoiseFloor(feat.db);
      this.frames.push({
        t,
        speech,
        st: speech ? semitones(feat.pitch) : null,
        face: ctx.faceCount === 1,
        lips: speech ? (ctx.lipsMoving === undefined ? null : ctx.lipsMoving) : null
      });
      while (this.frames.length && t - this.frames[0].t > WINDOW_MS) this.frames.shift();

      const found = this.evaluate();
      for (const type of ['OTHER_VOICE', 'MULTIPLE_VOICES']) {
        const event = this.sustain(type, found[type], t);
        if (event) return event;
      }
      return null;
    }

    evaluate() {
      const frames = this.frames;
      const spoken = frames.filter(f => f.speech);
      const out = { OTHER_VOICE: null, MULTIPLE_VOICES: null };
      if (frames.length < 10 || spoken.length / frames.length < this.profile.minSpeechShare) return out;

      const speechSeconds = Math.round(spoken.length * (WINDOW_MS / frames.length) / 100) / 10;
      // No octave folding here: a man's and a woman's voice are often about an octave apart,
      // and folding would merge them into one. Stray octave errors are too few to form a group.
      const folded = spoken.map(f => f.st);
      const toHz = (s) => Math.round(440 * 2 ** (s / 12));
      const base = this.baseline;

      // 1. Speech while the student's lips are still
      const faceShare = frames.filter(f => f.face).length / frames.length;
      const lipKnown = spoken.filter(f => f.lips !== null);
      if (faceShare >= 0.8 && lipKnown.length >= spoken.length * 0.8) {
        const movingShare = lipKnown.filter(f => f.lips).length / lipKnown.length;
        if (movingShare < 0.2) {
          out.OTHER_VOICE = { reason: 'lips-still', speechSeconds, lipsMovingShare: Math.round(movingShare * 100) / 100, voicePitchHz: toHz(median(folded)) };
        }
      } else if (base && lipKnown.length < spoken.length * 0.5) {
        // Camera can't see the lips: fall back to the voice not matching the student's sample
        const away = folded.filter(v => Math.abs(v - base.pitchSt) > MISMATCH_SEMITONES).length / folded.length;
        if (away >= 0.7) {
          out.OTHER_VOICE = { reason: 'voice-mismatch', speechSeconds, voicePitchHz: toHz(median(folded)), studentPitchHz: base.pitchHz };
        }
      }

      // 2. Two different voices in the same few seconds
      const split = splitInTwo(folded);
      if (split) {
        const gap = Math.abs(split.centers[0] - split.centers[1]);
        const balanced = Math.min(...split.shares) >= 0.2;
        const tight = Math.max(...split.spreads) < gap / 3;
        const strange = !base || split.centers.some(c => Math.abs(c - base.pitchSt) > MISMATCH_SEMITONES);
        if (gap >= VOICE_SPLIT_SEMITONES && balanced && tight && strange) {
          out.MULTIPLE_VOICES = {
            reason: 'two-pitch-groups',
            speechSeconds,
            voicesHz: split.centers.map(toHz).sort((a, b) => a - b),
            ...(base ? { studentPitchHz: base.pitchHz } : {})
          };
        }
      }
      return out;
    }

    /** A condition must hold for the profile's sustain time (allowing short gaps) before it's an event. */
    sustain(type, details, t) {
      const p = this.pending[type];
      if (!details) {
        if (p && t - p.lastSeen > DROPOUT_MS) delete this.pending[type];
        return null;
      }
      if (!p) {
        this.pending[type] = { since: t, lastSeen: t };
        return null;
      }
      p.lastSeen = t;
      if (t - p.since < this.profile.sustainMs) return null;
      if (t - (this.lastEventAt[type] || -Infinity) < COOLDOWN_MS) return null;
      this.lastEventAt[type] = t;
      delete this.pending[type];
      return { type, details };
    }
  }

  return { analyzeFrame, buildBaseline, VoiceDetector, splitInTwo, semitones, PROFILES };
});
