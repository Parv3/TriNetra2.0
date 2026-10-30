const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const timerService = require('../src/backend/services/timerService');
const assessmentService = require('../src/backend/services/assessmentService');

test.describe('Milestone 1 Empirical Challenge & Adversarial Stress Suite', () => {
  let server;
  let baseUrl;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    timerService.stopSweeper();
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  // =========================================================================
  // Challenge Focus 1: Proctoring Strike Accumulation & Disqualification Engine
  // =========================================================================
  test.describe('Focus 1: Proctoring Strike Accumulation & Immediate Disqualification', () => {
    test('Standard session transitions to DISQUALIFIED immediately at 3 strikes and rejects further answers', async () => {
      // 1. Start a fresh active assessment session
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-01', durationMinutes: 15 })
      });
      assert.strictEqual(startRes.status, 200);
      const { sessionId } = await startRes.json();
      assert.ok(sessionId, 'Session ID must be returned');

      // Verify session starts IN_PROGRESS with 0 strikes
      let session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'IN_PROGRESS');
      assert.strictEqual(session.strikeCount || 0, 0);

      // 2. First Violation: NO_FACE -> Strike 1 (WARN)
      const v1Res = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'NO_FACE',
          message: 'Candidate face absent from frame',
          confidence: 0.95
        })
      });
      assert.strictEqual(v1Res.status, 200);
      const v1Data = await v1Res.json();
      assert.strictEqual(v1Data.strikeCount, 1);
      assert.strictEqual(v1Data.action, 'WARN');
      assert.strictEqual(v1Data.disqualified, false);
      session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'IN_PROGRESS');

      // Can still save answer after strike 1
      const ans1Res = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_1b' })
      });
      assert.strictEqual(ans1Res.status, 200);

      // 3. Second Violation: GAZE_DIVERSION -> Strike 2 (WARN)
      const v2Res = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'GAZE_DIVERSION',
          message: 'Candidate eyes looking offscreen'
        })
      });
      assert.strictEqual(v2Res.status, 200);
      const v2Data = await v2Res.json();
      assert.strictEqual(v2Data.strikeCount, 2);
      assert.strictEqual(v2Data.action, 'WARN');
      assert.strictEqual(v2Data.disqualified, false);
      session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'IN_PROGRESS');

      // 4. Third Violation: MULTIPLE_FACES -> Strike 3 (DISQUALIFY)
      const v3Res = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'MULTIPLE_FACES',
          message: 'Second person entered frame'
        })
      });
      assert.strictEqual(v3Res.status, 200);
      const v3Data = await v3Res.json();
      assert.strictEqual(v3Data.strikeCount, 3);
      assert.strictEqual(v3Data.action, 'DISQUALIFY');
      assert.strictEqual(v3Data.disqualified, true);
      assert.ok(v3Data.reason.includes('Exceeded maximum allowed proctoring violations'));

      // Verify persistent datastore status is DISQUALIFIED
      session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'DISQUALIFIED');
      assert.ok(session.submittedAt, 'Disqualification must set submittedAt');

      // 5. Verify answer mutation via POST /api/assessment/answer is REJECTED with HTTP 403
      const postAnsRes = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q2', selectedOptionId: 'opt_2b' })
      });
      assert.strictEqual(postAnsRes.status, 403);
      const postAnsData = await postAnsRes.json();
      assert.strictEqual(postAnsData.error, true);
      assert.strictEqual(postAnsData.code, 'SESSION_DISQUALIFIED');

      // 6. Verify answer mutation via PATCH /api/assessment/session/:id/answers is REJECTED with HTTP 403
      const patchAnsRes = await fetch(`${baseUrl}/api/assessment/session/${sessionId}/answers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: 'q2', selectedOptionId: 'opt_2b' })
      });
      assert.strictEqual(patchAnsRes.status, 403);
      const patchAnsData = await patchAnsRes.json();
      assert.strictEqual(patchAnsData.code, 'SESSION_DISQUALIFIED');

      // 7. Verify submission via POST /api/assessment/submit is REJECTED with HTTP 403
      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 403);
      const submitData = await submitRes.json();
      assert.strictEqual(submitData.code, 'SESSION_DISQUALIFIED');
    });

    test('immediateDisqualify flag forces instant disqualification on first infraction', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-02' })
      });
      const { sessionId } = await startRes.json();

      const violRes = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'UNAUTHORIZED_DEVICE',
          message: 'Secondary phone detected on desk',
          immediateDisqualify: true
        })
      });
      assert.strictEqual(violRes.status, 200);
      const violData = await violRes.json();
      assert.strictEqual(violData.action, 'DISQUALIFY');
      assert.strictEqual(violData.disqualified, true);

      const session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'DISQUALIFIED');
    });

    test('Oversized violation snapshots (>5MB) are rejected with HTTP 413', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-03' })
      });
      const { sessionId } = await startRes.json();

      // Create a 5.5MB mock base64 payload
      const hugeSnapshot = 'data:image/webp;base64,' + 'A'.repeat(5.5 * 1024 * 1024);

      const violRes = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'NO_FACE',
          snapshotBase64: hugeSnapshot
        })
      });
      assert.strictEqual(violRes.status, 413);
      const violData = await violRes.json();
      assert.strictEqual(violData.error, true);
    });

    test('Recording violation on already submitted session is rejected with HTTP 400', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-04' })
      });
      const { sessionId } = await startRes.json();

      // Submit session cleanly
      const subRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(subRes.status, 200);

      // Attempt violation on finalized session
      const violRes = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'GAZE_DIVERSION'
        })
      });
      assert.strictEqual(violRes.status, 400);
      const violData = await violRes.json();
      assert.strictEqual(violData.code, 'SESSION_TERMINATED');
    });

    test('Rapid concurrent violations accumulate strikes without race condition corruption', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-05' })
      });
      const { sessionId } = await startRes.json();

      // Fire 6 concurrent violations simultaneously
      const promises = Array.from({ length: 6 }).map((_, i) =>
        fetch(`${baseUrl}/api/proctor/violation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            type: 'GAZE_DIVERSION',
            message: `Concurrent violation ${i + 1}`
          })
        }).then(r => r.json())
      );

      const results = await Promise.all(promises);
      assert.strictEqual(results.length, 6);
      for (const res of results) {
        assert.strictEqual(res.recorded, true);
      }

      const session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'DISQUALIFIED');
      assert.strictEqual(session.strikeCount, 6);
      const recordedViolations = datastore.getViolationsBySession(sessionId);
      assert.strictEqual(recordedViolations.length, 6);
    });
  });

  // =========================================================================
  // Challenge Focus 2: Timer Sweeper & Automatic Timeout Auto-Submission
  // =========================================================================
  test.describe('Focus 2: Server-Authoritative Timer Sweeper & Automatic Timeout', () => {
    test('Server-authoritative timer reflects accurate remaining seconds and server timestamp', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-CHALLENGE-TIME-1', durationMinutes: 10 })
      });
      const { sessionId } = await startRes.json();

      const timerRes = await fetch(`${baseUrl}/api/assessment/session/${sessionId}/timer`);
      assert.strictEqual(timerRes.status, 200);
      const timerData = await timerRes.json();

      assert.strictEqual(timerData.sessionId, sessionId);
      assert.strictEqual(timerData.status, 'IN_PROGRESS');
      assert.ok(timerData.remainingSeconds >= 595 && timerData.remainingSeconds <= 600);
      assert.ok(timerData.serverTime > 0);
      assert.strictEqual(timerData.isExpired, false);
      assert.strictEqual(timerData.clockTampered, false);
    });

    test('Accessing timer for past-expiry session immediately auto-submits to AUTO_SUBMITTED_TIMEOUT', async () => {
      const sessionId = 'sess_challenge_expired_direct';
      datastore.createSession({
        id: sessionId,
        candidateId: 'STU-CHALLENGE-TIME-2',
        status: 'IN_PROGRESS',
        startedAt: Date.now() - 600000,
        expiresAt: Date.now() - 5000, // expired 5 seconds ago
        durationMinutes: 10,
        questionIds: ['q1', 'q2'],
        answers: {
          q1: { questionId: 'q1', selectedOptionId: 'opt_1b', savedAt: Date.now() - 50000 }
        }
      });

      const timerRes = await fetch(`${baseUrl}/api/assessment/session/${sessionId}/timer`);
      assert.strictEqual(timerRes.status, 200);
      const timerData = await timerRes.json();

      assert.strictEqual(timerData.status, 'AUTO_SUBMITTED_TIMEOUT');
      assert.strictEqual(timerData.remainingSeconds, 0);
      assert.strictEqual(timerData.isExpired, true);

      // Verify datastore session was graded and marked AUTO_SUBMITTED_TIMEOUT
      const session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'AUTO_SUBMITTED_TIMEOUT');
      assert.strictEqual(session.score, 1);
      assert.strictEqual(session.correctCount, 1);
      assert.strictEqual(session.unattemptedCount, 1);
    });

    test('Background sweeper automatically discovers and submits expired sessions without manual query', async () => {
      const s1 = 'sess_challenge_sweep_1';
      const s2 = 'sess_challenge_sweep_2';
      const s3 = 'sess_challenge_sweep_3';

      const pastExpiry = Date.now() - 2000;
      [s1, s2, s3].forEach(id => {
        datastore.createSession({
          id,
          candidateId: 'STU-SWEEP-BATCH',
          status: 'IN_PROGRESS',
          startedAt: pastExpiry - 60000,
          expiresAt: pastExpiry,
          durationMinutes: 1,
          questionIds: ['q1'],
          answers: {}
        });
      });

      // Run sweeper tick
      await timerService.checkTimeouts();

      // Check all 3 sessions
      for (const id of [s1, s2, s3]) {
        const s = datastore.getSession(id);
        assert.strictEqual(s.status, 'AUTO_SUBMITTED_TIMEOUT');
        assert.strictEqual(s.score, 0);
        assert.strictEqual(s.unattemptedCount, 1);
        assert.ok(s.submittedAt);
      }
    });

    test('Answer mutation after timer expiration is strictly rejected with HTTP 403', async () => {
      const sessionId = 'sess_challenge_expired_answering';
      datastore.createSession({
        id: sessionId,
        candidateId: 'STU-CHALLENGE-TIME-4',
        status: 'AUTO_SUBMITTED_TIMEOUT',
        startedAt: Date.now() - 600000,
        expiresAt: Date.now() - 1000,
        durationMinutes: 10,
        questionIds: ['q1', 'q2'],
        answers: {}
      });

      const postRes = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_1b' })
      });
      assert.strictEqual(postRes.status, 403);
      const postData = await postRes.json();
      assert.strictEqual(postData.code, 'SESSION_EXPIRED');

      const patchRes = await fetch(`${baseUrl}/api/assessment/session/${sessionId}/answers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: 'q1', selectedOptionId: 'opt_1b' })
      });
      assert.strictEqual(patchRes.status, 403);
      const patchData = await patchRes.json();
      assert.strictEqual(patchData.code, 'SESSION_EXPIRED');
    });

    test('Sweeper lifecycle starts and stops cleanly without dangling timer handles', () => {
      assert.strictEqual(timerService.isRunning, false);
      timerService.startSweeper();
      assert.strictEqual(timerService.isRunning, true);
      assert.ok(timerService.sweeperInterval);

      // Calling startSweeper again is idempotent
      timerService.startSweeper();
      assert.strictEqual(timerService.isRunning, true);

      // Stop sweeper cleanly
      timerService.stopSweeper();
      assert.strictEqual(timerService.isRunning, false);
      assert.strictEqual(timerService.sweeperInterval, null);
    });
  });

  // =========================================================================
  // Challenge Focus 3: Grading Precision Under Extreme Boundary Conditions
  // =========================================================================
  test.describe('Focus 3: Grading Precision Under Extreme Boundary Conditions', () => {
    test('Condition A: 0 attempted (all skipped) produces 0 score, 0% accuracy, and 100% unattempted', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-GRADE-0-ATTEMPTED' })
      });
      const { sessionId, questions } = await startRes.json();
      const totalQ = questions.length;
      assert.ok(totalQ >= 10, 'Expected at least 10 seeded questions');

      // Submit without saving any answer
      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 200);
      const data = await submitRes.json();

      assert.strictEqual(data.status, 'SUBMITTED');
      assert.strictEqual(data.score, 0);
      assert.strictEqual(data.percentage, 0);
      assert.strictEqual(data.summary.score, 0);
      assert.strictEqual(data.summary.maxScore, totalQ);
      assert.strictEqual(data.summary.accuracy, 0);
      assert.strictEqual(data.summary.correctCount, 0);
      assert.strictEqual(data.summary.incorrectCount, 0);
      assert.strictEqual(data.summary.unattemptedCount, totalQ);

      assert.strictEqual(data.results.length, totalQ);
      for (const r of data.results) {
        assert.strictEqual(r.isAttempted, false);
        assert.strictEqual(r.isCorrect, false);
        assert.strictEqual(r.selectedOptionId, null);
        assert.strictEqual(r.marksAwarded, 0);
        assert.ok(r.correctOptionId);
        assert.ok(r.explanation);
      }
    });

    test('Condition B: 100% all correct produces max score, 100% accuracy, and 0 unattempted', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-GRADE-ALL-CORRECT' })
      });
      const { sessionId, questions } = await startRes.json();
      const allQs = datastore.getAllQuestions();

      // Answer every question with its known correctOptionId
      for (const q of allQs) {
        const ansRes = await fetch(`${baseUrl}/api/assessment/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionId: q.id, selectedOptionId: q.correctOptionId })
        });
        assert.strictEqual(ansRes.status, 200);
      }

      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 200);
      const data = await submitRes.json();

      assert.strictEqual(data.status, 'SUBMITTED');
      assert.strictEqual(data.score, allQs.length);
      assert.strictEqual(data.percentage, 100);
      assert.strictEqual(data.summary.accuracy, 100);
      assert.strictEqual(data.summary.correctCount, allQs.length);
      assert.strictEqual(data.summary.incorrectCount, 0);
      assert.strictEqual(data.summary.unattemptedCount, 0);

      for (const r of data.results) {
        assert.strictEqual(r.isAttempted, true);
        assert.strictEqual(r.isCorrect, true);
        assert.strictEqual(r.marksAwarded, 1);
      }
    });

    test('Condition C: 100% all wrong produces 0 score (non-negative floor) and 0% accuracy', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-GRADE-ALL-WRONG' })
      });
      const { sessionId } = await startRes.json();
      const allQs = datastore.getAllQuestions();

      // Answer every question with an intentionally wrong option
      for (const q of allQs) {
        const wrongOption = q.options.find(opt => opt.id !== q.correctOptionId);
        const ansRes = await fetch(`${baseUrl}/api/assessment/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionId: q.id, selectedOptionId: wrongOption.id })
        });
        assert.strictEqual(ansRes.status, 200);
      }

      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 200);
      const data = await submitRes.json();

      assert.strictEqual(data.score, 0);
      assert.strictEqual(data.percentage, 0);
      assert.strictEqual(data.summary.accuracy, 0);
      assert.strictEqual(data.summary.correctCount, 0);
      assert.strictEqual(data.summary.incorrectCount, allQs.length);
      assert.strictEqual(data.summary.unattemptedCount, 0);

      for (const r of data.results) {
        assert.strictEqual(r.isAttempted, true);
        assert.strictEqual(r.isCorrect, false);
      }
    });

    test('Condition D: Partial answers (3 correct, 2 incorrect, 5 skipped) calculates precise 60.0% accuracy', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-GRADE-PARTIAL' })
      });
      const { sessionId } = await startRes.json();
      const allQs = datastore.getAllQuestions();

      // q1, q2, q3 -> correct
      for (let i = 0; i < 3; i++) {
        const q = allQs[i];
        await fetch(`${baseUrl}/api/assessment/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionId: q.id, selectedOptionId: q.correctOptionId })
        });
      }

      // q4, q5 -> incorrect
      for (let i = 3; i < 5; i++) {
        const q = allQs[i];
        const wrongOption = q.options.find(opt => opt.id !== q.correctOptionId);
        await fetch(`${baseUrl}/api/assessment/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionId: q.id, selectedOptionId: wrongOption.id })
        });
      }

      // q6..q10 -> skipped (unattempted)

      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 200);
      const data = await submitRes.json();

      assert.strictEqual(data.score, 3);
      assert.strictEqual(data.summary.maxScore, allQs.length);
      assert.strictEqual(data.summary.correctCount, 3);
      assert.strictEqual(data.summary.incorrectCount, 2);
      assert.strictEqual(data.summary.unattemptedCount, allQs.length - 5);
      // Accuracy = 3 / (3 + 2) = 60.0%
      assert.strictEqual(data.summary.accuracy, 60.0);
      assert.strictEqual(data.percentage, 30); // 3 out of 10
    });

    test('Submission idempotency returns identical result on repeated calls without state mutation', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-GRADE-IDEMPOTENT' })
      });
      const { sessionId } = await startRes.json();

      await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_1b' })
      });

      const call1 = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      }).then(r => r.json());

      const call2 = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      }).then(r => r.json());

      assert.strictEqual(call1.score, call2.score);
      assert.strictEqual(call1.status, call2.status);
      assert.strictEqual(call1.summary.accuracy, call2.summary.accuracy);
    });

    test('Invalid answer mutations (empty string, whitespace, non-existent option, non-existent question) are strictly rejected', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-INPUT-VALIDATION' })
      });
      const { sessionId } = await startRes.json();

      // Empty string
      const r1 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: '' })
      });
      assert.strictEqual(r1.status, 400);

      // Whitespace string
      const r2 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: '   ' })
      });
      assert.strictEqual(r2.status, 400);

      // Non-existent option
      const r3 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_bogus_999' })
      });
      assert.strictEqual(r3.status, 400);

      // Non-existent question
      const r4 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q_fake_123', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(r4.status, 404);
    });
  });

  // =========================================================================
  // Challenge Focus 4: Audit Report Completeness & Security Sanitization
  // =========================================================================
  test.describe('Focus 4: Audit Report Completeness & Security Sanitization', () => {
    test('Audit report aggregates all logged violations, queries, tab events, inputs, and question results', async () => {
      // 1. Start assessment session
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-AUDIT-COMPLETE', durationMinutes: 20 })
      });
      const { sessionId } = await startRes.json();

      // 2. Ingest 2 proctoring violations
      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'NO_FACE',
          message: 'Candidate head turned away from screen',
          snapshotBase64: 'data:image/webp;base64,mockFaceSnapshot'
        })
      });
      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'GAZE_DIVERSION',
          message: 'Gaze diversion offscreen detected'
        })
      });

      // 3. Ingest tab navigations (including external AI tool)
      await fetch(`${baseUrl}/api/proctor/tab-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'TAB_NAVIGATE',
          url: 'https://chatgpt.com/c/cheating-thread',
          title: 'ChatGPT'
        })
      });
      await fetch(`${baseUrl}/api/proctor/tab-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'TAB_SWITCH',
          url: 'https://docs.python.org/3/library',
          title: 'Python Standard Library'
        })
      });

      // 4. Ingest search/AI queries
      await fetch(`${baseUrl}/api/proctor/search-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          service: 'ChatGPT',
          query: 'give me answers to balanced binary search tree question',
          url: 'https://chatgpt.com'
        })
      });

      // 5. Ingest input activity (copy/paste attempt)
      await fetch(`${baseUrl}/api/proctor/input-activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'CLIPBOARD',
          details: { action: 'paste', textLength: 140 }
        })
      });

      // 6. Save an answer and submit
      await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_1b' })
      });
      await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });

      // 7. Fetch comprehensive audit report via GET /api/audit/session/:id/report
      const reportRes = await fetch(`${baseUrl}/api/audit/session/${sessionId}/report`);
      assert.strictEqual(reportRes.status, 200);
      const report = await reportRes.json();

      // Assert Candidate & Session
      assert.strictEqual(report.candidate.id, 'STU-AUDIT-COMPLETE');
      assert.strictEqual(report.session.sessionId, sessionId);
      assert.strictEqual(report.session.status, 'SUBMITTED');

      // Assert Violations Summary
      assert.strictEqual(report.violationSummary.totalViolations, 2);
      assert.strictEqual(report.violationSummary.byType['NO_FACE'], 1);
      assert.strictEqual(report.violationSummary.byType['GAZE_DIVERSION'], 1);
      assert.strictEqual(report.violations.length, 2);
      assert.strictEqual(report.violations[0].hasSnapshot, true);

      // Assert Tab & Search Activities
      assert.ok(report.tabActivitySummary.totalUrlsVisited >= 2);
      assert.ok(report.tabActivitySummary.aiToolVisits >= 1);
      assert.ok(report.tabActivitySummary.aiQueries.length >= 1);
      assert.strictEqual(report.tabActivitySummary.aiQueries[0].query, 'give me answers to balanced binary search tree question');

      // Assert Input Activities
      assert.strictEqual(report.inputSummary.copyPasteAttempts, 1);

      // Assert Question Evaluations
      assert.ok(report.questionResults.length >= 10);
      const q1Eval = report.questionResults.find(q => q.questionId === 'q1');
      assert.strictEqual(q1Eval.isAttempted, true);
      assert.strictEqual(q1Eval.isCorrect, true);

      // Assert Integrity Score degradation
      assert.ok(report.integrityScore.score < 60, 'Integrity score must degrade under heavy infractions');
      assert.strictEqual(report.integrityScore.rating, 'HIGH_RISK');
      assert.ok(report.integrityScore.flags.length >= 3);

      // Assert Chronological Timeline contains all events in ascending order
      assert.ok(report.timeline.length >= 6);
      for (let i = 1; i < report.timeline.length; i++) {
        assert.ok(report.timeline[i].timestamp >= report.timeline[i - 1].timestamp, 'Timeline must be monotonically sorted by timestamp');
      }
    });

    test('Printable HTML audit export rigorously escapes XSS injection vectors', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-XSS-TEST' })
      });
      const { sessionId } = await startRes.json();

      // Inject malicious HTML / script payloads across telemetry channels
      const xssScript = '<script>alert("XSS_INJECTION")</script>';
      const xssImg = '<img src=x onerror=alert("IMG_XSS")>';

      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type: 'NO_FACE',
          message: `Attempted bypass: ${xssScript}`
        })
      });

      await fetch(`${baseUrl}/api/proctor/search-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          service: 'ChatGPT',
          query: `prompt: ${xssImg}`,
          url: 'https://chatgpt.com'
        })
      });

      // Request HTML audit export
      const htmlRes = await fetch(`${baseUrl}/api/audit/session/${sessionId}/report?format=html`);
      assert.strictEqual(htmlRes.status, 200);
      assert.ok(htmlRes.headers.get('content-type').includes('text/html'));
      const html = await htmlRes.text();

      // Verify NO unescaped malicious tags exist in output
      assert.strictEqual(html.includes('<script>alert("XSS_INJECTION")</script>'), false, 'Raw script tag must NOT be in HTML');
      assert.strictEqual(html.includes('<img src=x onerror='), false, 'Raw img onerror tag must NOT be in HTML');

      // Verify properly escaped entity representations ARE present
      assert.ok(html.includes('&lt;script&gt;alert(&quot;XSS_INJECTION&quot;)&lt;/script&gt;') || html.includes('&lt;script&gt;'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(&quot;IMG_XSS&quot;)&gt;') || html.includes('&lt;img'));
    });

    test('Audit report returns HTTP 404 for unknown session ID', async () => {
      const res = await fetch(`${baseUrl}/api/audit/session/sess_unknown_9999/report`);
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error, true);
      assert.strictEqual(data.code, 'SESSION_NOT_FOUND');
    });

    test('Audit report ?since=<timestamp> accurately filters out historical entries', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'STU-SINCE-FILTER' })
      });
      const { sessionId } = await startRes.json();

      const t1 = 1000000;
      const t2 = 2000000;

      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type: 'NO_FACE', timestamp: t1 })
      });
      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type: 'GAZE_DIVERSION', timestamp: t2 })
      });

      // Filter since t2
      const res = await fetch(`${baseUrl}/api/audit/session/${sessionId}/report?since=${t2}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.violations.length, 1);
      assert.strictEqual(data.violations[0].type, 'GAZE_DIVERSION');
    });
  });
});
