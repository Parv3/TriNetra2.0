/**
 * heuristics.js — Pure-JS vision heuristics for Smart Proctoring
 *
 * Exports:
 *   computeEAR(eyeLandmarks)        – Eye Aspect Ratio (blink detection)
 *   computeHeadPose(landmarks)      – { yaw, pitch, roll } from 2-D facial landmarks
 *   computeGazeRatio(irisLandmarks) – Horizontal Gaze Ratio (HGR)
 *   classifyViolation(det, config)  – returns violation type string or null
 *   HysteresisStateMachine          – temporal debounce / state tracker
 */

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Euclidean distance between two 2-D (or 3-D) points.
 * Points are { x, y } or { x, y, z }.
 */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Clamp a value between lo and hi. */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Convert radians → degrees. */
function rad2deg(r) {
  return (r * 180) / Math.PI;
}

// ─── EAR ────────────────────────────────────────────────────────────────────

/**
 * Compute the Eye Aspect Ratio for a single eye.
 *
 * Soukupová & Čech (2016):
 *   EAR = (‖p2−p6‖ + ‖p3−p5‖) / (2 · ‖p1−p4‖)
 *
 * @param {Array<{x:number, y:number}>} eyeLandmarks
 *   Six landmark points [p1 … p6] ordered as:
 *     p1 = lateral corner, p4 = medial corner,
 *     p2,p3 = upper lid, p5,p6 = lower lid.
 *   Accepts MediaPipe-style arrays of 6 points (same order) or any
 *   array of at least 6 {x, y} objects.
 * @returns {number} EAR value.  Typically ~0.25 open, <0.20 closed.
 */
function computeEAR(eyeLandmarks) {
  if (!eyeLandmarks || eyeLandmarks.length < 6) {
    return 0;
  }
  const [p1, p2, p3, p4, p5, p6] = eyeLandmarks;

  const vertical1 = dist(p2, p6);
  const vertical2 = dist(p3, p5);
  const horizontal = dist(p1, p4);

  if (horizontal === 0) return 0;

  return (vertical1 + vertical2) / (2.0 * horizontal);
}

// ─── Head Pose ──────────────────────────────────────────────────────────────

/**
 * Estimate head pose (yaw, pitch, roll) from 2-D facial landmarks using a
 * simplified geometric approach.
 *
 * Expected landmark indices (MediaPipe Face Mesh convention):
 *   landmarks[1]   – nose tip
 *   landmarks[33]  – right eye outer corner
 *   landmarks[263] – left eye outer corner
 *   landmarks[61]  – right mouth corner
 *   landmarks[291] – left mouth corner
 *   landmarks[10]  – forehead / top of face
 *   landmarks[152] – chin / bottom of face
 *   landmarks[234] – right face edge
 *   landmarks[454] – left face edge
 *
 * If the array is short (e.g. only a basic 68-pt model) we fall back to a
 * subset that still gives usable estimates.
 *
 * @param {Array<{x:number, y:number, z?:number}>} landmarks
 * @returns {{ yaw: number, pitch: number, roll: number }}  Angles in degrees.
 */
function computeHeadPose(landmarks) {
  if (!landmarks || landmarks.length < 6) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  // --- Resolve key points -------------------------------------------------
  let noseTip, rightEye, leftEye, rightMouth, leftMouth, forehead, chin;

  if (landmarks.length >= 468) {
    // MediaPipe Face Mesh (468 / 478 landmarks)
    noseTip    = landmarks[1];
    rightEye   = landmarks[33];
    leftEye    = landmarks[263];
    rightMouth = landmarks[61];
    leftMouth  = landmarks[291];
    forehead   = landmarks[10];
    chin       = landmarks[152];
  } else if (landmarks.length >= 68) {
    // dlib / 68-point model
    noseTip    = landmarks[30];
    rightEye   = landmarks[36];
    leftEye    = landmarks[45];
    rightMouth = landmarks[48];
    leftMouth  = landmarks[54];
    forehead   = landmarks[27]; // bridge of nose (approx)
    chin       = landmarks[8];
  } else {
    // Minimal: assume [leftEye, rightEye, nose, leftMouth, rightMouth, chin]
    leftEye    = landmarks[0];
    rightEye   = landmarks[1];
    noseTip    = landmarks[2];
    leftMouth  = landmarks[3];
    rightMouth = landmarks[4];
    chin       = landmarks[5];
    forehead   = {
      x: (leftEye.x + rightEye.x) / 2,
      y: Math.min(leftEye.y, rightEye.y) - dist(leftEye, rightEye) * 0.6,
    };
  }

  // --- Yaw  (horizontal rotation) ----------------------------------------
  // Compare nose-tip's horizontal offset from the eye midpoint vs inter-eye
  // distance.  Positive yaw = face turned to the subject's right (screen left).
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const interEyeDist = dist(leftEye, rightEye);
  if (interEyeDist === 0) return { yaw: 0, pitch: 0, roll: 0 };

  const noseOffsetX = noseTip.x - eyeMidX;
  // Normalise by inter-eye distance; ±1 corresponds to roughly ±90°
  const yawNorm = clamp(noseOffsetX / (interEyeDist * 0.5), -1, 1);
  const yaw = rad2deg(Math.asin(yawNorm));

  // --- Pitch (vertical rotation) -----------------------------------------
  // Use nose-tip position relative to eye-centre → chin line.
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const faceLenY = Math.abs(chin.y - eyeMidY) || 1;
  const noseOffsetY = noseTip.y - eyeMidY;
  const pitchNorm = clamp((noseOffsetY / faceLenY - 0.5) * 2, -1, 1);
  const pitch = rad2deg(Math.asin(pitchNorm));

  // --- Roll (in-plane tilt) ----------------------------------------------
  const dx = leftEye.x - rightEye.x;
  const dy = leftEye.y - rightEye.y;
  const roll = rad2deg(Math.atan2(dy, dx));

  return {
    yaw:   Math.round(yaw   * 100) / 100,
    pitch: Math.round(pitch * 100) / 100,
    roll:  Math.round(roll  * 100) / 100,
  };
}

