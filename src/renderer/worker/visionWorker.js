/**
 * visionWorker.js — Web Worker for AI Vision Proctoring
 *
 * Message protocol:
 *
 *   IN:  { type: 'INIT',          config }
 *   IN:  { type: 'PROCESS_FRAME', imageData, timestamp }
 *
 *   OUT: { type: 'INIT_COMPLETE', backend }
 *   OUT: { type: 'DETECTION_RESULT', faceCount, euler, gaze, violation, ts }
 *   OUT: { type: 'ERROR', error }
 *
 * The worker attempts to load @vladmandic/human for real model-based
 * detection.  When unavailable (competition prototype) it falls back to a
 * simulated detection pipeline.  The heuristics module (EAR, head-pose, gaze,
 * hysteresis) is always real.
 */

/* global self, importScripts */

// ─── Load heuristics ────────────────────────────────────────────────────────
// In a Worker context we use importScripts.  The heuristics module attaches
// itself to `self.heuristics` when it detects a Worker environment.

try {
  importScripts('./heuristics.js');
} catch (_e) {
  // Fallback: the file might already have been bundled by a tool like webpack
  // or vite; in that case self.heuristics should already exist.
}

const {
  computeEAR,
  computeHeadPose,
  computeGazeRatio,
  classifyViolation,
  HysteresisStateMachine,
} = self.heuristics || {};

// ─── State ──────────────────────────────────────────────────────────────────

let _initialised = false;
let _config = {};
let _hsm = null;            // HysteresisStateMachine instance
let _human = null;           // @vladmandic/human instance (if available)
let _useSimulation = false;  // true when real models are unavailable
let _frameCount = 0;         // running frame counter (used by simulation)

// ─── Initialisation ─────────────────────────────────────────────────────────

/**
 * Attempt to load @vladmandic/human.  If it isn't available we switch to the
 * simulated pipeline.
 */
async function init(config = {}) {
  _config = {
    // Detection thresholds (forwarded to classifyViolation / HSM)
    yawThreshold:        config.yawThreshold        ?? 25,
    pitchUpperThreshold: config.pitchUpperThreshold  ?? 25,
    pitchLowerThreshold: config.pitchLowerThreshold  ?? -20,
    hgrLower:            config.hgrLower             ?? 0.35,
    hgrUpper:            config.hgrUpper             ?? 0.65,
    earBlinkThreshold:   config.earBlinkThreshold    ?? 0.21,

    // Hysteresis timeouts
    noFaceTimeout:        config.noFaceTimeout        ?? 3000,
    multipleFacesTimeout: config.multipleFacesTimeout  ?? 1200,
    gazeDiversionTimeout: config.gazeDiversionTimeout  ?? 2000,
    eyesClosedTimeout:    config.eyesClosedTimeout     ?? 2500,
    blinkMaxDuration:     config.blinkMaxDuration      ?? 400,

    // Simulation behaviour
    simulateFaceProb:     config.simulateFaceProb      ?? 0.92,
    simulateMultiProb:    config.simulateMultiProb     ?? 0.02,
    ...config,
  };

  _hsm = new HysteresisStateMachine(_config);

  // Try loading the real model library
  let backend = 'simulation';
  try {
    // In an Electron Worker, the module may be available via a bundler alias
    // or a direct path supplied in config.humanModelPath.
    if (typeof require === 'function') {
      const Human = require('@vladmandic/human').default || require('@vladmandic/human');
      _human = new Human({
        backend: 'webgl',
        modelBasePath: config.humanModelPath || 'models/',
        face: {
          enabled: true,
          detector: { rotation: true },
          mesh:     { enabled: true },
          iris:     { enabled: true },
        },
        body:    { enabled: false },
        hand:    { enabled: false },
        gesture: { enabled: false },
      });
      await _human.load();
      await _human.warmup();
      backend = 'human-webgl';
      _useSimulation = false;
    } else {
      throw new Error('require not available');
    }
  } catch (_loadErr) {
    _useSimulation = true;
    backend = 'simulation';
  }

  _initialised = true;
  _frameCount = 0;

  self.postMessage({ type: 'INIT_COMPLETE', backend });
}

// ─── Real Detection Pipeline ────────────────────────────────────────────────

/**
 * Run @vladmandic/human on the supplied image and convert output to our
 * unified detection-result format.
 */
async function detectReal(imageData) {
  const result = await _human.detect(imageData);
  const faceCount = result.face ? result.face.length : 0;

  if (faceCount === 0) {
    return { faceCount: 0, yaw: 0, pitch: 0, roll: 0, hgr: 0.5, ear: 0 };
  }

  const face = result.face[0];

  // Head pose — prefer the library's own euler if present
  let yaw = 0, pitch = 0, roll = 0;
  if (face.rotation && face.rotation.angle) {
    yaw   = face.rotation.angle.yaw   || 0;
    pitch = face.rotation.angle.pitch  || 0;
    roll  = face.rotation.angle.roll   || 0;
  } else if (face.mesh && face.mesh.length >= 468) {
    const pose = computeHeadPose(face.mesh);
    yaw = pose.yaw; pitch = pose.pitch; roll = pose.roll;
  }

  // EAR — compute from mesh landmarks
  let ear = 0.28; // default open
  if (face.mesh && face.mesh.length >= 468) {
    // MediaPipe right-eye indices: 33,160,158,133,153,144
    const rightEye = [33, 160, 158, 133, 153, 144].map(i => face.mesh[i]);
    // MediaPipe left-eye indices:  263,387,385,362,380,373
    const leftEye  = [263, 387, 385, 362, 380, 373].map(i => face.mesh[i]);
    const earR = computeEAR(rightEye);
    const earL = computeEAR(leftEye);
    ear = (earR + earL) / 2;
  }

  // HGR — compute from iris landmarks
  let hgr = 0.5;
  if (face.mesh && face.mesh.length >= 478) {
    // Right iris centre: 473, right eye corners: 33, 133
    const irisR = face.mesh[473];
    const rightInner = face.mesh[133];
    const rightOuter = face.mesh[33];
    hgr = computeGazeRatio({ irisCenter: irisR, eyeInnerCorner: rightInner, eyeOuterCorner: rightOuter });
  }

  return { faceCount, yaw, pitch, roll, hgr, ear };
}

