/**
 * Tier 1: Feature Coverage Test Suite (Opaque-Box E2E)
 *
 * Verifies core functionality and happy paths across all 12 feature areas
 * defined in TEST_INFRA.md and PROJECT.md:
 * - Feature 1: Desktop Application Launch & Multi-tab Navigation
 * - Feature 2: Student Authentication (OTP & Face Baseline)
 * - Feature 3: MCQ Assessment Delivery & Response Submission
 * - Feature 4: Server-Authoritative Timer & Timeout Submission
 * - Feature 5: AI Proctoring: Face Absence & Multi-Face Detection
 * - Feature 6: AI Proctoring: Gaze Diversion & Head Pose
 * - Feature 7: Warning Display & Violation Accumulation
 * - Feature 8: Disqualification upon Strike Threshold
 * - Feature 9: In-Browser Tab Switches & URL Tracking
 * - Feature 10: AI Service (ChatGPT/Claude) Query Interception
 * - Feature 11: Keystroke & Mouse Activity Logging
 * - Feature 12: Auditor Review View & Session Reporting
 *
 * Total: 60 test cases (5 tests per feature).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E2EHarness } = require('./harness');
const { BrowserMock } = require('./helpers/browserMock');
const { VisionHeuristicsMock } = require('./helpers/visionMock');

describe('Tier 1: Feature Coverage Suite (60 Tests)', () => {
  let harness;

  before(async () => {
    harness = new E2EHarness({ maxStrikes: 3 });
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.resetStore();
  });

  // =========================================================================
  // Feature 1: Desktop Application Launch & Multi-tab Navigation
  // =========================================================================
  describe('Feature 1: Desktop Application Launch & Multi-tab Navigation', () => {
    it('F1.1: Preload bridge exposes required proctorAPI methods and version', async () => {
      const api = harness.browser.proctorAPI;
      assert.ok(typeof api.getBackendPort === 'function', 'getBackendPort should be a function');
      assert.ok(typeof api.getAppVersion === 'function', 'getAppVersion should be a function');
      assert.ok(typeof api.createTab === 'function', 'createTab should be a function');
      assert.ok(typeof api.switchTab === 'function', 'switchTab should be a function');
      assert.ok(typeof api.closeTab === 'function', 'closeTab should be a function');
      assert.ok(typeof api.navigateTab === 'function', 'navigateTab should be a function');

      const version = await api.getAppVersion();
      assert.ok(typeof version === 'string' && version.length > 0, 'Version string must be populated');
      const port = await api.getBackendPort();
      assert.ok(typeof port === 'number' && port > 0, 'Port must be a valid positive number');
    });

    it('F1.2: Tab manager initializes with pinned assessment tab that cannot be closed', async () => {
      const tabs = harness.browser.tabs;
      assert.ok(tabs.has(harness.browser.assessmentTabId), 'Assessment tab must exist initially');
      const pinnedTab = tabs.get(harness.browser.assessmentTabId);
      assert.strictEqual(pinnedTab.isPinned, true, 'Assessment tab must be pinned');
      assert.strictEqual(pinnedTab.canClose, false, 'Assessment tab must not be closable');

      // Attempting to close pinned tab must throw error
      assert.throws(() => {
        harness.browser.closeTab(harness.browser.assessmentTabId);
      }, /Pinned assessment tab cannot be closed/);
    });

    it('F1.3: User can create a new guest browser tab with specified URL', async () => {
      const initialTabCount = harness.browser.tabs.size;
      const tabId = harness.browser.createTab('https://www.wikipedia.org');
      assert.ok(typeof tabId === 'string', 'Returned tabId must be a string');
      assert.strictEqual(harness.browser.tabs.size, initialTabCount + 1, 'Tab count must increment by 1');

      const createdTab = harness.browser.tabs.get(tabId);
      assert.ok(createdTab, 'Created tab must exist in tabs store');
      assert.strictEqual(createdTab.url, 'https://www.wikipedia.org/', 'Tab URL must match');
      assert.strictEqual(createdTab.isPinned, false, 'Guest tab must not be pinned');
    });

    it('F1.4: User can switch active tab and listeners receive notification', async () => {
      const tabId = harness.browser.createTab('https://duckduckgo.com');
      let notificationReceived = false;
      let notifiedTab = null;

      const unsubscribe = harness.browser.proctorAPI.onTabUpdated((tab) => {
        notificationReceived = true;
        notifiedTab = tab;
      });

      const switchResult = harness.browser.switchTab(tabId);
      assert.strictEqual(switchResult.activeTabId, tabId, 'Active tab ID must update');
      assert.strictEqual(harness.browser.activeTabId, tabId, 'Browser active tab must be updated');
      assert.strictEqual(notificationReceived, true, 'Tab update listener should be triggered');
      assert.strictEqual(notifiedTab.id, tabId, 'Notified tab must match active tab');
      unsubscribe();
    });

    it('F1.5: User can close secondary tab and active tab cleanly falls back to pinned tab', async () => {
      const tabId = harness.browser.createTab('https://bing.com');
      assert.strictEqual(harness.browser.activeTabId, tabId);

      const closeResult = harness.browser.closeTab(tabId);
      assert.strictEqual(closeResult, true, 'closeTab should return true on success');
      assert.strictEqual(harness.browser.tabs.has(tabId), false, 'Closed tab should be deleted from store');
      assert.strictEqual(harness.browser.activeTabId, harness.browser.assessmentTabId, 'Fallback must be assessment tab');
    });
  });

  // =========================================================================
  // Feature 2: Student Authentication (OTP & Face Baseline)
  // =========================================================================
  describe('Feature 2: Student Authentication (OTP & Face Baseline)', () => {
    it('F2.1: POST /api/auth/otp/request generates 6-digit OTP for valid student ID', async () => {
      const res = await harness.requestOtp('STUDENT-2026-A');
      assert.strictEqual(res.status, 200, 'Should return HTTP 200');
      assert.strictEqual(res.data.studentId, 'STUDENT-2026-A', 'studentId must match');
      assert.ok(/^\d{6}$/.test(res.data.otp), 'OTP must be a 6-digit string');
      assert.strictEqual(res.data.expiresInSeconds, 300, 'OTP expires in 300 seconds');
    });

    it('F2.2: POST /api/auth/otp/verify verifies OTP and issues Bearer session token', async () => {
      const otpRes = await harness.requestOtp('STUDENT-2026-B');
      const otp = otpRes.data.otp;

      const verifyRes = await harness.verifyOtp('STUDENT-2026-B', otp);
      assert.strictEqual(verifyRes.status, 200, 'Should return HTTP 200 on valid OTP');
      assert.ok(typeof verifyRes.data.token === 'string', 'Token must be returned');
      assert.ok(verifyRes.data.token.startsWith('sess_tok_'), 'Token should have sess_tok_ prefix');
      assert.strictEqual(verifyRes.data.session.studentId, 'STUDENT-2026-B');
    });

    it('F2.3: POST /api/auth/face/verify registers facial baseline photo and confirms identity', async () => {
      const sampleFaceBase64 = 'data:image/jpeg;base64,' + Buffer.from('mock_face_pixels_sample').toString('base64');
      const res = await harness.verifyFace('STUDENT-2026-C', sampleFaceBase64, [0.15, -0.32, 0.77]);

      assert.strictEqual(res.status, 200, 'Should return HTTP 200');
      assert.strictEqual(res.data.verified, true, 'Face must be marked verified');
      assert.ok(res.data.similarity >= 0.8, 'Similarity score should be >= 0.8');
      assert.strictEqual(res.data.studentId, 'STUDENT-2026-C');
    });

    it('F2.4: Protected questions endpoint accepts valid Bearer token and rejects unauthenticated request', async () => {
      // 1. Unauthenticated request
      const unauthRes = await harness.getQuestions(null);
      assert.strictEqual(unauthRes.status, 401, 'Must reject unauthenticated request with 401');

      // 2. Request with valid token
      const otpRes = await harness.requestOtp('STUDENT-AUTH-CHECK');
      const verifyRes = await harness.verifyOtp('STUDENT-AUTH-CHECK', otpRes.data.otp);
      const token = verifyRes.data.token;

      const authRes = await harness.getQuestions(token);
      assert.strictEqual(authRes.status, 200, 'Must accept authenticated request with 200');
      assert.ok(Array.isArray(authRes.data), 'Questions payload must be an array');
    });

    it('F2.5: Dual-mode verification satisfies full preflight authorization checklist', async () => {
      const studentId = 'STUDENT-DUAL-01';
      // Step A: OTP Auth
      const otpRes = await harness.requestOtp(studentId);
      const verifyOtp = await harness.verifyOtp(studentId, otpRes.data.otp);
      assert.strictEqual(verifyOtp.status, 200);

      // Step B: Face Baseline
      const mockImage = 'data:image/webp;base64,' + Buffer.from('face_reference').toString('base64');
      const faceRes = await harness.verifyFace(studentId, mockImage);
      assert.strictEqual(faceRes.status, 200);
      assert.strictEqual(faceRes.data.verified, true);
    });
  });

  // =========================================================================
  // Feature 3: MCQ Assessment Delivery & Response Submission
  // =========================================================================
  describe('Feature 3: MCQ Assessment Delivery & Response Submission', () => {
    let token;

    beforeEach(async () => {
      const otpRes = await harness.requestOtp('STUDENT-MCQ');
      const verifyRes = await harness.verifyOtp('STUDENT-MCQ', otpRes.data.otp);
      token = verifyRes.data.token;
    });

    it('F3.1: GET /api/assessment/questions returns sanitized questions without answers or explanations', async () => {
      const res = await harness.getQuestions(token);
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.length >= 10, 'Question bank must have at least 10 questions');

      for (const q of res.data) {
        assert.ok(q.id, 'Question must have id');
        assert.ok(q.text, 'Question must have text');
        assert.ok(Array.isArray(q.options), 'Question must have options array');
        assert.ok(q.options.length >= 2, 'Question must have at least 2 options');

        // Security check: sanitized delivery
        assert.strictEqual(q.correctOptionId, undefined, 'Sanitized question must NOT contain correctOptionId');
        assert.strictEqual(q.explanation, undefined, 'Sanitized question must NOT contain explanation');
      }
    });

    it('F3.2: Question schema provides id, text, and unique option identifiers', async () => {
      const res = await harness.getQuestions(token);
      const q1 = res.data[0];
      assert.strictEqual(q1.id, 'q1');
      assert.ok(q1.options.some(opt => opt.id === 'opt_1b'));
      const optionIds = q1.options.map(opt => opt.id);
      const uniqueIds = new Set(optionIds);
      assert.strictEqual(optionIds.length, uniqueIds.size, 'Option IDs must be unique');
    });

    it('F3.3: POST /api/assessment/answer records selected option for valid question', async () => {
      const sessionRes = await harness.startSession(20);
      const sessionId = sessionRes.data.sessionId;

      const answerRes = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      assert.strictEqual(answerRes.status, 200);
      assert.strictEqual(answerRes.data.saved, true);
      assert.strictEqual(answerRes.data.selectedOptionId, 'opt_1b');
    });

    it('F3.4: Submitting revised answer for same question updates state idempotently', async () => {
      const sessionRes = await harness.startSession(20);
      const sessionId = sessionRes.data.sessionId;

      // Initial selection
      await harness.submitAnswer(sessionId, 'q2', 'opt_2a');
      // Revised selection
      const revisedRes = await harness.submitAnswer(sessionId, 'q2', 'opt_2b');

      assert.strictEqual(revisedRes.status, 200);
      assert.strictEqual(revisedRes.data.saved, true);
      assert.strictEqual(revisedRes.data.selectedOptionId, 'opt_2b', 'Must store updated selection');
    });

    it('F3.5: POST /api/assessment/submit finalizes exam and reveals calculated score and explanations', async () => {
      const sessionRes = await harness.startSession(20);
      const sessionId = sessionRes.data.sessionId;

      // Answer 2 questions: one correct (q1: opt_1b), one wrong (q2: opt_2a)
      await harness.submitAnswer(sessionId, 'q1', 'opt_1b'); // Correct
      await harness.submitAnswer(sessionId, 'q2', 'opt_2a'); // Incorrect (opt_2b is correct)

      const submitRes = await harness.submitExam(sessionId);
      assert.strictEqual(submitRes.status, 200);
      assert.strictEqual(submitRes.data.status, 'SUBMITTED');
      assert.strictEqual(submitRes.data.score, 1, 'Score must be 1 for one correct answer');
      assert.strictEqual(submitRes.data.total, 10, 'Total questions should be 10');
      assert.ok(Array.isArray(submitRes.data.results), 'Results detail breakdown must be provided');

      // Post-submission, result explanations are revealed
      const r1 = submitRes.data.results.find(r => r.questionId === 'q1');
      assert.strictEqual(r1.isCorrect, true);
      assert.ok(r1.explanation.length > 0, 'Explanation should be revealed post-submit');
    });
  });

  // =========================================================================
  // Feature 4: Server-Authoritative Timer & Timeout Submission
  // =========================================================================
  describe('Feature 4: Server-Authoritative Timer & Timeout Submission', () => {
    it('F4.1: POST /api/assessment/session/start initializes server-anchored start and expiry timestamps', async () => {
      const durationMinutes = 25;
      const res = await harness.startSession(durationMinutes);
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.sessionId.startsWith('sess_'));

      const startedAt = res.data.startedAt;
      const expiresAt = res.data.expiresAt;
      assert.ok(expiresAt > startedAt, 'Expiry time must be greater than start time');

      const expectedDiff = durationMinutes * 60 * 1000;
      assert.strictEqual(expiresAt - startedAt, expectedDiff, 'Difference must match duration');
    });

    it('F4.2: GET /api/assessment/session/:id/timer returns remaining seconds and server time', async () => {
      const sessionRes = await harness.startSession(10);
      const sessionId = sessionRes.data.sessionId;

      const timerRes = await harness.getTimer(sessionId);
      assert.strictEqual(timerRes.status, 200);
      assert.strictEqual(timerRes.data.sessionId, sessionId);
      assert.strictEqual(timerRes.data.status, 'IN_PROGRESS');
      assert.ok(timerRes.data.remainingSeconds > 590 && timerRes.data.remainingSeconds <= 600);
      assert.ok(typeof timerRes.data.serverTime === 'number');
    });

    it('F4.3: Successive timer queries demonstrate monotonically decreasing remaining time', async () => {
      const sessionRes = await harness.startSession(5);
      const sessionId = sessionRes.data.sessionId;

      const t1 = await harness.getTimer(sessionId);
      await new Promise(r => setTimeout(r, 60));
      const t2 = await harness.getTimer(sessionId);

      assert.ok(t2.data.serverTime >= t1.data.serverTime, 'Server time must be monotonic non-decreasing');
      assert.ok(t2.data.remainingSeconds <= t1.data.remainingSeconds, 'Remaining seconds must not increase');
    });

    it('F4.4: Expired session status automatically transitions to AUTO_SUBMITTED_TIMEOUT', async () => {
      // Start 0-minute session to simulate immediate expiry
      const sessionRes = await harness.startSession(0);
      const sessionId = sessionRes.data.sessionId;

      // Small delay to ensure expiry timestamp is passed
      await new Promise(r => setTimeout(r, 20));
      const timerRes = await harness.getTimer(sessionId);

      assert.strictEqual(timerRes.data.status, 'AUTO_SUBMITTED_TIMEOUT');
      assert.strictEqual(timerRes.data.remainingSeconds, 0);
    });

    it('F4.5: Late answer submission after timeout sweeper is rejected with HTTP 403', async () => {
      const sessionRes = await harness.startSession(0);
      const sessionId = sessionRes.data.sessionId;

      // Force session past grace period
      await new Promise(r => setTimeout(r, 20));
      await harness.getTimer(sessionId); // Triggers sweeper

      const answerRes = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      assert.strictEqual(answerRes.status, 403, 'Must return 403 Forbidden for late answer');
      assert.match(answerRes.data.message, /expired/i);
    });
  });

  // =========================================================================
  // Feature 5: AI Proctoring: Face Absence & Multi-Face Detection
  // =========================================================================
  describe('Feature 5: AI Proctoring: Face Absence & Multi-Face Detection', () => {
    it('F5.1: Normal continuous single face presence produces zero violations', () => {
      const vision = new VisionHeuristicsMock();
      const now = Date.now();

      const result1 = vision.evaluateFrame({ faceCount: 1, timestamp: now });
      const result2 = vision.evaluateFrame({ faceCount: 1, timestamp: now + 1000 });
      const result3 = vision.evaluateFrame({ faceCount: 1, timestamp: now + 3500 });

      assert.strictEqual(result1.hasViolation, false);
      assert.strictEqual(result2.hasViolation, false);
      assert.strictEqual(result3.hasViolation, false);
    });

    it('F5.2: Face absence persisting past 3.0s threshold triggers FACE_ABSENT violation', () => {
      const vision = new VisionHeuristicsMock({ absenceThresholdMs: 3000 });
      const start = Date.now();

      // At 0s, 0 faces
      const r1 = vision.evaluateFrame({ faceCount: 0, timestamp: start });
      assert.strictEqual(r1.hasViolation, false, 'Initial absence tick should not violate immediately');

      // At 2.5s, still within grace limit
      const r2 = vision.evaluateFrame({ faceCount: 0, timestamp: start + 2500 });
      assert.strictEqual(r2.hasViolation, false, 'Under 3.0s must not violate');

      // At 3.1s, exceeds 3000ms threshold
      const r3 = vision.evaluateFrame({ faceCount: 0, timestamp: start + 3100 });
      assert.strictEqual(r3.hasViolation, true, 'At 3.1s must trigger violation');
      assert.strictEqual(r3.violations[0].type, 'FACE_ABSENT');
    });

    it('F5.3: Multiple faces detected persisting past 1.2s threshold triggers MULTIPLE_FACES violation', () => {
      const vision = new VisionHeuristicsMock({ multiFaceThresholdMs: 1200 });
      const start = Date.now();

      vision.evaluateFrame({ faceCount: 2, timestamp: start });
      const subThreshold = vision.evaluateFrame({ faceCount: 2, timestamp: start + 800 });
      assert.strictEqual(subThreshold.hasViolation, false);

      const pastThreshold = vision.evaluateFrame({ faceCount: 2, timestamp: start + 1300 });
      assert.strictEqual(pastThreshold.hasViolation, true);
      assert.strictEqual(pastThreshold.violations[0].type, 'MULTIPLE_FACES');
      assert.strictEqual(pastThreshold.violations[0].faceCount, 2);
    });

    it('F5.4: Student face returning to frame resets absence timer and restores normal state', () => {
      const vision = new VisionHeuristicsMock({ absenceThresholdMs: 3000 });
      const start = Date.now();

      vision.evaluateFrame({ faceCount: 0, timestamp: start });
      vision.evaluateFrame({ faceCount: 0, timestamp: start + 2000 });

      // Student returns at 2.5s (before 3.0s threshold)
      const restored = vision.evaluateFrame({ faceCount: 1, timestamp: start + 2500 });
      assert.strictEqual(restored.hasViolation, false);
      assert.strictEqual(vision.absenceStartTime, null, 'Absence timer must be reset to null');
    });

    it('F5.5: Vision violation telemetry is successfully ingested via POST /api/proctor/violation', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const violRes = await harness.sendViolation(sessionId, 'FACE_ABSENT', {
        durationMs: 3200,
        cameraConfidence: 0.94
      });

      assert.strictEqual(violRes.status, 200);
      assert.strictEqual(violRes.data.recorded, true);
      assert.strictEqual(violRes.data.strikeCount, 1);
      assert.strictEqual(violRes.data.action, 'WARN');
    });
  });

  // =========================================================================
  // Feature 6: AI Proctoring: Gaze Diversion & Head Pose
  // =========================================================================
  describe('Feature 6: AI Proctoring: Gaze Diversion & Head Pose', () => {
    it('F6.1: Centered head pose (yaw 0, pitch 0, roll 0) evaluates as valid and normal', () => {
      const res = VisionHeuristicsMock.validateEulerAngles(0, 0, 0);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.details.isYawOk, true);
      assert.strictEqual(res.details.isPitchOk, true);
      assert.strictEqual(res.details.isRollOk, true);
    });

    it('F6.2: Extreme head yaw exceeding ±25 degrees triggers HEAD_POSE_DIVERTED', () => {
      const vision = new VisionHeuristicsMock({ yawLimitDeg: 25 });
      const start = Date.now();

      vision.evaluateFrame({
        faceCount: 1,
        euler: { yaw: 35, pitch: 0, roll: 0 },
        timestamp: start
      });

      const res = vision.evaluateFrame({
        faceCount: 1,
        euler: { yaw: 35, pitch: 0, roll: 0 },
        timestamp: start + 1200
      });

      assert.strictEqual(res.hasViolation, true);
      assert.strictEqual(res.violations[0].type, 'HEAD_POSE_DIVERTED');
      assert.strictEqual(res.violations[0].euler.yaw, 35);
    });

    it('F6.3: Extreme pitch (looking up >25° or down <-20°) triggers HEAD_POSE_DIVERTED', () => {
      const vision = new VisionHeuristicsMock();
      const start = Date.now();

      vision.evaluateFrame({ faceCount: 1, euler: { yaw: 0, pitch: -28, roll: 0 }, timestamp: start });
      const res = vision.evaluateFrame({ faceCount: 1, euler: { yaw: 0, pitch: -28, roll: 0 }, timestamp: start + 1100 });

      assert.strictEqual(res.hasViolation, true);
      assert.strictEqual(res.violations[0].type, 'HEAD_POSE_DIVERTED');
    });

    it('F6.4: Horizontal Gaze Ratio (HGR < 0.35 or > 0.65) triggers EYE_GAZE_DIVERTED', () => {
      const vision = new VisionHeuristicsMock({ hgrMin: 0.35, hgrMax: 0.65 });
      const start = Date.now();

      vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.20, ear: 0.30 }, timestamp: start });
      const res = vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.20, ear: 0.30 }, timestamp: start + 1600 });

      assert.strictEqual(res.hasViolation, true);
      assert.strictEqual(res.violations[0].type, 'EYE_GAZE_DIVERTED');
      assert.strictEqual(res.violations[0].hgr, 0.20);
    });

    it('F6.5: Natural blink (EAR < 0.20 for < 400ms) is filtered out without false alert', () => {
      const gazeCheck = VisionHeuristicsMock.validateGaze(0.50, 0.15);
      assert.strictEqual(gazeCheck.isBlink, true, 'Should detect blink condition');
      assert.strictEqual(gazeCheck.isGazeCentered, true, 'Gaze is otherwise centered');

      // Temporal check: 300ms blink duration
      const vision = new VisionHeuristicsMock();
      const start = Date.now();
      vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.5, ear: 0.15 }, timestamp: start });
      const res = vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.5, ear: 0.15 }, timestamp: start + 300 });

      assert.strictEqual(res.hasViolation, false, 'Blink lasting <400ms must not trigger a violation');
    });
  });

  // =========================================================================
  // Feature 7: Warning Display & Violation Accumulation
  // =========================================================================
  describe('Feature 7: Warning Display & Violation Accumulation', () => {
    it('F7.1: First proctoring violation issues WARN action and increments strike count to 1', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const violRes = await harness.sendViolation(sessionId, 'HEAD_POSE_DIVERTED', { yaw: 32 });
      assert.strictEqual(violRes.status, 200);
      assert.strictEqual(violRes.data.strikeCount, 1);
      assert.strictEqual(violRes.data.action, 'WARN');
    });

    it('F7.2: Consecutive violations accurately accumulate strikes (1 -> 2)', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const v1 = await harness.sendViolation(sessionId, 'FACE_ABSENT');
      assert.strictEqual(v1.data.strikeCount, 1);
      assert.strictEqual(v1.data.action, 'WARN');

      const v2 = await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED');
      assert.strictEqual(v2.data.strikeCount, 2);
      assert.strictEqual(v2.data.action, 'WARN');
    });

    it('F7.3: Warning event payload includes human-readable details and timestamp', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const details = { reason: 'Gaze diverted towards phone', confidence: 0.92 };
      await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED', details);

      const reportRes = await harness.getAuditReport(sessionId);
      const violation = reportRes.data.violations[0];
      assert.strictEqual(violation.type, 'EYE_GAZE_DIVERTED');
      assert.strictEqual(violation.details.reason, 'Gaze diverted towards phone');
      assert.ok(typeof violation.timestamp === 'number');
    });

    it('F7.4: Proctor warning listener on client receives dispatched event', () => {
      let warningReceived = null;
      const unsubscribe = harness.browser.proctorAPI.onProctorWarning((warning) => {
        warningReceived = warning;
      });

      // Dispatch warning
      for (const listener of harness.browser.warningListeners) {
        listener({ code: 'FACE_ABSENT', strike: 1, message: 'Please look at the screen' });
      }

      assert.ok(warningReceived);
      assert.strictEqual(warningReceived.code, 'FACE_ABSENT');
      assert.strictEqual(warningReceived.strike, 1);
      unsubscribe();
    });

    it('F7.5: Violation record attaches WebP snapshot base64 telemetry', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;
      const mockWebp = 'data:image/webp;base64,' + Buffer.from('mock_evidence_frame').toString('base64');

      const vRes = await harness.sendViolation(sessionId, 'MULTIPLE_FACES', { count: 3 }, mockWebp);
      assert.strictEqual(vRes.status, 200);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.violations[0].hasSnapshot, true);
    });
  });

  // =========================================================================
  // Feature 8: Disqualification upon Strike Threshold
  // =========================================================================
  describe('Feature 8: Disqualification upon Strike Threshold', () => {
    it('F8.1: Reaching maximum strikes (3) triggers action DISQUALIFY', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendViolation(sessionId, 'FACE_ABSENT'); // Strike 1
      await harness.sendViolation(sessionId, 'FACE_ABSENT'); // Strike 2
      const v3 = await harness.sendViolation(sessionId, 'FACE_ABSENT'); // Strike 3

      assert.strictEqual(v3.status, 200);
      assert.strictEqual(v3.data.strikeCount, 3);
      assert.strictEqual(v3.data.action, 'DISQUALIFY');
      assert.strictEqual(v3.data.sessionStatus, 'DISQUALIFIED');
    });

    it('F8.2: Disqualified session locks assessment status to DISQUALIFIED', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendViolation(sessionId, 'VIOLATION_1');
      await harness.sendViolation(sessionId, 'VIOLATION_2');
      await harness.sendViolation(sessionId, 'VIOLATION_3');

      const timerRes = await harness.getTimer(sessionId);
      assert.strictEqual(timerRes.data.status, 'DISQUALIFIED');
    });

    it('F8.3: onDisqualify client listener is triggered upon disqualification', () => {
      let disqualifiedReason = null;
      const unsubscribe = harness.browser.proctorAPI.onDisqualify((reason) => {
        disqualifiedReason = reason;
      });

      for (const listener of harness.browser.disqualifyListeners) {
        listener('Maximum strikes reached: 3 infractions');
      }

      assert.strictEqual(disqualifiedReason, 'Maximum strikes reached: 3 infractions');
      unsubscribe();
    });

    it('F8.4: Answering questions after disqualification is strictly rejected with HTTP 403', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      // Disqualify session
      await harness.sendViolation(sessionId, 'V1');
      await harness.sendViolation(sessionId, 'V2');
      await harness.sendViolation(sessionId, 'V3');

      const ansRes = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      assert.strictEqual(ansRes.status, 403);
      assert.match(ansRes.data.message, /disqualified/i);
    });

    it('F8.5: Disqualified session audit report records full strike sequence and final state', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendViolation(sessionId, 'HEAD_POSE_DIVERTED');
      await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED');
      await harness.sendViolation(sessionId, 'MULTIPLE_FACES');

      const audit = await harness.getAuditReport(sessionId);
      assert.strictEqual(audit.data.session.status, 'DISQUALIFIED');
      assert.strictEqual(audit.data.session.strikeCount, 3);
      assert.strictEqual(audit.data.violations.length, 3);
    });
  });

  // =========================================================================
  // Feature 9: In-Browser Tab Switches & URL Tracking
  // =========================================================================
  describe('Feature 9: In-Browser Tab Switches & URL Tracking', () => {
    it('F9.1: Tab switch event is recorded with source and destination identifiers', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const res = await harness.sendTabEvent(sessionId, 'TAB_SWITCH', 'https://en.wikipedia.org', 'Wikipedia');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.recorded, true);
    });

    it('F9.2: URL navigation in guest tab logs full target URL and page title', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', 'https://developer.mozilla.org/en-US/', 'MDN Web Docs');

      const report = await harness.getAuditReport(sessionId);
      const navEvent = report.data.tabEvents[0];
      assert.strictEqual(navEvent.type, 'TAB_NAVIGATE');
      assert.strictEqual(navEvent.url, 'https://developer.mozilla.org/en-US/');
      assert.strictEqual(navEvent.title, 'MDN Web Docs');
    });

    it('F9.3: Protocol whitelisting permits standard HTTP and HTTPS URLs', () => {
      assert.doesNotThrow(() => {
        harness.browser.sanitizeAndValidateUrl('https://example.com');
      });
      assert.doesNotThrow(() => {
        harness.browser.sanitizeAndValidateUrl('http://example.org/test');
      });
    });

    it('F9.4: Blocked dangerous protocols (file:, javascript:, data:) throw security exceptions', () => {
      assert.throws(() => {
        harness.browser.sanitizeAndValidateUrl('file:///etc/passwd');
      }, /Security Exception: Blocked protocol/);

      assert.throws(() => {
        harness.browser.sanitizeAndValidateUrl('javascript:alert(1)');
      }, /Security Exception: Blocked protocol/);

      assert.throws(() => {
        harness.browser.sanitizeAndValidateUrl('data:text/html,<script>bad()</script>');
      }, /Security Exception: Blocked protocol/);
    });

    it('F9.5: Tab events persist chronologically in the audit report', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', 'https://site1.com');
      await new Promise(r => setTimeout(r, 10));
      await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', 'https://site2.com');

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.tabEvents.length, 2);
      assert.ok(report.data.tabEvents[1].timestamp >= report.data.tabEvents[0].timestamp);
    });
  });

  // =========================================================================
  // Feature 10: AI Service (ChatGPT/Claude) Query Interception
  // =========================================================================
  describe('Feature 10: AI Service (ChatGPT/Claude) Query Interception', () => {
    it('F10.1: Google search URL extracts query parameter faithfully', () => {
      const res = BrowserMock.extractSearchQuery('https://www.google.com/search?q=binary+search+tree+complexity');
      assert.ok(res);
      assert.strictEqual(res.service, 'Google');
      assert.strictEqual(res.query, 'binary search tree complexity');
    });

    it('F10.2: Bing and DuckDuckGo search URLs extract query parameters', () => {
      const bing = BrowserMock.extractSearchQuery('https://www.bing.com/search?q=how+to+invert+binary+tree');
      assert.strictEqual(bing.service, 'Bing');
      assert.strictEqual(bing.query, 'how to invert binary tree');

      const ddg = BrowserMock.extractSearchQuery('https://duckduckgo.com/?q=quicksort+vs+mergesort');
      assert.strictEqual(ddg.service, 'DuckDuckGo');
      assert.strictEqual(ddg.query, 'quicksort vs mergesort');
    });

    it('F10.3: ChatGPT navigation and prompt extraction intercepts prompt text', () => {
      const chatgptUrl = 'https://chatgpt.com/?prompt=solve+this+mcq+question';
      const extracted = BrowserMock.extractSearchQuery(chatgptUrl);
      assert.strictEqual(extracted.service, 'ChatGPT');
      assert.strictEqual(extracted.query, 'solve this mcq question');

      const direct = BrowserMock.interceptAIPrompt('ChatGPT', 'Explain Dijkstra algorithm', 'https://chatgpt.com');
      assert.strictEqual(direct.service, 'ChatGPT');
      assert.strictEqual(direct.query, 'Explain Dijkstra algorithm');
    });

    it('F10.4: Claude AI navigation and prompt extraction intercepts prompt text', () => {
      const claudeUrl = 'https://claude.ai/?q=what+is+the+ear+metric+in+vision';
      const extracted = BrowserMock.extractSearchQuery(claudeUrl);
      assert.strictEqual(extracted.service, 'Claude');
      assert.strictEqual(extracted.query, 'what is the ear metric in vision');

      const direct = BrowserMock.interceptAIPrompt('Claude', 'Summarize React hooks', 'https://claude.ai');
      assert.strictEqual(direct.service, 'Claude');
      assert.strictEqual(direct.query, 'Summarize React hooks');
    });

    it('F10.5: Search & AI query events persist in session audit log via POST /api/proctor/search-event', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const res = await harness.sendSearchEvent(sessionId, 'ChatGPT', 'give me answer for question 1', 'https://chatgpt.com');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.recorded, true);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.searchEvents.length, 1);
      assert.strictEqual(report.data.searchEvents[0].service, 'ChatGPT');
      assert.strictEqual(report.data.searchEvents[0].query, 'give me answer for question 1');
    });
  });

  // =========================================================================
  // Feature 11: Keystroke & Mouse Activity Logging
  // =========================================================================
  describe('Feature 11: Keystroke & Mouse Activity Logging', () => {
    it('F11.1: Shortcut keys (Alt+Tab, F12) are recorded as KEYSTROKE events', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const res = await harness.sendInputActivity(sessionId, 'KEYSTROKE', {
        key: 'Tab',
        altKey: true,
        ctrlKey: false,
        name: 'Alt+Tab'
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.recorded, true);
    });

    it('F11.2: Clipboard copy/paste events are logged with character count', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      const res = await harness.sendInputActivity(sessionId, 'CLIPBOARD', {
        action: 'PASTE',
        length: 45,
        preview: 'What is the time complexity of...'
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.recorded, true);
    });

    it('F11.3: Throttled mouse tracking aggregates rapid movements into 500ms summary bursts', () => {
      const baseTime = 100000;
      const movements = [
        { timestamp: baseTime, x: 10, y: 10 },
        { timestamp: baseTime + 100, x: 20, y: 20 },
        { timestamp: baseTime + 200, x: 30, y: 30 },
        { timestamp: baseTime + 600, x: 40, y: 40 }, // Next burst
        { timestamp: baseTime + 700, x: 50, y: 50 }
      ];

      const bursts = BrowserMock.aggregateMouseActivity(movements, 500);
      assert.strictEqual(bursts.length, 2, 'Should group into exactly 2 bursts');
      assert.strictEqual(bursts[0].moveCount, 3);
      assert.strictEqual(bursts[1].moveCount, 2);
    });

    it('F11.4: Window blur and focus events are captured in telemetry', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendInputActivity(sessionId, 'WINDOW_BLUR', { reason: 'User switched window' });
      await harness.sendInputActivity(sessionId, 'WINDOW_FOCUS', { reason: 'User returned to window' });

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.inputEvents.length, 2);
      assert.strictEqual(report.data.inputEvents[0].type, 'WINDOW_BLUR');
      assert.strictEqual(report.data.inputEvents[1].type, 'WINDOW_FOCUS');
    });

    it('F11.5: proctorAPI.logActivity bridge function forwards telemetry events', async () => {
      const initialCount = harness.browser.loggedActivities.length;
      await harness.browser.proctorAPI.logActivity({
        type: 'KEYSTROKE',
        key: 'F12',
        description: 'DevTools shortcut attempted'
      });

      assert.strictEqual(harness.browser.loggedActivities.length, initialCount + 1);
      assert.strictEqual(harness.browser.loggedActivities[0].key, 'F12');
    });
  });

  // =========================================================================
  // Feature 12: Auditor Review View & Session Reporting
  // =========================================================================
  describe('Feature 12: Auditor Review View & Session Reporting', () => {
    it('F12.1: Full session report returns complete audit trail including metadata and counts', async () => {
      const sessionRes = await harness.startSession(30, 'STUDENT-AUDIT');
      const sessionId = sessionRes.data.sessionId;

      await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED', { hgr: 0.15 });
      await harness.sendSearchEvent(sessionId, 'Google', 'mcq test answer', 'https://google.com');

      const res = await harness.getAuditReport(sessionId);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.session.sessionId, sessionId);
      assert.strictEqual(res.data.session.studentId, 'STUDENT-AUDIT');
      assert.strictEqual(res.data.summary.totalViolations, 1);
      assert.strictEqual(res.data.summary.totalSearchQueries, 1);
    });

    it('F12.2: Audit events are ordered chronologically by timestamp', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendViolation(sessionId, 'V1');
      await new Promise(r => setTimeout(r, 10));
      await harness.sendViolation(sessionId, 'V2');

      const res = await harness.getAuditReport(sessionId);
      assert.ok(res.data.violations[1].timestamp >= res.data.violations[0].timestamp);
    });

    it('F12.3: Violation snapshot gallery preserves captured evidence images', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;
      const snapshotBase64 = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v39gAA=';

      await harness.sendViolation(sessionId, 'MULTIPLE_FACES', { faces: 2 }, snapshotBase64);

      const res = await harness.getAuditReport(sessionId);
      assert.strictEqual(res.data.violations[0].hasSnapshot, true);
      assert.ok(res.data.violations[0].snapshot);
    });

    it('F12.4: Search intelligence table itemizes service name, query, and destination URL', async () => {
      const sessionRes = await harness.startSession(30);
      const sessionId = sessionRes.data.sessionId;

      await harness.sendSearchEvent(sessionId, 'Claude', 'explain dynamic programming', 'https://claude.ai/chat');

      const res = await harness.getAuditReport(sessionId);
      const queryItem = res.data.searchEvents[0];
      assert.strictEqual(queryItem.service, 'Claude');
      assert.strictEqual(queryItem.query, 'explain dynamic programming');
      assert.strictEqual(queryItem.url, 'https://claude.ai/chat');
    });

    it('F12.5: Audit export provides clean, structured HTML review view for proctors', async () => {
      const sessionRes = await harness.startSession(30, 'STUDENT-HTML-EXPORT');
      const sessionId = sessionRes.data.sessionId;

      await harness.sendViolation(sessionId, 'FACE_ABSENT', { duration: 3500 });
      await harness.sendSearchEvent(sessionId, 'ChatGPT', 'cheating prompt', 'https://chatgpt.com');

      const res = await harness.exportAuditHtml(sessionId);
      assert.strictEqual(res.status, 200);
      assert.ok(typeof res.data === 'string');
      assert.ok(res.data.includes('<!DOCTYPE html>'));
      assert.ok(res.data.includes('Proctoring Audit Trail'));
      assert.ok(res.data.includes(sessionId));
      assert.ok(res.data.includes('STUDENT-HTML-EXPORT'));
    });
  });
});
