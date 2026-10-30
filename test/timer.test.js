const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const timerService = require('../src/backend/services/timerService');

test.describe('Server-Authoritative Timer & Timeout Sweeper Suite', () => {
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

  test('GET /api/assessment/session/:id/timer returns server-authoritative countdown', async () => {
    const startedAt = Date.now();
    const durationMinutes = 10;
    const expiresAt = startedAt + durationMinutes * 60 * 1000;
    datastore.createSession({
      id: 'sess_timer_1',
      candidateId: 'STU-001',
      status: 'IN_PROGRESS',
      startedAt,
      durationMinutes,
      expiresAt,
      answers: {}
    });

    const res = await fetch(`${baseUrl}/api/assessment/session/sess_timer_1/timer`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.remainingSeconds > 590 && data.remainingSeconds <= 600);
    assert.strictEqual(data.status, 'IN_PROGRESS');
    assert.strictEqual(data.isExpired, false);
  });

  test('Sweeper auto-submits expired session to AUTO_SUBMITTED_TIMEOUT', async () => {
    // Create session expired 5 seconds ago
    const expiredAt = Date.now() - 5000;
    datastore.createSession({
      id: 'sess_expired_1',
      candidateId: 'STU-001',
      status: 'IN_PROGRESS',
      startedAt: expiredAt - 600000,
      durationMinutes: 10,
      expiresAt: expiredAt,
      questionIds: [],
      answers: {}
    });

    // Run sweeper tick
    await timerService.checkTimeouts();

    const session = datastore.getSession('sess_expired_1');
    assert.strictEqual(session.status, 'AUTO_SUBMITTED_TIMEOUT');
    assert.ok(session.submittedAt);
  });

  test('Answer mutation after expiration is rejected with HTTP 403', async () => {
    const res = await fetch(`${baseUrl}/api/assessment/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_expired_1',
        questionId: 'q1',
        selectedOptionId: 'opt_a'
      })
    });
    assert.strictEqual(res.status, 403);
  });
});
