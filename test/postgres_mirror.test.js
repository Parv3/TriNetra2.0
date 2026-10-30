process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { newDb } = require('pg-mem');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');
const { PostgresMirror } = require('../src/backend/db/postgresMirror');

test.describe('PostgreSQL mirror for teachers', () => {
  let server;
  let baseUrl;
  let pool;
  let mirror;

  const call = async (method, path, body, token) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();
    mirror = new PostgresMirror();
    await mirror.init(pool);
    datastore.mirror = mirror;

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    datastore.mirror = null;
    await new Promise(resolve => server.close(resolve));
  });

  test('an attempt shows up in the teacher views', async () => {
    const exam = (await call('POST', '/api/assessment/exams', {
      title: 'SQL check', questions: [{ text: 'Which structure is FIFO?', options: ['Stack', 'Queue'], correctIndex: 1 }]
    })).body;

    await call('POST', '/api/auth/profile', { rollNo: 'PG001', name: 'Meera Nair', email: 'meera@college.test', institution: 'Test College' });
    const otp = (await call('POST', '/api/auth/otp/request', { studentId: 'PG001' })).body.otp;
    const token = (await call('POST', '/api/auth/otp/verify', { studentId: 'PG001', otp })).body.token;
    const sessionId = (await call('POST', '/api/assessment/session/start', { examId: exam.id, deviceId: 'dev_pg' }, token)).body.sessionId;

    await call('POST', '/api/assessment/answer', { sessionId, questionId: exam.questions[0].id, selectedOptionId: 'opt_b' });
    await call('POST', '/api/proctor/search-event', { sessionId, service: 'AI assistant', query: 'Tried to open chatgpt.com', url: 'https://chatgpt.com/', isFlaggedAiTool: true, blocked: true, blockReason: 'AI_SITE' });
    await call('POST', '/api/proctor/violation', { sessionId, type: 'PHONE_DETECTED', message: 'A phone is visible to the camera' });
    await call('POST', `/api/audit/session/${sessionId}/action`, { action: 'DISQUALIFY', reason: 'Phone in hand' });
    await call('POST', `/api/audit/session/${sessionId}/action`, { action: 'RESUME', reason: 'Checked recording' });

    mirror.pendingData = datastore.data;
    await mirror.flush();
    assert.equal(mirror.status.lastError, null);

    const attempt = (await pool.query(`SELECT * FROM trinetra.v_attempts WHERE roll_no = 'PG001'`)).rows[0];
    assert.equal(attempt.candidate_name, 'Meera Nair');
    assert.equal(attempt.exam, 'SQL check');
    assert.equal(attempt.status, 'IN_PROGRESS');
    assert.equal(Number(attempt.resume_count), 1);
    assert.ok(Number(attempt.ai_attempts) >= 1);

    const timeline = (await pool.query(`SELECT category, event FROM trinetra.v_student_timeline WHERE roll_no = 'PG001' ORDER BY occurred_at`)).rows;
    const categories = new Set(timeline.map(r => r.category));
    ['answer', 'search', 'violation', 'proctor'].forEach(c => assert.ok(categories.has(c), `timeline missing ${c}`));
    assert.ok(timeline.some(r => r.event === 'RESUMED'));

    // A second sync writes nothing new
    const before = mirror.status.rowsWritten;
    mirror.pendingData = datastore.data;
    await mirror.flush();
    assert.equal(mirror.status.rowsWritten, before);
  });
});
