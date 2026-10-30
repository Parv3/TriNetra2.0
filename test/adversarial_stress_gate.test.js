const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const authService = require('../src/backend/services/authService');
const timerService = require('../src/backend/services/timerService');
const assessmentService = require('../src/backend/services/assessmentService');

test.describe('Challenger Gate Suite: Concurrency, Replay, Expiry, Payloads & Integrity', () => {
  let server;
  let baseUrl;
  let validToken;
  let validSessionId;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });

    // Seed test candidate
    datastore.addCandidate({
      id: 'CHALLENGER-CANDIDATE-01',
      name: 'Adversarial Challenger',
      email: 'challenger@university.edu',
      rollNo: 'CHALLENGE-2026-999',
      faceRegistered: true
    });

    // Seed test questions
    datastore.setQuestions([
      {
        id: 'q_chal_1',
        category: 'CS',
        difficulty: 'medium',
        prompt: 'What does atomic rename guarantee in POSIX/Windows?',
        text: 'What does atomic rename guarantee in POSIX/Windows?',
        options: [
          { id: 'opt_1a', text: 'All-or-nothing replacement' },
          { id: 'opt_1b', text: 'Partial file write' }
        ],
        correctOptionId: 'opt_1a',
        explanation: 'Atomic rename replaces the directory entry atomically.',
        marks: 2,
        negativeMarks: 0.5
      },
      {
        id: 'q_chal_2',
        category: 'Security',
        difficulty: 'hard',
        prompt: 'Why must OTPs be single-use?',
        text: 'Why must OTPs be single-use?',
        options: [
          { id: 'opt_2a', text: 'To prevent replay attacks' },
          { id: 'opt_2b', text: 'To save database memory' }
        ],
        correctOptionId: 'opt_2a',
        explanation: 'Single-use invalidation protects against eavesdropped replay.',
        marks: 2,
        negativeMarks: 0.5
      },
      {
        id: 'q_chal_3',
        category: 'Systems',
        difficulty: 'easy',
        prompt: 'Which timer clock prevents client manipulation?',
        text: 'Which timer clock prevents client manipulation?',
        options: [
          { id: 'opt_3a', text: 'Server-authoritative monotonic timer' },
          { id: 'opt_3b', text: 'Client Date.now()' }
        ],
        correctOptionId: 'opt_3a',
        explanation: 'Server-authoritative time prevents client tampering.',
        marks: 2,
        negativeMarks: 0
      }
    ]);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Generate valid session token
    const otpRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'challenger@university.edu' })
    });
    const otpData = await otpRes.json();
    const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'challenger@university.edu', otp: otpData.otp })
    });
    const verifyData = await verifyRes.json();
    validToken = verifyData.token;

    // Start baseline session
    const sessRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validToken}`
      },
      body: JSON.stringify({ durationMinutes: 30, candidateId: 'CHALLENGER-CANDIDATE-01' })
    });
    const sessData = await sessRes.json();
    validSessionId = sessData.sessionId;
  });

  test.after(async () => {
    timerService.stopSweeper();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Challenge Area 1: High Concurrency & Parallel Race Condition Probing
  // =========================================================================
  test.describe('Area 1: Concurrency & Parallel Race Stress', () => {
    test('1.1: 50 concurrent answer submissions across questions persist without corruption', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 30, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      const questions = ['q_chal_1', 'q_chal_2', 'q_chal_3'];
      const promises = [];

      for (let i = 0; i < 50; i++) {
        const qId = questions[i % questions.length];
        const optId = (i % 2 === 0) ? `${qId.replace('q_chal_', 'opt_')}a` : `${qId.replace('q_chal_', 'opt_')}b`;
        promises.push(
          fetch(`${baseUrl}/api/assessment/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
            body: JSON.stringify({ sessionId, questionId: qId, selectedOptionId: optId })
          })
        );
      }

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200, 'Every concurrent answer submission must succeed');
      }

      const session = datastore.getSession(sessionId);
      assert.ok(session, 'Session must exist');
      assert.ok(session.answers, 'Answers object must exist');
      assert.strictEqual(typeof session.answers.q_chal_1, 'object');
      assert.strictEqual(typeof session.answers.q_chal_2, 'object');
      assert.strictEqual(typeof session.answers.q_chal_3, 'object');
    });

    test('1.2: 30 parallel updates on identical question resolve cleanly without corruption', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 30, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      const promises = [];
      for (let i = 0; i < 30; i++) {
        const optId = (i % 2 === 0) ? 'opt_1a' : 'opt_1b';
        promises.push(
          fetch(`${baseUrl}/api/assessment/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
            body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: optId })
          })
        );
      }

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      const session = datastore.getSession(sessionId);
      const finalChoice = session.answers.q_chal_1.selectedOptionId;
      assert.ok(['opt_1a', 'opt_1b'].includes(finalChoice), 'Final choice must be a valid option');
    });

    test('1.3: 25 concurrent proctoring violations cleanly enforce disqualification threshold', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 30, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      const promises = [];
      for (let i = 0; i < 25; i++) {
        promises.push(
          fetch(`${baseUrl}/api/proctor/violation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              type: 'BURST_VIOLATION',
              message: `Concurrent violation ${i}`
            })
          })
        );
      }

      const responses = await Promise.all(promises);
      let warnCount = 0;
      let disqualifyCount = 0;

      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        if (data.action === 'WARN') warnCount++;
        if (data.action === 'DISQUALIFY') disqualifyCount++;
      }

      assert.ok(disqualifyCount >= 20, 'Violations beyond threshold must issue DISQUALIFY');
      const session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'DISQUALIFIED');
      assert.strictEqual(session.strikeCount, 25);
    });

    test('1.4: Mixed interleaved load (40 concurrent requests) maintains 100% service uptime', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 30, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      const mixed = [];
      for (let i = 0; i < 10; i++) {
        mixed.push(
          fetch(`${baseUrl}/api/assessment/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
            body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
          })
        );
        mixed.push(
          fetch(`${baseUrl}/api/proctor/tab-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, type: 'TAB_NAVIGATE', url: 'https://docs.nodejs.org' })
          })
        );
        mixed.push(fetch(`${baseUrl}/api/assessment/session/${sessionId}/timer`));
        mixed.push(
          fetch(`${baseUrl}/api/proctor/search-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, service: 'Google', query: 'node atomics' })
          })
        );
      }

      const results = await Promise.all(mixed);
      for (const r of results) {
        assert.strictEqual(r.status, 200, 'Interleaved request must succeed with 200');
      }

      const health = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(health.status, 200);
      const healthData = await health.json();
      assert.strictEqual(healthData.status, 'ok');
    });
  });

  // =========================================================================
  // Challenge Area 2: OTP Verification & Replay Attack Defense
  // =========================================================================
  test.describe('Area 2: OTP Replay Attacks & Auth Boundaries', () => {
    test('2.1: Sequential OTP replay is strictly rejected with HTTP 401', async () => {
      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu' })
      });
      const { otp } = await reqRes.json();

      const firstVerify = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      assert.strictEqual(firstVerify.status, 200);
      const firstData = await firstVerify.json();
      assert.ok(firstData.token);

      const replay1 = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      assert.strictEqual(replay1.status, 401, 'Replayed OTP must be rejected with 401');

      const replay2 = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      assert.strictEqual(replay2.status, 401, 'Second replay attempt must also be rejected with 401');
    });

    test('2.2: 15 concurrent OTP replay requests permit EXACTLY 1 success (race condition check)', async () => {
      datastore.addCandidate({
        id: 'RACE-STUDENT-01',
        name: 'Race Candidate',
        email: 'race@university.edu',
        rollNo: 'RACE-2026-001'
      });

      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'race@university.edu' })
      });
      const { otp } = await reqRes.json();

      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(
          fetch(`${baseUrl}/api/auth/otp/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'race@university.edu', otp })
          })
        );
      }

      const responses = await Promise.all(promises);
      const statuses = responses.map((r) => r.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const rejectedCount = statuses.filter((s) => s === 401).length;

      assert.strictEqual(successCount, 1, 'EXACTLY ONE concurrent OTP verification must succeed');
      assert.strictEqual(rejectedCount, 14, 'All 14 parallel replay attempts must be rejected with 401');
    });

    test('2.3: Master OTP 123456 requires prior request and cannot be replayed', async () => {
      datastore.addCandidate({
        id: 'UNREQUESTED-STU-01',
        name: 'No OTP Student',
        email: 'nootp@university.edu'
      });

      const unrequested = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nootp@university.edu', otp: '123456' })
      });
      assert.strictEqual(unrequested.status, 401, '123456 without prior OTP request must be rejected');

      await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nootp@university.edu' })
      });

      const first123456 = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nootp@university.edu', otp: '123456' })
      });
      assert.strictEqual(first123456.status, 200, 'First verify with 123456 succeeds');

      const replay123456 = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nootp@university.edu', otp: '123456' })
      });
      assert.strictEqual(replay123456.status, 401, 'Replaying 123456 must be rejected with 401');
    });

    test('2.4: Expired OTP is rejected with HTTP 401 OTP_EXPIRED', async () => {
      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu' })
      });
      const { otp } = await reqRes.json();

      const stored = authService.otpStore.get('challenger@university.edu');
      if (stored) {
        stored.expiresAt = Date.now() - 10000;
      }

      const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      assert.strictEqual(verifyRes.status, 401);
      const data = await verifyRes.json();
      assert.match(data.code || data.message, /EXPIRED/i);
    });

    test('2.5: Rapid invalid OTP brute force attempts are all rejected with HTTP 401', async () => {
      await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu' })
      });

      const guesses = ['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999'];
      const promises = guesses.map((g) =>
        fetch(`${baseUrl}/api/auth/otp/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'challenger@university.edu', otp: g })
        })
      );

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 401, 'Invalid OTP guess must return 401');
      }
    });
  });

  // =========================================================================
  // Challenge Area 3: Bearer Token Forgery, Expiration & Protection
  // =========================================================================
  test.describe('Area 3: Bearer Token Forgery, Expiration & Protection', () => {
    test('3.1: Forged and synthetic Bearer tokens are strictly rejected with HTTP 401', async () => {
      const forgedTokens = [
        'sess_tok_forged_uuid_12345678',
        'sess_tok_null',
        'admin_master_token',
        'Bearer eyJhbGciOiJIUzI1NiJ9.synthetic.payload',
        '123456'
      ];

      for (const token of forgedTokens) {
        const res = await fetch(`${baseUrl}/api/assessment/questions`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(res.status, 401, `Forged token "${token}" must be rejected with 401`);
        const data = await res.json();
        assert.strictEqual(data.error, 'INVALID_TOKEN');
      }
    });

    test('3.2: Malformed authorization headers return HTTP 401 UNAUTHORIZED', async () => {
      const malformedHeaders = [
        {},
        { 'Authorization': '' },
        { 'Authorization': 'Bearer ' },
        { 'Authorization': 'Basic dXNlcjpwYXNz' },
        { 'Authorization': 'Digest bad_auth' }
      ];

      for (const headers of malformedHeaders) {
        const res = await fetch(`${baseUrl}/api/assessment/questions`, { headers });
        assert.strictEqual(res.status, 401, 'Malformed auth header must return 401');
      }
    });

    test('3.3: Expired Bearer token fails validation with HTTP 401', async () => {
      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu' })
      });
      const { otp } = await reqRes.json();
      const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      const { token } = await verifyRes.json();

      const session = authService.tokenStore.get(token);
      assert.ok(session);
      session.expiresAt = Date.now() - 5000;

      const res = await fetch(`${baseUrl}/api/assessment/questions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      assert.strictEqual(res.status, 401, 'Expired Bearer token must return 401');
    });

    test('3.4: Revoked token via logout cannot access protected endpoints', async () => {
      const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu' })
      });
      const { otp } = await reqRes.json();
      const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'challenger@university.edu', otp })
      });
      const { token } = await verifyRes.json();

      const beforeLogout = await fetch(`${baseUrl}/api/assessment/questions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      assert.strictEqual(beforeLogout.status, 200);

      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      assert.strictEqual(logoutRes.status, 200);

      const afterLogout = await fetch(`${baseUrl}/api/assessment/questions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      assert.strictEqual(afterLogout.status, 401, 'Logged out token must be rejected with 401');
    });
  });

  // =========================================================================
  // Challenge Area 4: Timer Expiry, Grace Periods & Terminal State Guards
  // =========================================================================
  test.describe('Area 4: Timer Expiry & Terminal State Guards', () => {
    test('4.1: Answer mutation on AUTO_SUBMITTED_TIMEOUT session is rejected with HTTP 403', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 10, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      datastore.updateSession(sessionId, {
        status: 'AUTO_SUBMITTED_TIMEOUT',
        submittedAt: Date.now() - 5000
      });

      const res = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(res.status, 403, 'Late answer submission must be rejected with 403');
      const data = await res.json();
      assert.match(data.message || data.code, /expired/i);
    });

    test('4.2: Answer submission past wall-clock expiry + grace period triggers immediate 403', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 10, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      datastore.updateSession(sessionId, {
        expiresAt: Date.now() - 10000
      });

      const res = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(res.status, 403, 'Natural expiry past grace period must reject answer with 403');

      const session = datastore.getSession(sessionId);
      assert.strictEqual(session.status, 'AUTO_SUBMITTED_TIMEOUT');
    });

    test('4.3: Answer mutation after manual submission returns HTTP 400 SESSION_SUBMITTED', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 10, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId })
      });
      assert.strictEqual(submitRes.status, 200);

      const ansRes = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(ansRes.status, 400, 'Answer after submission must return 400');
    });

    test('4.4: Answer mutation after proctor disqualification returns HTTP 403 SESSION_DISQUALIFIED', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 10, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type: 'V1' })
      });
      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type: 'V2' })
      });
      await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, type: 'V3' })
      });

      const ansRes = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(ansRes.status, 403, 'Answer on disqualified session must return 403');
    });

    test('4.5: Concurrent double submit evaluates idempotently with identical score', async () => {
      const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 10, candidateId: 'CHALLENGER-CANDIDATE-01' })
      });
      const { sessionId } = await startRes.json();

      await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          fetch(`${baseUrl}/api/assessment/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
            body: JSON.stringify({ sessionId })
          })
        );
      }

      const responses = await Promise.all(promises);
      const scores = [];
      for (const res of responses) {
        assert.strictEqual(res.status, 200, 'Each concurrent submit must return 200');
        const data = await res.json();
        assert.strictEqual(data.status, 'SUBMITTED');
        scores.push(data.score !== undefined ? data.score : data.summary.score);
      }

      const firstScore = scores[0];
      assert.strictEqual(firstScore, 2, 'Score for q_chal_1 correct is 2');
      for (const s of scores) {
        assert.strictEqual(s, firstScore, 'All concurrent submits must return identical score');
      }
    });
  });

  // =========================================================================
  // Challenge Area 5: Malformed Payloads, Oversized JSON & Fuzzing
  // =========================================================================
  test.describe('Area 5: Malformed Payloads, Fuzzing & Crash Resilience', () => {
    test('5.1: Empty JSON payloads across 9 critical endpoints return HTTP 400 without crashing', async () => {
      const endpoints = [
        { path: '/api/auth/otp/request', method: 'POST' },
        { path: '/api/auth/otp/verify', method: 'POST' },
        { path: '/api/auth/face/verify', method: 'POST' },
        { path: '/api/assessment/answer', method: 'POST' },
        { path: '/api/assessment/submit', method: 'POST' },
        { path: '/api/proctor/violation', method: 'POST' },
        { path: '/api/proctor/tab-event', method: 'POST' },
        { path: '/api/proctor/search-event', method: 'POST' },
        { path: '/api/proctor/input-activity', method: 'POST' }
      ];

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
          body: JSON.stringify({})
        });
        assert.strictEqual(
          res.status,
          400,
          `Endpoint ${ep.method} ${ep.path} with empty body must reject with HTTP 400, got ${res.status}`
        );
      }
    });

    test('5.2: Type confusion fuzzing payloads are rejected safely without 500 error', async () => {
      const res1 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({
          sessionId: 999999,
          questionId: ['q_chal_1'],
          selectedOptionId: { choice: 'opt_1a' }
        })
      });
      assert.ok([400, 404].includes(res1.status), 'Invalid types in answer body must return 400 or 404');

      const res2 = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: -500 })
      });
      assert.strictEqual(res2.status, 400, 'Negative duration must return 400');

      const res3 = await fetch(`${baseUrl}/api/assessment/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ durationMinutes: 'not-a-number' })
      });
      assert.strictEqual(res3.status, 400, 'Non-numeric duration must return 400');
    });

    test('5.3: Oversized snapshot (>5MB) in violation payload is rejected with HTTP 413', async () => {
      const oversizedSnapshot = 'data:image/webp;base64,' + 'A'.repeat(5.5 * 1024 * 1024);

      const res = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: validSessionId,
          type: 'OVERSIZED_PROBE',
          snapshotBase64: oversizedSnapshot
        })
      });

      assert.strictEqual(res.status, 413, 'Oversized snapshot >5MB must be rejected with HTTP 413');
    });

    test('5.4: Prototype pollution and XSS injection payloads do not compromise data integrity', async () => {
      await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: 'pollution_probe',
          __proto__: { pollutedAdmin: true }
        })
      });
      assert.strictEqual(Object.prototype.pollutedAdmin, undefined, 'Object prototype must NOT be polluted');

      const xssRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: '<script>alert("xss")</script>' })
      });
      assert.strictEqual(xssRes.status, 400, 'Special characters < > { } in studentId must return 400');

      const searchRes = await fetch(`${baseUrl}/api/proctor/search-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: validSessionId,
          service: 'ChatGPT',
          query: '<img src=x onerror=alert(1)>'
        })
      });
      assert.strictEqual(searchRes.status, 200);

      const exportRes = await fetch(`${baseUrl}/api/proctor/export/${validSessionId}?format=html`);
      assert.strictEqual(exportRes.status, 200);
      const html = await exportRes.text();
      assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'Raw unescaped script tag must not appear in HTML');
      assert.ok(html.includes('&lt;img') || html.includes('&#039;'), 'HTML special characters must be properly escaped');
    });

    test('5.5: Non-existent entities return HTTP 404 without crashing backend', async () => {
      const r1 = await fetch(`${baseUrl}/api/assessment/session/sess_non_existent_9999/timer`);
      assert.strictEqual(r1.status, 404);

      const r2 = await fetch(`${baseUrl}/api/audit/session/sess_non_existent_9999/report`);
      assert.strictEqual(r2.status, 404);

      const r3 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId: 'sess_non_existent_9999', questionId: 'q_chal_1', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(r3.status, 404);

      const r4 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId: validSessionId, questionId: 'q_does_not_exist', selectedOptionId: 'opt_1a' })
      });
      assert.strictEqual(r4.status, 404);

      const r5 = await fetch(`${baseUrl}/api/assessment/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${validToken}` },
        body: JSON.stringify({ sessionId: validSessionId, questionId: 'q_chal_1', selectedOptionId: 'opt_fake_option' })
      });
      assert.strictEqual(r5.status, 400);
    });
  });
});
