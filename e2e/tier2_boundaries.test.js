/**
 * Tier 2: Boundary & Corner Cases Test Suite (Opaque-Box E2E)
 *
 * Verifies edge conditions, limits, zero inputs, rapid fire submissions,
 * expired sessions, malformed payloads, unicode, extreme angles, EAR blinks,
 * strike boundaries, and security constraints across all 12 feature areas:
 *
 * Total: 60 test cases (5 tests per feature).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E2EHarness } = require('./harness');
const { BrowserMock } = require('./helpers/browserMock');
const { VisionHeuristicsMock } = require('./helpers/visionMock');

describe('Tier 2: Boundary & Corner Cases Suite (60 Tests)', () => {
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
  // Feature 1: Multi-tab Navigation Boundaries
  // =========================================================================
  describe('Feature 1: Desktop Shell & Multi-tab Boundaries', () => {
    it('B1.1: Navigating tab with empty string or whitespace defaults safely to about:blank', () => {
      const url1 = harness.browser.sanitizeAndValidateUrl('');
      assert.strictEqual(url1, 'about:blank');

      const url2 = harness.browser.sanitizeAndValidateUrl('   ');
      assert.strictEqual(url2, 'about:blank');
    });

    it('B1.2: Calling switchTab or closeTab with non-existent tab ID throws graceful error', () => {
      assert.throws(() => {
        harness.browser.switchTab('non_existent_tab_999');
      }, /Tab not found/);

      assert.throws(() => {
        harness.browser.closeTab('non_existent_tab_999');
      }, /Tab not found/);
    });

    it('B1.3: Exceeding maximum concurrent tab limit throws error', () => {
      const smallBrowser = new BrowserMock({ maxTabs: 3 });
      // Initially has 1 pinned tab
      smallBrowser.createTab('https://site1.com');
      smallBrowser.createTab('https://site2.com');
      assert.strictEqual(smallBrowser.tabs.size, 3);

      assert.throws(() => {
        smallBrowser.createTab('https://site3.com');
      }, /Maximum concurrent tabs reached/);
    });

    it('B1.4: Attempting to close pinned assessment tab is strictly rejected', () => {
      assert.throws(() => {
        harness.browser.closeTab(harness.browser.assessmentTabId);
      }, /Pinned assessment tab cannot be closed/);
    });

    it('B1.5: Navigating to URL without protocol prepends https automatically', () => {
      const normalized = harness.browser.sanitizeAndValidateUrl('docs.github.com/en');
      assert.strictEqual(normalized, 'https://docs.github.com/en');
    });
  });

  // =========================================================================
  // Feature 2: Student Authentication Boundaries
  // =========================================================================
  describe('Feature 2: Student Authentication Boundaries', () => {
    it('B2.1: Verifying OTP with incorrect code returns HTTP 401 Unauthorized', async () => {
      await harness.requestOtp('STUDENT-ERR-1');
      const res = await harness.verifyOtp('STUDENT-ERR-1', '000000'); // Wrong OTP
      assert.strictEqual(res.status, 401);
      assert.match(res.data.message, /invalid otp/i);
    });

    it('B2.2: Verifying OTP for student ID that never requested OTP returns HTTP 401', async () => {
      const res = await harness.verifyOtp('UNKNOWN-STUDENT', '123456');
      assert.strictEqual(res.status, 401);
      assert.match(res.data.message, /no otp requested/i);
    });

    it('B2.3: Requesting OTP with empty string or malicious characters returns HTTP 400', async () => {
      const resEmpty = await harness.requestOtp('');
      assert.strictEqual(resEmpty.status, 400);

      const resXSS = await harness.requestOtp('<script>alert(1)</script>');
      assert.strictEqual(resXSS.status, 400);
      assert.match(resXSS.data.message, /disallowed special characters/i);
    });

    it('B2.4: Face baseline verification with missing or truncated image returns HTTP 400', async () => {
      const resMissing = await harness.verifyFace('STUDENT-FACE', '');
      assert.strictEqual(resMissing.status, 400);

      const resShort = await harness.verifyFace('STUDENT-FACE', 'tiny');
      assert.strictEqual(resShort.status, 400);
    });

    it('B2.5: Calling protected endpoints with tampered or forged Bearer token returns HTTP 401', async () => {
      const fakeToken = 'sess_tok_forged_uuid_12345';
      const res = await harness.getQuestions(fakeToken);
      assert.strictEqual(res.status, 401);
    });
  });

  // =========================================================================
  // Feature 3: MCQ Delivery & Response Submission Boundaries
  // =========================================================================
  describe('Feature 3: MCQ Delivery & Response Submission Boundaries', () => {
    let sessionId;

    beforeEach(async () => {
      const s = await harness.startSession(30);
      sessionId = s.data.sessionId;
    });

    it('B3.1: Submitting answer for non-existent question ID returns HTTP 404', async () => {
      const res = await harness.submitAnswer(sessionId, 'non_existent_question_99', 'opt_1a');
      assert.strictEqual(res.status, 404);
      assert.match(res.data.message, /question not found/i);
    });

    it('B3.2: Submitting invalid option ID not belonging to question returns HTTP 400', async () => {
      const res = await harness.submitAnswer(sessionId, 'q1', 'opt_INVALID_XYZ');
      assert.strictEqual(res.status, 400);
      assert.match(res.data.message, /invalid selectedoptionid/i);
    });

    it('B3.3: Rapid fire 25 duplicate answer submissions resolves cleanly without corruption', async () => {
      const promises = [];
      for (let i = 0; i < 25; i++) {
        promises.push(harness.submitAnswer(sessionId, 'q1', 'opt_1b'));
      }
      const results = await Promise.all(promises);
      for (const r of results) {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.saved, true);
      }
    });

    it('B3.4: Submitting empty string as selectedOptionId returns HTTP 400', async () => {
      const res = await harness.submitAnswer(sessionId, 'q1', '   ');
      assert.strictEqual(res.status, 400);
      assert.match(res.data.message, /must be a non-empty string/i);
    });

    it('B3.5: Double submit on already SUBMITTED session is idempotent with preserved score', async () => {
      await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      const submit1 = await harness.submitExam(sessionId);
      assert.strictEqual(submit1.status, 200);
      assert.strictEqual(submit1.data.status, 'SUBMITTED');

      // Second submit
      const submit2 = await harness.submitExam(sessionId);
      assert.strictEqual(submit2.status, 200);
      assert.strictEqual(submit2.data.status, 'SUBMITTED');
      assert.strictEqual(submit2.data.score, submit1.data.score);
    });
  });

  // =========================================================================
  // Feature 4: Server-Authoritative Timer Boundaries
  // =========================================================================
  describe('Feature 4: Server-Authoritative Timer Boundaries', () => {
    it('B4.1: Starting session with 0 minutes duration marks status expired immediately', async () => {
      const res = await harness.startSession(0);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.durationMinutes, 0);

      await new Promise(r => setTimeout(r, 20));
      const timer = await harness.getTimer(res.data.sessionId);
      assert.strictEqual(timer.data.status, 'AUTO_SUBMITTED_TIMEOUT');
    });

    it('B4.2: Starting session with negative duration rejects with HTTP 400', async () => {
      const res = await harness.startSession(-15);
      assert.strictEqual(res.status, 400);
      assert.match(res.data.message, /non-negative/i);
    });

    it('B4.3: Starting session with excessive duration caps to maximum 180 minutes', async () => {
      const res = await harness.startSession(99999);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.durationMinutes, 180);
    });

    it('B4.4: Sub-second timer query immediately after start shows remainingSeconds within 1s of total', async () => {
      const res = await harness.startSession(10);
      const timer = await harness.getTimer(res.data.sessionId);
      assert.strictEqual(timer.status, 200);
      assert.ok(timer.data.remainingSeconds >= 599 && timer.data.remainingSeconds <= 600);
    });

    it('B4.5: Answer submitted after timeout and grace period returns HTTP 403', async () => {
      const res = await harness.startSession(0);
      const sessionId = res.data.sessionId;

      // Force past grace period
      await new Promise(r => setTimeout(r, 50));
      await harness.getTimer(sessionId); // Sweeper executes

      const ans = await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
      assert.strictEqual(ans.status, 403);
    });
  });

  // =========================================================================
  // Feature 5: Face Absence & Multi-Face Boundaries
  // =========================================================================
  describe('Feature 5: Face Absence & Multi-Face Boundaries', () => {
    it('B5.1: Sub-threshold face absence (2.9s under 3.0s threshold) generates zero violations', () => {
      const vision = new VisionHeuristicsMock({ absenceThresholdMs: 3000 });
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 0, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 0, timestamp: t0 + 2900 });
      assert.strictEqual(r.hasViolation, false, 'Absence of 2900ms must not violate');
    });

    it('B5.2: Sub-threshold multi-face flicker (1.0s under 1.2s threshold) generates zero violations', () => {
      const vision = new VisionHeuristicsMock({ multiFaceThresholdMs: 1200 });
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 2, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 2, timestamp: t0 + 1000 });
      assert.strictEqual(r.hasViolation, false, 'Multi-face of 1000ms must not violate');
    });

    it('B5.3: Massive crowd in frame (10 faces) triggers immediate multi-face violation', () => {
      const vision = new VisionHeuristicsMock({ multiFaceThresholdMs: 1200 });
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 10, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 10, timestamp: t0 + 1300 });

      assert.strictEqual(r.hasViolation, true);
      assert.strictEqual(r.violations[0].type, 'MULTIPLE_FACES');
      assert.strictEqual(r.violations[0].faceCount, 10);
    });

    it('B5.4: Absence duration exactly at 3.00s threshold triggers violation immediately', () => {
      const vision = new VisionHeuristicsMock({ absenceThresholdMs: 3000 });
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 0, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 0, timestamp: t0 + 3000 });
      assert.strictEqual(r.hasViolation, true);
      assert.strictEqual(r.violations[0].type, 'FACE_ABSENT');
    });

    it('B5.5: Rapid toggling face count (0, 1, 0, 1, 2, 1) does not cause state deadlock', () => {
      const vision = new VisionHeuristicsMock();
      const t0 = 10000;

      const counts = [0, 1, 0, 1, 2, 1, 0, 1];
      for (let i = 0; i < counts.length; i++) {
        const res = vision.evaluateFrame({ faceCount: counts[i], timestamp: t0 + i * 200 });
        assert.strictEqual(res.hasViolation, false, 'Rapid toggling under thresholds should not violate');
      }
      assert.strictEqual(vision.absenceStartTime, null);
      assert.strictEqual(vision.multiFaceStartTime, null);
    });
  });

  // =========================================================================
  // Feature 6: Head Pose & Iris Gaze Boundaries
  // =========================================================================
  describe('Feature 6: Head Pose & Iris Gaze Boundaries', () => {
    it('B6.1: Exactly on Yaw boundary: 25.0° is valid, 25.1° triggers deviation', () => {
      const okCheck = VisionHeuristicsMock.validateEulerAngles(25.0, 0, 0);
      assert.strictEqual(okCheck.valid, true);

      const failCheck = VisionHeuristicsMock.validateEulerAngles(25.1, 0, 0);
      assert.strictEqual(failCheck.valid, false);
      assert.strictEqual(failCheck.details.isYawOk, false);
    });

    it('B6.2: Exactly on Pitch boundary: -20.0° and +25.0° are valid; -20.1° and +25.1° fail', () => {
      assert.strictEqual(VisionHeuristicsMock.validateEulerAngles(0, -20.0, 0).valid, true);
      assert.strictEqual(VisionHeuristicsMock.validateEulerAngles(0, 25.0, 0).valid, true);
      assert.strictEqual(VisionHeuristicsMock.validateEulerAngles(0, -20.1, 0).valid, false);
      assert.strictEqual(VisionHeuristicsMock.validateEulerAngles(0, 25.1, 0).valid, false);
    });

    it('B6.3: EAR < 0.20 for > 2000ms triggers PROLONGED_EYES_CLOSED violation', () => {
      const vision = new VisionHeuristicsMock();
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.5, ear: 0.12 }, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 1, gaze: { hgr: 0.5, ear: 0.12 }, timestamp: t0 + 2200 });

      assert.strictEqual(r.hasViolation, true);
      assert.strictEqual(r.violations[0].type, 'PROLONGED_EYES_CLOSED');
    });

    it('B6.4: Simultaneous extreme yaw + pitch handled cleanly without duplicate crash', () => {
      const vision = new VisionHeuristicsMock();
      const t0 = 10000;

      vision.evaluateFrame({ faceCount: 1, euler: { yaw: 40, pitch: 35, roll: 0 }, timestamp: t0 });
      const r = vision.evaluateFrame({ faceCount: 1, euler: { yaw: 40, pitch: 35, roll: 0 }, timestamp: t0 + 1200 });

      assert.strictEqual(r.hasViolation, true);
      assert.strictEqual(r.violations[0].type, 'HEAD_POSE_DIVERTED');
    });

    it('B6.5: NaN or Infinite Euler angles handled safely without worker exception', () => {
      const vision = new VisionHeuristicsMock();
      const resNaN = vision.evaluateFrame({ faceCount: 1, euler: { yaw: NaN, pitch: Infinity, roll: 0 } });
      assert.strictEqual(resNaN.hasViolation, false);

      const staticVal = VisionHeuristicsMock.validateEulerAngles(NaN, 0, 0);
      assert.strictEqual(staticVal.valid, false);
    });
  });

  // =========================================================================
  // Feature 7: Warning & Violation Accumulation Boundaries
  // =========================================================================
  describe('Feature 7: Warning & Violation Accumulation Boundaries', () => {
    it('B7.1: Ingesting unknown violation type records as fallback without crashing', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const res = await harness.sendViolation(sessionId, 'UNKNOWN_CUSTOM_SENSOR_ALERT');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.strikeCount, 1);
    });

    it('B7.2: Oversized snapshot payload (>5MB) is rejected with HTTP 413 Payload Too Large', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      // 6MB payload
      const hugeSnapshot = 'a'.repeat(6 * 1024 * 1024);
      const res = await harness.sendViolation(sessionId, 'FACE_ABSENT', {}, hugeSnapshot);
      assert.strictEqual(res.status, 413);
      assert.match(res.data.message, /maximum allowed size/i);
    });

    it('B7.3: Ingesting violation with null snapshot base64 successfully records with hasSnapshot: false', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const res = await harness.sendViolation(sessionId, 'FACE_ABSENT', {}, null);
      assert.strictEqual(res.status, 200);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.violations[0].hasSnapshot, false);
    });

    it('B7.4: Rapid consecutive violations increment strike counter atomically', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      // Ingest 2 violations in parallel
      const [v1, v2] = await Promise.all([
        harness.sendViolation(sessionId, 'V1'),
        harness.sendViolation(sessionId, 'V2')
      ]);

      assert.strictEqual(v1.status, 200);
      assert.strictEqual(v2.status, 200);
      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.session.strikeCount, 2);
    });

    it('B7.5: Violation details containing special characters and unicode persist safely', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const details = {
        meta: '<script>alert("test")</script>',
        notes: '⚠️ Multi-face detected with emojis & "quotes" & \\backslashes\\',
        unicode: '日本語テスト'
      };

      const res = await harness.sendViolation(sessionId, 'MULTIPLE_FACES', details);
      assert.strictEqual(res.status, 200);

      const report = await harness.getAuditReport(sessionId);
      const saved = report.data.violations[0].details;
      assert.strictEqual(saved.notes, details.notes);
      assert.strictEqual(saved.unicode, details.unicode);
    });
  });

  // =========================================================================
  // Feature 8: Strike Threshold & Disqualification Boundaries
  // =========================================================================
  describe('Feature 8: Strike Threshold & Disqualification Boundaries', () => {
    it('B8.1: Exact threshold boundary: Strike 1 WARN, Strike 2 WARN, Strike 3 DISQUALIFY', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const s1 = await harness.sendViolation(sessionId, 'V1');
      assert.strictEqual(s1.data.strikeCount, 1);
      assert.strictEqual(s1.data.action, 'WARN');

      const s2 = await harness.sendViolation(sessionId, 'V2');
      assert.strictEqual(s2.data.strikeCount, 2);
      assert.strictEqual(s2.data.action, 'WARN');

      const s3 = await harness.sendViolation(sessionId, 'V3');
      assert.strictEqual(s3.data.strikeCount, 3);
      assert.strictEqual(s3.data.action, 'DISQUALIFY');
    });

    it('B8.2: Ingesting violations after session is already DISQUALIFIED preserves DISQUALIFIED status', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      // Disqualify with 3 strikes
      await harness.sendViolation(sessionId, 'V1');
      await harness.sendViolation(sessionId, 'V2');
      await harness.sendViolation(sessionId, 'V3');

      // 4th violation
      const s4 = await harness.sendViolation(sessionId, 'V4');
      assert.strictEqual(s4.data.strikeCount, 4);
      assert.strictEqual(s4.data.action, 'DISQUALIFY');
      assert.strictEqual(s4.data.sessionStatus, 'DISQUALIFIED');
    });

    it('B8.3: Freshly started session has exactly 0 strikes and status IN_PROGRESS', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.session.strikeCount, 0);
      assert.strictEqual(report.data.session.status, 'IN_PROGRESS');
    });

    it('B8.4: Flagging immediateDisqualify triggers instant disqualification on strike 1', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const res = await harness.sendViolation(sessionId, 'UNAUTHORIZED_HARDWARE_INJECTED', {}, null, true);
      assert.strictEqual(res.data.strikeCount, 1);
      assert.strictEqual(res.data.action, 'DISQUALIFY');
      assert.strictEqual(res.data.sessionStatus, 'DISQUALIFIED');
    });

    it('B8.5: Disqualified unsubmitted exam auto-grades existing answered questions', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      await harness.submitAnswer(sessionId, 'q1', 'opt_1b'); // Correct
      await harness.submitAnswer(sessionId, 'q2', 'opt_2b'); // Correct

      // Trigger disqualification
      await harness.sendViolation(sessionId, 'V1');
      await harness.sendViolation(sessionId, 'V2');
      await harness.sendViolation(sessionId, 'V3');

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.session.score, 2, 'Should grade existing 2 answered questions');
      assert.strictEqual(report.data.session.status, 'DISQUALIFIED');
    });
  });

  // =========================================================================
  // Feature 9: Tab Switches & URL Tracking Boundaries
  // =========================================================================
  describe('Feature 9: Tab Switches & URL Tracking Boundaries', () => {
    it('B9.1: Extremely long URL (4000+ chars) is tracked cleanly without buffer crash', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const longPath = 'a'.repeat(4000);
      const longUrl = `https://example.com/search?data=${longPath}`;
      const res = await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', longUrl);
      assert.strictEqual(res.status, 200);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.tabEvents[0].url.length, longUrl.length);
    });

    it('B9.2: URL with URL-encoded special characters (%20, %3Cscript%3E) persists faithfully', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const rawUrl = 'https://example.com/query?q=%3Cscript%3E%20hello%20%26%20world';
      await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', rawUrl);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.tabEvents[0].url, rawUrl);
    });

    it('B9.3: Rapid switching between 10 tabs preserves all 10 switch events in order', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      for (let i = 1; i <= 10; i++) {
        await harness.sendTabEvent(sessionId, 'TAB_SWITCH', `https://tab${i}.com`, `Tab ${i}`);
      }

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.tabEvents.length, 10);
      assert.strictEqual(report.data.tabEvents[9].title, 'Tab 10');
    });

    it('B9.4: Navigating tab without page title records empty string safely', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', 'https://notitle.org');
      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.tabEvents[0].title, '');
    });

    it('B9.5: Navigation with whitespace and fragment URL normalizes correctly', () => {
      const url = harness.browser.sanitizeAndValidateUrl('  https://example.org/path#section-1  ');
      assert.strictEqual(url, 'https://example.org/path#section-1');
    });
  });

  // =========================================================================
  // Feature 10: AI Search Query Interception Boundaries
  // =========================================================================
  describe('Feature 10: AI Search Query Interception Boundaries', () => {
    it('B10.1: Search query with complex math and programming syntax is preserved', () => {
      const rawUrl = 'https://www.google.com/search?q=x%5E2+%2B+y_1+%3D+%5Cint+f(x)dx+%26%26+foo-%3Ebar()';
      const extracted = BrowserMock.extractSearchQuery(rawUrl);
      assert.strictEqual(extracted.service, 'Google');
      assert.strictEqual(extracted.query, 'x^2 + y_1 = \\int f(x)dx && foo->bar()');
    });

    it('B10.2: Non-Latin and multilingual search queries (Japanese, Hindi) are extracted', () => {
      const jpUrl = 'https://duckduckgo.com/?q=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF';
      const extractedJp = BrowserMock.extractSearchQuery(jpUrl);
      assert.strictEqual(extractedJp.query, 'こんにちは');

      const hiUrl = 'https://www.bing.com/search?q=%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87';
      const extractedHi = BrowserMock.extractSearchQuery(hiUrl);
      assert.strictEqual(extractedHi.query, 'नमस्ते');
    });

    it('B10.3: Empty or whitespace query in search URL returns empty string without crashing', () => {
      const emptyUrl = 'https://www.google.com/search?q=';
      const extracted = BrowserMock.extractSearchQuery(emptyUrl);
      assert.strictEqual(extracted.query, '');
    });

    it('B10.4: Multiple q parameters in query string resolves first parameter predictably', () => {
      const multiUrl = 'https://www.google.com/search?q=primary_query&q=secondary_query';
      const extracted = BrowserMock.extractSearchQuery(multiUrl);
      assert.strictEqual(extracted.query, 'primary_query');
    });

    it('B10.5: Subdomains of AI services (chat.openai.com) are classified as ChatGPT', () => {
      const extracted = BrowserMock.extractSearchQuery('https://chat.openai.com/?q=code+assistant');
      assert.strictEqual(extracted.service, 'ChatGPT');
      assert.strictEqual(extracted.query, 'code assistant');
    });
  });

  // =========================================================================
  // Feature 11: Keystroke & Mouse Activity Logging Boundaries
  // =========================================================================
  describe('Feature 11: Keystroke & Mouse Activity Logging Boundaries', () => {
    it('B11.1: High-frequency keystroke burst (50 keys) logged without dropping entries', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(harness.sendInputActivity(sessionId, 'KEYSTROKE', { key: `Key${i}` }));
      }
      await Promise.all(promises);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.inputEvents.length, 50);
    });

    it('B11.2: Clipboard event with large text preview is stored safely', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const largeText = 'X'.repeat(5000);
      const res = await harness.sendInputActivity(sessionId, 'CLIPBOARD', {
        action: 'COPY',
        preview: largeText.substring(0, 100),
        byteLength: 5000
      });
      assert.strictEqual(res.status, 200);

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.inputEvents[0].data.byteLength, 5000);
    });

    it('B11.3: Zero mouse movement array generates zero aggregate bursts', () => {
      const bursts = BrowserMock.aggregateMouseActivity([], 500);
      assert.strictEqual(bursts.length, 0);
    });

    it('B11.4: Rapid window blur/focus spam is captured accurately', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      for (let i = 0; i < 10; i++) {
        await harness.sendInputActivity(sessionId, 'WINDOW_BLUR');
        await harness.sendInputActivity(sessionId, 'WINDOW_FOCUS');
      }

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.inputEvents.length, 20);
    });

    it('B11.5: Function keys F1 through F12 and special modifiers are recorded with names', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      await harness.sendInputActivity(sessionId, 'KEYSTROKE', { key: 'F12', isDevTools: true });
      await harness.sendInputActivity(sessionId, 'KEYSTROKE', { key: 'Escape', isCancel: true });

      const report = await harness.getAuditReport(sessionId);
      assert.strictEqual(report.data.inputEvents[0].data.key, 'F12');
      assert.strictEqual(report.data.inputEvents[1].data.key, 'Escape');
    });
  });

  // =========================================================================
  // Feature 12: Auditor Review View & Session Reporting Boundaries
  // =========================================================================
  describe('Feature 12: Auditor Review View & Session Reporting Boundaries', () => {
    it('B12.1: Brand new session audit report returns valid structure with empty arrays', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const res = await harness.getAuditReport(sessionId);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.violations.length, 0);
      assert.strictEqual(res.data.tabEvents.length, 0);
      assert.strictEqual(res.data.searchEvents.length, 0);
      assert.strictEqual(res.data.inputEvents.length, 0);
    });

    it('B12.2: Requesting audit report for non-existent session ID returns HTTP 404', async () => {
      const res = await harness.getAuditReport('sess_non_existent_uuid_9999');
      assert.strictEqual(res.status, 404);
      assert.match(res.data.message, /session not found/i);
    });

    it('B12.3: High event volume (100 combined events) serializes rapidly without error', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const p = [];
      for (let i = 0; i < 50; i++) {
        p.push(harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', `https://site${i}.com`));
        p.push(harness.sendSearchEvent(sessionId, 'Google', `query_${i}`));
      }
      await Promise.all(p);

      const startTime = Date.now();
      const res = await harness.getAuditReport(sessionId);
      const duration = Date.now() - startTime;

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.tabEvents.length, 50);
      assert.strictEqual(res.data.searchEvents.length, 50);
      assert.ok(duration < 200, 'Audit retrieval must complete within 200ms');
    });

    it('B12.4: Time filter ?since=<timestamp> filters earlier events accurately', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      await harness.sendViolation(sessionId, 'OLD_VIOLATION');
      await new Promise(r => setTimeout(r, 20));
      const cutoff = Date.now();
      await new Promise(r => setTimeout(r, 20));
      await harness.sendViolation(sessionId, 'NEW_VIOLATION');

      const filteredRes = await harness.getAuditReport(sessionId, `since=${cutoff}`);
      assert.strictEqual(filteredRes.status, 200);
      assert.strictEqual(filteredRes.data.violations.length, 1);
      assert.strictEqual(filteredRes.data.violations[0].type, 'NEW_VIOLATION');
    });

    it('B12.5: HTML audit export escapes user query strings to prevent XSS injection', async () => {
      const session = await harness.startSession(30);
      const sessionId = session.data.sessionId;

      const xssQuery = '<script>alert("hacked")</script>';
      await harness.sendSearchEvent(sessionId, 'Google', xssQuery);

      const res = await harness.exportAuditHtml(sessionId);
      assert.strictEqual(res.status, 200);
      assert.ok(!res.data.includes('<script>alert("hacked")</script>'), 'Unescaped script tag must NOT be in HTML');
      assert.ok(res.data.includes('&lt;script&gt;alert(&quot;hacked&quot;)&lt;/script&gt;'), 'Must contain escaped HTML');
    });
  });
});
