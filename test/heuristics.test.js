/**
 * Unit Test Suite for AI Proctoring Vision Heuristics
 * Verifies EAR, Head Pose Euler angles, Iris Horizontal Gaze Ratio, and Hysteresis State Machine
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeEAR,
  computeHeadPose,
  computeGazeRatio,
  classifyViolation,
  HysteresisStateMachine
} = require('../src/worker/heuristics');

describe('AI Vision Proctoring Heuristics Suite', () => {

  describe('Eye Aspect Ratio (EAR) & Blink Calculation', () => {
    it('computes open eye EAR correctly (~0.25 - 0.35)', () => {
      // Standard open eye landmark coordinates [p1, p2, p3, p4, p5, p6]
      const openEye = [
        { x: 30, y: 50 }, // p1 outer corner
        { x: 40, y: 45 }, // p2 upper
        { x: 50, y: 45 }, // p3 upper
        { x: 60, y: 50 }, // p4 inner corner
        { x: 50, y: 55 }, // p5 lower
        { x: 40, y: 55 }  // p6 lower
      ];
      const ear = computeEAR(openEye);
      assert.ok(ear > 0.20, `Expected open eye EAR > 0.20, got ${ear}`);
      assert.ok(ear < 0.60, `Expected open eye EAR < 0.60, got ${ear}`);
    });

    it('computes closed eye EAR correctly (<0.18)', () => {
      const closedEye = [
        { x: 30, y: 50 },
        { x: 40, y: 49.5 },
        { x: 50, y: 49.5 },
        { x: 60, y: 50 },
        { x: 50, y: 50.5 },
        { x: 40, y: 50.5 }
      ];
      const ear = computeEAR(closedEye);
      assert.ok(ear < 0.18, `Expected closed eye EAR < 0.18, got ${ear}`);
    });

    it('returns 0 for invalid or insufficient landmarks', () => {
      assert.equal(computeEAR(null), 0);
      assert.equal(computeEAR([]), 0);
      assert.equal(computeEAR([{ x: 0, y: 0 }]), 0);
    });
  });

  describe('3D Head Pose Euler Estimation', () => {
    it('computes near-zero yaw, pitch, roll for centered frontal face', () => {
      // Minimal 6-point landmarks: [leftEye, rightEye, noseTip, leftMouth, rightMouth, chin]
      // Subject's left eye is on screen right (x=60), right eye on screen left (x=40)
      const frontal = [
        { x: 60, y: 40 }, // leftEye (screen right)
        { x: 40, y: 40 }, // rightEye (screen left)
        { x: 50, y: 50 }, // noseTip (midpoint)
        { x: 55, y: 65 }, // leftMouth
        { x: 45, y: 65 }, // rightMouth
        { x: 50, y: 75 }  // chin
      ];
      const euler = computeHeadPose(frontal);
      assert.ok(Math.abs(euler.yaw) < 10, `Expected yaw near 0, got ${euler.yaw}`);
      assert.ok(Math.abs(euler.roll) < 5, `Expected roll near 0, got ${euler.roll}`);
    });

    it('detects head turn (yaw)', () => {
      const turned = [
        { x: 60, y: 40 },
        { x: 40, y: 40 },
        { x: 58, y: 50 }, // nose turned away from midpoint (50)
        { x: 55, y: 65 },
        { x: 45, y: 65 },
        { x: 50, y: 75 }
      ];
      const euler = computeHeadPose(turned);
      assert.ok(Math.abs(euler.yaw) > 15, `Expected significant yaw, got ${euler.yaw}`);
    });
  });

  describe('Iris Horizontal Gaze Ratio (HGR)', () => {
    it('computes centered gaze (~0.50)', () => {
      const centered = {
        irisCenter: { x: 50, y: 50 },
        eyeInnerCorner: { x: 40, y: 50 },
        eyeOuterCorner: { x: 60, y: 50 }
      };
      const hgr = computeGazeRatio(centered);
      assert.ok(Math.abs(hgr - 0.50) < 0.05, `Expected HGR ~0.50, got ${hgr}`);
    });

    it('computes averted gaze towards outer corner (HGR < 0.35)', () => {
      const avertedOuter = {
        irisCenter: { x: 56, y: 50 },
        eyeInnerCorner: { x: 40, y: 50 },
        eyeOuterCorner: { x: 60, y: 50 }
      };
      const hgr = computeGazeRatio(avertedOuter);
      assert.ok(hgr < 0.35, `Expected HGR < 0.35, got ${hgr}`);
    });

    it('computes averted gaze towards inner corner (HGR > 0.65)', () => {
      const avertedInner = {
        irisCenter: { x: 44, y: 50 },
        eyeInnerCorner: { x: 40, y: 50 },
        eyeOuterCorner: { x: 60, y: 50 }
      };
      const hgr = computeGazeRatio(avertedInner);
      assert.ok(hgr > 0.65, `Expected HGR > 0.65, got ${hgr}`);
    });
  });

  describe('Violation Classifier', () => {
    it('classifies NO_FACE when faceCount is 0', () => {
      const violation = classifyViolation({ faceCount: 0 });
      assert.equal(violation, 'NO_FACE');
    });

    it('classifies MULTIPLE_FACES when faceCount > 1', () => {
      const violation = classifyViolation({ faceCount: 2 });
      assert.equal(violation, 'MULTIPLE_FACES');
    });

    it('classifies GAZE_DIVERSION when yaw exceeds threshold', () => {
      const violation = classifyViolation({
        faceCount: 1,
        yaw: 35,
        pitch: 0,
        roll: 0,
        hgr: 0.5,
        ear: 0.28
      });
      assert.equal(violation, 'GAZE_DIVERSION');
    });

    it('returns null for normal frontal gaze and single face', () => {
      const violation = classifyViolation({
        faceCount: 1,
        yaw: 5,
        pitch: 2,
        roll: 0,
        hgr: 0.5,
        ear: 0.28
      });
      assert.equal(violation, null);
    });
  });

  describe('Hysteresis State Machine (Temporal Debounce)', () => {
    it('debounces brief blinks without triggering false positive (<400ms)', () => {
      const hsm = new HysteresisStateMachine({ blinkMaxDuration: 400 });
      const t0 = 1000;

      // Closed eye at t=1000 with low EAR
      let res = hsm.update('EYES_CLOSED', 0.15, t0);
      assert.equal(res, null, 'Immediate blink must not trigger violation');

      // Reopened at t=1200 (200ms duration) with normal EAR
      res = hsm.update(null, 0.28, t0 + 200);
      assert.equal(res, null, 'Quick blink reset must produce no violation');
    });

    it('triggers NO_FACE only after sustained duration > 3000ms', () => {
      const hsm = new HysteresisStateMachine({ noFaceTimeout: 3000 });
      const t0 = 10000;

      // At t = 10000 (0ms)
      assert.equal(hsm.update('NO_FACE', 0.28, t0), null);

      // At t = 12000 (2000ms elapsed < 3000ms)
      assert.equal(hsm.update('NO_FACE', 0.28, t0 + 2000), null);

      // At t = 13500 (3500ms elapsed > 3000ms) -> triggers violation!
      const violation = hsm.update('NO_FACE', 0.28, t0 + 3500);
      assert.equal(violation, 'NO_FACE');

      // Subsequent frame while still no face should not spam new violation
      const duplicate = hsm.update('NO_FACE', 0.28, t0 + 3600);
      assert.equal(duplicate, null, 'Must not duplicate alert within same continuous window');
    });

    it('triggers MULTIPLE_FACES after sustained duration > 1200ms', () => {
      const hsm = new HysteresisStateMachine({ multipleFacesTimeout: 1200 });
      const t0 = 20000;

      assert.equal(hsm.update('MULTIPLE_FACES', 0.28, t0), null);
      assert.equal(hsm.update('MULTIPLE_FACES', 0.28, t0 + 800), null);

      const violation = hsm.update('MULTIPLE_FACES', 0.28, t0 + 1300);
      assert.equal(violation, 'MULTIPLE_FACES');
    });

    it('resets violation state once normal behavior resumes', () => {
      const hsm = new HysteresisStateMachine({ noFaceTimeout: 1000 });
      const t0 = 30000;

      hsm.update('NO_FACE', 0.28, t0);
      hsm.update('NO_FACE', 0.28, t0 + 1500); // triggered

      // Face returns
      hsm.update(null, 0.28, t0 + 2000);
      assert.equal(hsm._currentState, null);
    });
  });

});