// ─── Gaze Ratio ─────────────────────────────────────────────────────────────

/**
 * Compute the Horizontal Gaze Ratio (HGR).
 *
 * HGR ≈ 0.5 means looking straight ahead.
 * HGR < 0.35  → looking to the right
 * HGR > 0.65  → looking to the left
 *
 * @param {Object} irisLandmarks
 *   {
 *     irisCenter: { x, y },       // centre of the iris
 *     eyeInnerCorner: { x, y },   // medial canthus
 *     eyeOuterCorner: { x, y },   // lateral canthus
 *   }
 *   OR an array: [ irisCenter, eyeInnerCorner, eyeOuterCorner ]
 * @returns {number} HGR in [0, 1].
 */
function computeGazeRatio(irisLandmarks) {
  if (!irisLandmarks) return 0.5;

  let irisCenter, innerCorner, outerCorner;

  if (Array.isArray(irisLandmarks)) {
    if (irisLandmarks.length < 3) return 0.5;
    [irisCenter, innerCorner, outerCorner] = irisLandmarks;
  } else {
    irisCenter   = irisLandmarks.irisCenter;
    innerCorner  = irisLandmarks.eyeInnerCorner;
    outerCorner  = irisLandmarks.eyeOuterCorner;
  }

  if (!irisCenter || !innerCorner || !outerCorner) return 0.5;

  const eyeWidth = dist(innerCorner, outerCorner);
  if (eyeWidth === 0) return 0.5;

  const irisOffset = dist(outerCorner, irisCenter);
  return clamp(irisOffset / eyeWidth, 0, 1);
}

// ─── Violation Classifier ───────────────────────────────────────────────────

/**
 * Default thresholds — merged with caller-supplied config.
 */
const DEFAULT_CONFIG = {
  yawThreshold:        25,     // degrees
  pitchUpperThreshold: 25,     // degrees (looking down)
  pitchLowerThreshold: -20,    // degrees (looking up)
  hgrLower:            0.35,
  hgrUpper:            0.65,
  earBlinkThreshold:   0.21,   // EAR below this → eyes closed
};

/**
 * Classify a single-frame detection result into a violation type.
 *
 * @param {Object} detectionResult
 *   {
 *     faceCount: number,
 *     ear: number,            // Eye Aspect Ratio (average of both eyes)
 *     yaw: number,
 *     pitch: number,
 *     roll: number,
 *     hgr: number,            // Horizontal Gaze Ratio
 *   }
 * @param {Object} [config]     Optional overrides for thresholds.
 * @returns {string|null}  One of:
 *   'NO_FACE' | 'MULTIPLE_FACES' | 'GAZE_DIVERSION' | 'EYES_CLOSED' | null
 */
function classifyViolation(detectionResult, config) {
  if (!detectionResult) return null;

  const cfg = { ...DEFAULT_CONFIG, ...config };

  const { faceCount, yaw, pitch, hgr, ear } = detectionResult;

  // Priority 1 — no face at all
  if (faceCount === 0) return 'NO_FACE';

  // Priority 2 — multiple faces
  if (faceCount > 1) return 'MULTIPLE_FACES';

  // Priority 3 — gaze / head diversion
  if (
    Math.abs(yaw) > cfg.yawThreshold ||
    pitch > cfg.pitchUpperThreshold ||
    pitch < cfg.pitchLowerThreshold
  ) {
    return 'GAZE_DIVERSION';
  }

  // Horizontal gaze ratio check
  if (hgr !== undefined && hgr !== null) {
    if (hgr < cfg.hgrLower || hgr > cfg.hgrUpper) {
      return 'GAZE_DIVERSION';
    }
  }

  // Priority 4 — prolonged eye closure (not a blink — handled by hysteresis)
  if (ear !== undefined && ear < cfg.earBlinkThreshold) {
    return 'EYES_CLOSED';
  }

  return null;
}

// ─── Hysteresis State Machine ───────────────────────────────────────────────