// ─── Simulated Detection Pipeline ───────────────────────────────────────────

/**
 * Generate realistic-looking detection data WITHOUT real models.
 *
 * The simulation uses deterministic noise seeded by the frame counter so that
 * results are reproducible for testing.  It also inspects basic image
 * statistics (average brightness) to roughly gauge whether a face is present.
 */
function detectSimulated(imageData, timestamp) {
  _frameCount++;

  // ── Simple image analysis (brightness) ─────────────────────────────────
  let avgBrightness = 128;
  if (imageData && imageData.data && imageData.data.length >= 4) {
    let sum = 0;
    const data = imageData.data;
    // Sample every 40th pixel for speed
    const step = Math.max(4, Math.floor(data.length / 1000)) & ~3; // align to 4
    let count = 0;
    for (let i = 0; i < data.length; i += step) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      count++;
    }
    avgBrightness = count > 0 ? sum / count : 128;
  }

  // ── Determine simulated face count ─────────────────────────────────────
  // Very dark frames → no face.  Otherwise probabilistic.
  let faceCount = 1;
  const rand = pseudoRandom(_frameCount);

  if (avgBrightness < 20) {
    faceCount = 0; // camera covered or very dark
  } else if (rand < (1 - _config.simulateFaceProb)) {
    faceCount = 0;
  } else if (rand > (1 - _config.simulateMultiProb)) {
    faceCount = 2;
  }

  if (faceCount === 0) {
    return { faceCount: 0, yaw: 0, pitch: 0, roll: 0, hgr: 0.5, ear: 0 };
  }

  // ── Simulated head pose (smooth Perlin-ish wander) ─────────────────────
  const t = timestamp / 1000; // seconds
  const yaw   = smoothNoise(t, 0.3, 5)  + smoothNoise(t, 0.07, 15);
  const pitch = smoothNoise(t, 0.25, 4) + smoothNoise(t, 0.06, 10);
  const roll  = smoothNoise(t, 0.2, 2);

  // ── Simulated gaze ────────────────────────────────────────────────────
  const hgr = 0.5 + smoothNoise(t, 0.4, 0.08);
  const ear = 0.28 + smoothNoise(t, 0.5, 0.03);

  return {
    faceCount,
    yaw:   Math.round(yaw   * 100) / 100,
    pitch: Math.round(pitch * 100) / 100,
    roll:  Math.round(roll  * 100) / 100,
    hgr:   Math.round(Math.max(0, Math.min(1, hgr)) * 1000) / 1000,
    ear:   Math.round(Math.max(0, Math.min(0.5, ear)) * 1000) / 1000,
  };
}

/** Simple deterministic PRNG (mulberry32). */
function pseudoRandom(seed) {
  let t = (seed + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smooth sinusoidal noise for natural-looking wandering values. */
function smoothNoise(t, freq, amplitude) {
  return amplitude * Math.sin(2 * Math.PI * freq * t + freq * 100);
}

// ─── Frame Processing ───────────────────────────────────────────────────────

/**
 * Process a single video frame.
 */
async function processFrame(imageData, timestamp) {
  if (!_initialised) {
    self.postMessage({ type: 'ERROR', error: 'Worker not initialised. Send INIT first.' });
    return;
  }

  try {
    // Run detection (real or simulated)
    const det = _useSimulation
      ? detectSimulated(imageData, timestamp)
      : await detectReal(imageData);

    // Classify instantaneous violation
    const instantViolation = classifyViolation(det, _config);

    // Run through hysteresis to debounce
    const violation = _hsm.update(instantViolation, det.ear, timestamp);

    // Post result back to main thread
    self.postMessage({
      type: 'DETECTION_RESULT',
      faceCount: det.faceCount,
      euler: {
        yaw:   det.yaw,
        pitch: det.pitch,
        roll:  det.roll,
      },
      gaze: {
        hgr: det.hgr,
        ear: det.ear,
      },
      violation,          // null or sustained violation type
      instantViolation,   // raw per-frame classification (useful for UI)
      ts: timestamp,
    });
  } catch (err) {
    self.postMessage({
      type: 'ERROR',
      error: `Frame processing failed: ${err.message || err}`,
      ts: timestamp,
    });
  }
}

// ─── Message Handler ────────────────────────────────────────────────────────

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'INIT':
      try {
        await init(msg.config || {});
      } catch (err) {
        self.postMessage({ type: 'ERROR', error: `Init failed: ${err.message || err}` });
      }
      break;

    case 'PROCESS_FRAME':
      await processFrame(msg.imageData, msg.timestamp ?? Date.now());
      break;

    default:
      self.postMessage({ type: 'ERROR', error: `Unknown message type: ${msg.type}` });
  }
});

// Signal that the worker script has loaded successfully
self.postMessage({ type: 'WORKER_READY' });
