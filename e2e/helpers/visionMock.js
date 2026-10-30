/**
 * AI Vision Pipeline Simulation & Heuristics Evaluator for E2E Testing
 *
 * Simulates:
 * 1. Face Presence & Multi-face Detection with temporal thresholds:
 *    - Absence: 0 faces for > 3.0s -> FACE_ABSENT
 *    - Multiple faces: >1 faces for > 1.2s -> MULTIPLE_FACES
 * 2. 3D Head Pose Euler angles:
 *    - Yaw: ±25° threshold
 *    - Pitch: -20° to +25° threshold
 *    - Roll: ±25° threshold
 * 3. Iris Gaze Diversion & EAR Blink Filter:
 *    - Horizontal Gaze Ratio (HGR): normal [0.35, 0.65]
 *    - Eye Aspect Ratio (EAR): <0.20 for <400ms is a natural blink (filtered)
 *    - Prolonged eye closure: EAR <0.20 for >2000ms is a violation
 * 4. Temporal Hysteresis State Machine
 */

class VisionHeuristicsMock {
  constructor(options = {}) {
    this.absenceThresholdMs = options.absenceThresholdMs || 3000;
    this.multiFaceThresholdMs = options.multiFaceThresholdMs || 1200;
    this.yawLimitDeg = options.yawLimitDeg || 25;
    this.pitchMinDeg = options.pitchMinDeg || -20;
    this.pitchMaxDeg = options.pitchMaxDeg || 25;
    this.rollLimitDeg = options.rollLimitDeg || 25;
    this.hgrMin = options.hgrMin || 0.35;
    this.hgrMax = options.hgrMax || 0.65;
    this.blinkMaxDurationMs = options.blinkMaxDurationMs || 400;
    this.eyeClosureViolationMs = options.eyeClosureViolationMs || 2000;

    // Temporal tracking states
    this.absenceStartTime = null;
    this.multiFaceStartTime = null;
    this.eyeClosureStartTime = null;
    this.gazeDiversionStartTime = null;
    this.headPoseStartTime = null;
  }

  reset() {
    this.absenceStartTime = null;
    this.multiFaceStartTime = null;
    this.eyeClosureStartTime = null;
    this.gazeDiversionStartTime = null;
    this.headPoseStartTime = null;
  }