/**
 * Temporal debouncing state machine.
 *
 * Prevents spurious alerts by requiring a violation to persist for a
 * configurable duration before it is emitted.  Also filters natural blinks
 * (EAR drop lasting < 400 ms).
 *
 * Usage:
 *   const hsm = new HysteresisStateMachine(config);
 *   const violation = hsm.update(classifiedViolation, ear, timestampMs);
 *   // violation is null until the threshold is exceeded.
 */
class HysteresisStateMachine {
  /**
   * @param {Object} [config]
   * @param {number} [config.noFaceTimeout=3000]          ms
   * @param {number} [config.multipleFacesTimeout=1200]   ms
   * @param {number} [config.gazeDiversionTimeout=2000]   ms
   * @param {number} [config.eyesClosedTimeout=2500]      ms
   * @param {number} [config.blinkMaxDuration=400]        ms — EAR drops shorter
   *                                                        than this are ignored.
   * @param {number} [config.earBlinkThreshold=0.21]
   */
  constructor(config = {}) {
    this.noFaceTimeout        = config.noFaceTimeout        ?? 3000;
    this.multipleFacesTimeout = config.multipleFacesTimeout  ?? 1200;
    this.gazeDiversionTimeout = config.gazeDiversionTimeout  ?? 2000;
    this.eyesClosedTimeout    = config.eyesClosedTimeout     ?? 2500;
    this.blinkMaxDuration     = config.blinkMaxDuration      ?? 400;
    this.earBlinkThreshold    = config.earBlinkThreshold     ?? 0.21;

    /** @type {string|null} Current candidate violation type. */
    this._currentState = null;

    /** @type {number|null} Timestamp (ms) when the current state began. */
    this._stateStartTs = null;

    /** @type {string|null} Last violation that was actually emitted. */
    this._lastEmitted = null;

    // Blink tracking
    /** @type {number|null} Timestamp when EAR first dropped below threshold. */
    this._blinkStartTs = null;
    /** @type {boolean} Whether we're currently in a low-EAR segment. */
    this._inBlink = false;
  }

  /**
   * Feed the next frame's classification into the state machine.
   *
   * @param {string|null} violation  Output of classifyViolation().
   * @param {number}      ear        Current EAR value (for blink filtering).
   * @param {number}      timestamp  Frame timestamp in milliseconds.
   * @returns {string|null} Emitted violation type, or null.
   */
  update(violation, ear, timestamp) {
    // ── Blink filter ─────────────────────────────────────────────────────
    if (ear !== undefined && ear !== null) {
      if (ear < this.earBlinkThreshold) {
        if (!this._inBlink) {
          this._inBlink = true;
          this._blinkStartTs = timestamp;
        }
        const blinkDuration = timestamp - this._blinkStartTs;
        if (blinkDuration < this.blinkMaxDuration) {
          // Short EAR drop → natural blink — suppress EYES_CLOSED
          if (violation === 'EYES_CLOSED') {
            violation = null;
          }
        }
      } else {
        // EAR recovered
        this._inBlink = false;
        this._blinkStartTs = null;
      }
    }

    // ── State transition logic ───────────────────────────────────────────
    if (violation !== this._currentState) {
      // State changed — start a new timing window
      this._currentState = violation;
      this._stateStartTs = timestamp;
      // If we left a violation state, clear emission so it can re-fire later
      if (violation === null) {
        this._lastEmitted = null;
      }
      return null;
    }

    // Same state persists — check if threshold exceeded
    if (violation === null) {
      this._lastEmitted = null;
      return null;
    }

    const elapsed = timestamp - this._stateStartTs;
    const threshold = this._getTimeout(violation);

    if (elapsed >= threshold) {
      // Only emit once per sustained window
      if (this._lastEmitted !== violation) {
        this._lastEmitted = violation;
        return violation;
      }
    }

    return null;
  }

  /**
   * Look up the required persistence duration for a given violation type.
   * @private
   */
  _getTimeout(violation) {
    switch (violation) {
      case 'NO_FACE':         return this.noFaceTimeout;
      case 'MULTIPLE_FACES':  return this.multipleFacesTimeout;
      case 'GAZE_DIVERSION':  return this.gazeDiversionTimeout;
      case 'EYES_CLOSED':     return this.eyesClosedTimeout;
      default:                return Infinity; // unknown — never emit
    }
  }

  /**
   * Reset all internal state (e.g. between exam sections).
   */
  reset() {
    this._currentState = null;
    this._stateStartTs = null;
    this._lastEmitted  = null;
    this._blinkStartTs = null;
    this._inBlink      = false;
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

// Support both CommonJS (`require()`) and ES-module-like environments
// (e.g. bundlers, or `importScripts` inside a Web Worker via a shim).
const _exports = {
  computeEAR,
  computeHeadPose,
  computeGazeRatio,
  classifyViolation,
  HysteresisStateMachine,
  DEFAULT_CONFIG,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
}
if (typeof self !== 'undefined') {
  // Make available on the global scope inside a Web Worker
  self.heuristics = _exports;
}
