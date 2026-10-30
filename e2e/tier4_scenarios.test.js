/**
 * Tier 4: Real-World Scenarios Test Suite (Opaque-Box E2E)
 *
 * Simulates complete realistic student journeys and proctor workflows:
 * - Scenario 1: Full Normal Exam Completion Workflow (OTP, Face Verify, 10 MCQs, Clean Submit, Score Verification)
 * - Scenario 2: Cheating Detection, Strike Escalation & Auto-Disqualification
 * - Scenario 3: Timer Expiration Auto-Submission Sweeper & Late Answer Lockout
 * - Scenario 4: Network Disconnection & Offline Answer Cache Synchronization
 * - Scenario 5: Proctor Audit Review & Evidence Verification
 * - Scenario 6: Question Flagging, Revision & Final Review Workflow
 * - Scenario 7: Multi-Tab Exploration & Mixed AI Search Navigation with Audit Validation
 *
 * Total: 7 comprehensive multi-step scenario test cases (minimum target: 6).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { E2EHarness } = require('./harness');
const { BrowserMock } = require('./helpers/browserMock');
const { VisionHeuristicsMock } = require('./helpers/visionMock');

describe('Tier 4: Real-World Workload Scenarios (7 Scenarios)', () => {
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
  // Scenario 1: Full Normal Exam Completion Workflow
  // =========================================================================
  it('SCN-01: Full normal exam completion (OTP login, face verify, 10 MCQs, clean submit, score verify)', async () => {
    const studentId = 'STUDENT-NORMAL-01';

    // Step 1: Student requests and verifies OTP
    const otpRes = await harness.requestOtp(studentId);
    assert.strictEqual(otpRes.status, 200);
    const verifyOtp = await harness.verifyOtp(studentId, otpRes.data.otp);
    assert.strictEqual(verifyOtp.status, 200);
    const token = verifyOtp.data.token;

    // Step 2: Student registers facial baseline
    const mockFaceImage = 'data:image/webp;base64,' + Buffer.from('student_face_baseline').toString('base64');
    const faceRes = await harness.verifyFace(studentId, mockFaceImage);
    assert.strictEqual(faceRes.status, 200);
    assert.strictEqual(faceRes.data.verified, true);

    // Step 3: Start 30-minute exam session
    const sessionRes = await harness.startSession(30, studentId);
    assert.strictEqual(sessionRes.status, 200);
    const sessionId = sessionRes.data.sessionId;

    // Step 4: Fetch sanitized questions
    const qRes = await harness.getQuestions(token);
    assert.strictEqual(qRes.status, 200);
    const questions = qRes.data;
    assert.strictEqual(questions.length, 10);

    // Step 5: Student answers all 10 questions sequentially
    // Question keys:
    // q1 -> opt_1b (BST: O(log n)) [correct]
    // q2 -> opt_2b (401 Unauthorized) [correct]
    // q3 -> opt_3b (contextBridge) [correct]
    // q4 -> opt_4a (EAR blinks) [correct]
    // q5 -> opt_5b (LRU Cache) [correct]
    // q6 -> opt_6b (wss://) [correct]
    // q7 -> opt_7b (atomic rename) [correct]
    // q8 -> opt_8a (yaw rotation) [correct]
    // q9 -> opt_9a (POST/PUT idempotent) [correct]
    // q10 -> opt_10a (intentional wrong selection for q10) [incorrect: opt_10b is correct]

    const selections = [
      { q: 'q1', opt: 'opt_1b' },
      { q: 'q2', opt: 'opt_2b' },
      { q: 'q3', opt: 'opt_3b' },
      { q: 'q4', opt: 'opt_4a' },
      { q: 'q5', opt: 'opt_5b' },
      { q: 'q6', opt: 'opt_6b' },
      { q: 'q7', opt: 'opt_7b' },
      { q: 'q8', opt: 'opt_8a' },
      { q: 'q9', opt: 'opt_9a' },
      { q: 'q10', opt: 'opt_10a' }
    ];

    for (const s of selections) {
      const ansRes = await harness.submitAnswer(sessionId, s.q, s.opt);
      assert.strictEqual(ansRes.status, 200);
      assert.strictEqual(ansRes.data.saved, true);
    }

    // Step 6: Monitor timer heartbeat
    const timerRes = await harness.getTimer(sessionId);
    assert.strictEqual(timerRes.data.status, 'IN_PROGRESS');
    assert.ok(timerRes.data.remainingSeconds > 1700);

    // Step 7: Clean manual exam submission
    const submitRes = await harness.submitExam(sessionId);
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitRes.data.status, 'SUBMITTED');
    assert.strictEqual(submitRes.data.score, 9, 'Should score 9 out of 10');
    assert.strictEqual(submitRes.data.total, 10);
    assert.strictEqual(submitRes.data.percentage, 90);

    // Step 8: Verify audit report is clean with 0 strikes
    const auditRes = await harness.getAuditReport(sessionId);
    assert.strictEqual(auditRes.data.session.strikeCount, 0);
    assert.strictEqual(auditRes.data.violations.length, 0);
    assert.strictEqual(auditRes.data.session.status, 'SUBMITTED');
  });

  // =========================================================================
  // Scenario 2: Cheating Detection, Strike Escalation & Auto-Disqualification
  // =========================================================================
  it('SCN-02: Cheating detection & disqualification (multiple face alerts, AI searches, strike disqualification)', async () => {
    const studentId = 'STUDENT-CHEATER-02';

    // Step 1: Start exam session
    const sessionRes = await harness.startSession(20, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Step 2: Answer 2 questions normally
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
    await harness.submitAnswer(sessionId, 'q2', 'opt_2b');

    // Step 3: Candidate leaves frame for 4 seconds -> Strike 1
    const v1 = await harness.sendViolation(sessionId, 'FACE_ABSENT', {
      durationMs: 4000,
      description: 'Candidate absent from camera view'
    });
    assert.strictEqual(v1.data.strikeCount, 1);
    assert.strictEqual(v1.data.action, 'WARN');

    // Step 4: Candidate opens guest tab to search Google
    const tab1 = harness.browser.createTab('https://www.google.com/search?q=mcq+question+1+bst+complexity');
    const q1 = BrowserMock.extractSearchQuery('https://www.google.com/search?q=mcq+question+1+bst+complexity');
    await harness.sendSearchEvent(sessionId, q1.service, q1.query, q1.url);

    // Step 5: Multiple faces appear in frame for 2 seconds -> Strike 2
    const mockSnapshot = 'data:image/webp;base64,' + Buffer.from('evidence_snapshot_2_faces').toString('base64');
    const v2 = await harness.sendViolation(sessionId, 'MULTIPLE_FACES', {
      faceCount: 2,
      durationMs: 2000
    }, mockSnapshot);
    assert.strictEqual(v2.data.strikeCount, 2);
    assert.strictEqual(v2.data.action, 'WARN');

    // Step 6: Candidate opens ChatGPT and asks for solutions
    const tab2 = harness.browser.createTab('https://chatgpt.com');
    const aiPrompt = BrowserMock.interceptAIPrompt('ChatGPT', 'Solve this technical question: what is contextBridge', 'https://chatgpt.com');
    await harness.sendSearchEvent(sessionId, aiPrompt.service, aiPrompt.query, aiPrompt.url);

    // Step 7: Candidate looks off-screen for 4 seconds -> Strike 3 (Disqualification!)
    const v3 = await harness.sendViolation(sessionId, 'EYE_GAZE_DIVERTED', {
      hgr: 0.12,
      durationMs: 4000
    });
    assert.strictEqual(v3.data.strikeCount, 3);
    assert.strictEqual(v3.data.action, 'DISQUALIFY');
    assert.strictEqual(v3.data.sessionStatus, 'DISQUALIFIED');

    // Step 8: Candidate attempts to submit answer to Question 3 -> REJECTED
    const lateAns = await harness.submitAnswer(sessionId, 'q3', 'opt_3b');
    assert.strictEqual(lateAns.status, 403);
    assert.match(lateAns.data.message, /disqualified/i);

    // Step 9: Auditor checks evidence trail
    const auditRes = await harness.getAuditReport(sessionId);
    assert.strictEqual(auditRes.data.session.status, 'DISQUALIFIED');
    assert.strictEqual(auditRes.data.violations.length, 3);
    assert.strictEqual(auditRes.data.searchEvents.length, 2);
    assert.strictEqual(auditRes.data.session.score, 2, 'Should grade the 2 answers before disqualification');
  });

  // =========================================================================
  // Scenario 3: Timer Expiration Auto-Submission Sweeper
  // =========================================================================
  it('SCN-03: Timer expiration auto-submission (student runs out of time, server auto-submits, late answer rejected)', async () => {
    const studentId = 'STUDENT-TIMEOUT-03';

    // Step 1: Start 0-minute session (immediate expiry)
    const sessionRes = await harness.startSession(0, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Step 2: Answer 2 questions before timeout
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
    await harness.submitAnswer(sessionId, 'q2', 'opt_2b');

    // Step 3: Wait for timer to pass expiry
    await new Promise(r => setTimeout(r, 30));

    // Step 4: Query timer -> background sweeper transitions state to AUTO_SUBMITTED_TIMEOUT
    const timerRes = await harness.getTimer(sessionId);
    assert.strictEqual(timerRes.data.status, 'AUTO_SUBMITTED_TIMEOUT');
    assert.strictEqual(timerRes.data.remainingSeconds, 0);

    // Step 5: Student attempts late answer -> 403 Forbidden
    const lateRes = await harness.submitAnswer(sessionId, 'q3', 'opt_3b');
    assert.strictEqual(lateRes.status, 403);
    assert.match(lateRes.data.message, /expired/i);

    // Step 6: Verify auto-graded score
    const auditRes = await harness.getAuditReport(sessionId);
    assert.strictEqual(auditRes.data.session.status, 'AUTO_SUBMITTED_TIMEOUT');
    assert.strictEqual(auditRes.data.session.score, 2, 'Auto-graded 2 submitted answers');
  });

  // =========================================================================
  // Scenario 4: Network Disconnection & Offline Answer Cache Sync
  // =========================================================================
  it('SCN-04: Network glitch & offline recovery (offline answer cache, sync on reconnect, score verification)', async () => {
    const studentId = 'STUDENT-OFFLINE-04';

    // Step 1: Start session online
    const sessionRes = await harness.startSession(30, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Step 2: Answer Question 1 online
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b');

    // Step 3: Network drops. Client caches answers in local storage / in-memory queue
    const offlineClientCache = [
      { questionId: 'q2', selectedOptionId: 'opt_2b', cachedAt: Date.now() },
      { questionId: 'q3', selectedOptionId: 'opt_3b', cachedAt: Date.now() + 500 },
      { questionId: 'q4', selectedOptionId: 'opt_4a', cachedAt: Date.now() + 1000 }
    ];

    // Step 4: Network restored. Client flushes cached answers to backend
    for (const cached of offlineClientCache) {
      const syncRes = await harness.submitAnswer(sessionId, cached.questionId, cached.selectedOptionId);
      assert.strictEqual(syncRes.status, 200);
      assert.strictEqual(syncRes.data.saved, true);
    }

    // Step 5: Answer Question 5 online
    await harness.submitAnswer(sessionId, 'q5', 'opt_5b');

    // Step 6: Student submits exam
    const submitRes = await harness.submitExam(sessionId);
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitRes.data.score, 5, 'All 5 questions (online + synced) evaluated correctly');
  });

  // =========================================================================
  // Scenario 5: Proctor Audit Review & Evidence Verification
  // =========================================================================
  it('SCN-05: Proctor audit review & evidence verification (timeline inspection, snapshot review, query table, HTML export)', async () => {
    const studentId = 'STUDENT-EVIDENCE-05';
    const sessionRes = await harness.startSession(30, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Simulate student actions
    await harness.submitAnswer(sessionId, 'q1', 'opt_1b');
    await harness.sendTabEvent(sessionId, 'TAB_NAVIGATE', 'https://en.wikipedia.org/wiki/Binary_search_tree', 'BST - Wikipedia');
    await harness.sendSearchEvent(sessionId, 'DuckDuckGo', 'what is binary search tree', 'https://duckduckgo.com/?q=what+is+binary+search+tree');

    const snapshotBase64 = 'data:image/webp;base64,' + Buffer.from('head_pose_diverted_evidence').toString('base64');
    await harness.sendViolation(sessionId, 'HEAD_POSE_DIVERTED', { yaw: 34.5 }, snapshotBase64);

    await harness.submitExam(sessionId);

    // Auditor logs in and reviews audit report
    const auditRes = await harness.getAuditReport(sessionId);
    assert.strictEqual(auditRes.status, 200);

    const data = auditRes.data;
    assert.strictEqual(data.session.sessionId, sessionId);
    assert.strictEqual(data.session.studentId, studentId);
    assert.strictEqual(data.summary.totalViolations, 1);
    assert.strictEqual(data.summary.totalTabSwitches, 1);
    assert.strictEqual(data.summary.totalSearchQueries, 1);

    // Verify snapshot evidence attached
    assert.strictEqual(data.violations[0].hasSnapshot, true);

    // Export HTML report for administrator archive
    const htmlRes = await harness.exportAuditHtml(sessionId);
    assert.strictEqual(htmlRes.status, 200);
    assert.ok(htmlRes.data.includes('Proctoring Audit Trail'));
    assert.ok(htmlRes.data.includes('HEAD_POSE_DIVERTED'));
  });

  // =========================================================================
  // Scenario 6: Question Flagging, Revision & Final Review Workflow
  // =========================================================================
  it('SCN-06: Answer revision, question flagging & review palette workflow', async () => {
    const studentId = 'STUDENT-REVISION-06';
    const sessionRes = await harness.startSession(30, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Step 1: Student answers Question 1 with Option A (incorrect) and flags for review
    const a1 = await harness.submitAnswer(sessionId, 'q1', 'opt_1a', true);
    assert.strictEqual(a1.status, 200);
    assert.strictEqual(a1.data.flagged, true);

    // Step 2: Student answers Question 2
    await harness.submitAnswer(sessionId, 'q2', 'opt_2b', false);

    // Step 3: Student returns to review flagged Question 1 and changes to Option B (correct), unflagging it
    const a1Revised = await harness.submitAnswer(sessionId, 'q1', 'opt_1b', false);
    assert.strictEqual(a1Revised.status, 200);
    assert.strictEqual(a1Revised.data.selectedOptionId, 'opt_1b');
    assert.strictEqual(a1Revised.data.flagged, false);

    // Step 4: Final submission
    const submitRes = await harness.submitExam(sessionId);
    assert.strictEqual(submitRes.data.score, 2, 'Revised answer (opt_1b) must be correctly evaluated in score');

    const q1Result = submitRes.data.results.find(r => r.questionId === 'q1');
    assert.strictEqual(q1Result.selectedOptionId, 'opt_1b');
    assert.strictEqual(q1Result.isCorrect, true);
  });

  // =========================================================================
  // Scenario 7: Multi-Tab Exploration & Mixed Search Navigation with Audit
  // =========================================================================
  it('SCN-07: Multi-tab exploration & mixed search navigation logged in audit trail', async () => {
    const studentId = 'STUDENT-MULTITAB-07';
    const sessionRes = await harness.startSession(30, studentId);
    const sessionId = sessionRes.data.sessionId;

    // Student opens 3 external search tabs
    const tabGoogle = harness.browser.createTab('https://www.google.com/search?q=heap+data+structure');
    const tabBing = harness.browser.createTab('https://www.bing.com/search?q=what+is+ear+metric');
    const tabDDG = harness.browser.createTab('https://duckduckgo.com/?q=quicksort');

    // Extract queries
    const qGoogle = BrowserMock.extractSearchQuery('https://www.google.com/search?q=heap+data+structure');
    const qBing = BrowserMock.extractSearchQuery('https://www.bing.com/search?q=what+is+ear+metric');
    const qDDG = BrowserMock.extractSearchQuery('https://duckduckgo.com/?q=quicksort');

    await harness.sendSearchEvent(sessionId, qGoogle.service, qGoogle.query, qGoogle.url);
    await harness.sendSearchEvent(sessionId, qBing.service, qBing.query, qBing.url);
    await harness.sendSearchEvent(sessionId, qDDG.service, qDDG.query, qDDG.url);

    // Switch back to assessment tab and submit
    harness.browser.switchTab(harness.browser.assessmentTabId);
    await harness.submitAnswer(sessionId, 'q5', 'opt_5b'); // Heap/LRU question
    await harness.submitExam(sessionId);

    // Auditor reviews all 3 intercepted searches
    const audit = await harness.getAuditReport(sessionId);
    assert.strictEqual(audit.data.searchEvents.length, 3);
    assert.strictEqual(audit.data.searchEvents[0].service, 'Google');
    assert.strictEqual(audit.data.searchEvents[1].service, 'Bing');
    assert.strictEqual(audit.data.searchEvents[2].service, 'DuckDuckGo');
  });
});