  // Evaluate frame detection result
  evaluateFrame(frame) {
    const timestamp = frame.timestamp || Date.now();
    const faceCount = frame.faceCount !== undefined ? frame.faceCount : 1;
    const violations = [];

    // 1. Face Absence Evaluation
    if (faceCount === 0) {
      if (!this.absenceStartTime) {
        this.absenceStartTime = timestamp;
      } else {
        const duration = timestamp - this.absenceStartTime;
        if (duration >= this.absenceThresholdMs) {
          violations.push({
            type: 'FACE_ABSENT',
            durationMs: duration,
            message: `Candidate absent from webcam frame for ${(duration / 1000).toFixed(1)}s`
          });
        }
      }
    } else {
      this.absenceStartTime = null;
    }

    // 2. Multi-Face Evaluation
    if (faceCount > 1) {
      if (!this.multiFaceStartTime) {
        this.multiFaceStartTime = timestamp;
      } else {
        const duration = timestamp - this.multiFaceStartTime;
        if (duration >= this.multiFaceThresholdMs) {
          violations.push({
            type: 'MULTIPLE_FACES',
            faceCount,
            durationMs: duration,
            message: `Multiple faces detected in webcam frame (${faceCount} faces)`
          });
        }
      }
    } else {
      this.multiFaceStartTime = null;
    }

    // If no face present, head pose and gaze are skipped
    if (faceCount === 0) {
      return {
        timestamp,
        faceCount,
        hasViolation: violations.length > 0,
        violations
      };
    }

    // 3. Head Pose Evaluation (Euler Yaw / Pitch / Roll)
    if (frame.euler) {
      const { yaw = 0, pitch = 0, roll = 0 } = frame.euler;

      // Handle NaN / Infinity boundary cases safely
      if (isNaN(yaw) || isNaN(pitch) || isNaN(roll) || !isFinite(yaw) || !isFinite(pitch) || !isFinite(roll)) {
        // Corrupted landmark data, ignore safely without crashing
      } else {
        const yawExceeded = Math.abs(yaw) > this.yawLimitDeg;
        const pitchExceeded = pitch < this.pitchMinDeg || pitch > this.pitchMaxDeg;
        const rollExceeded = Math.abs(roll) > this.rollLimitDeg;

        if (yawExceeded || pitchExceeded || rollExceeded) {
          if (!this.headPoseStartTime) {
            this.headPoseStartTime = timestamp;
          }
          const duration = timestamp - this.headPoseStartTime;
          if (duration >= 1000) { // 1 second persistence
            violations.push({
              type: 'HEAD_POSE_DIVERTED',
              euler: { yaw, pitch, roll },
              durationMs: duration,
              message: `Head pose diverted outside allowed angles (yaw: ${yaw.toFixed(1)}°, pitch: ${pitch.toFixed(1)}°)`
            });
          }
        } else {
          this.headPoseStartTime = null;
        }
      }
    }

    // 4. Iris Gaze & EAR Blink Evaluation
    if (frame.gaze) {
      const { hgr = 0.5, ear = 0.3 } = frame.gaze;

      // Check Eye Closure / Blink via EAR
      if (ear < 0.20) {
        if (!this.eyeClosureStartTime) {
          this.eyeClosureStartTime = timestamp;
        } else {
          const closureDuration = timestamp - this.eyeClosureStartTime;
          // Natural blink (<400ms) is filtered out
          if (closureDuration > this.eyeClosureViolationMs) {
            violations.push({
              type: 'PROLONGED_EYES_CLOSED',
              ear,
              durationMs: closureDuration,
              message: `Eyes closed or obscured for ${(closureDuration / 1000).toFixed(1)}s`
            });
          }
        }
      } else {
        this.eyeClosureStartTime = null;

        // Check Horizontal Gaze Ratio (HGR) diversion
        const gazeDiverted = hgr < this.hgrMin || hgr > this.hgrMax;
        if (gazeDiverted) {
          if (!this.gazeDiversionStartTime) {
            this.gazeDiversionStartTime = timestamp;
          }
          const duration = timestamp - this.gazeDiversionStartTime;
          if (duration >= 1500) { // 1.5s persistence
            violations.push({
              type: 'EYE_GAZE_DIVERTED',
              hgr,
              durationMs: duration,
              message: `Eye gaze diverted off-screen (HGR: ${hgr.toFixed(2)})`
            });
          }
        } else {
          this.gazeDiversionStartTime = null;
        }
      }
    }

    return {
      timestamp,
      faceCount,
      hasViolation: violations.length > 0,
      violations
    };
  }

  // Static validator for instantaneous angles
  static validateEulerAngles(yaw, pitch, roll, thresholds = { yaw: 25, pitchMin: -20, pitchMax: 25, roll: 25 }) {
    if (isNaN(yaw) || isNaN(pitch) || isNaN(roll)) return { valid: false, error: 'NaN angles' };
    const isYawOk = Math.abs(yaw) <= thresholds.yaw;
    const isPitchOk = pitch >= thresholds.pitchMin && pitch <= thresholds.pitchMax;
    const isRollOk = Math.abs(roll) <= thresholds.roll;
    return {
      valid: isYawOk && isPitchOk && isRollOk,
      details: { isYawOk, isPitchOk, isRollOk }
    };
  }

  // Static validator for instantaneous gaze
  static validateGaze(hgr, ear, thresholds = { hgrMin: 0.35, hgrMax: 0.65, earBlink: 0.20 }) {
    const isBlink = ear < thresholds.earBlink;
    const isGazeCentered = hgr >= thresholds.hgrMin && hgr <= thresholds.hgrMax;
    return {
      isBlink,
      isGazeCentered,
      normal: !isBlink && isGazeCentered
    };
  }
}

module.exports = { VisionHeuristicsMock };
