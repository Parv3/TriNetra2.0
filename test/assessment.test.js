const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

test.describe('Assessment Engine & Scoring Suite', () => {
  let server;
  let baseUrl;
  let authToken;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    datastore.addCandidate({
      id: 'STU-001',
      name: 'Alex Rivera',
      email: 'alex.rivera@university.edu',
      rollNo: 'CS-2026-042',
      faceRegistered: true
    });
    datastore.setQuestions([
      {
        id: 'q1',
        category: 'CS',
        difficulty: 'medium',
        prompt: 'Which IPC mechanism in Node.js allows shared memory?',
        text: 'Which IPC mechanism in Node.js allows shared memory?',
        options: [
          { id: 'opt_a', text: 'SharedArrayBuffer with Atomics' },
          { id: 'opt_b', text: 'ChildProcess pipes' }
        ],
        correctOptionId: 'opt_a',
        explanation: 'SharedArrayBuffer allows threads to share memory directly.',
        marks: 2,
        negativeMarks: 0.5
      },
      {
        id: 'q2',
        category: 'Security',
        difficulty: 'easy',
        prompt: 'Which Electron setting prevents renderer node access?',
        text: 'Which Electron setting prevents renderer node access?',
        options: [
          { id: 'opt_a', text: 'nodeIntegration: false' },
          { id: 'opt_b', text: 'webSecurity: false' }
        ],
        correctOptionId: 'opt_a',
        explanation: 'Disabling nodeIntegration blocks node APIs in renderer.',
        marks: 2,
        negativeMarks: 0.5
      }
    ]);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Authenticate and get bearer token
    await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu' })
    });
    const authRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu', otp: '123456' })
    });
    const authData = await authRes.json();
    authToken = authData.token;
  });

  test.after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('POST /api/assessment/session/start initializes session and sanitizes questions', async () => {
    const res = await fetch(`${baseUrl}/api/assessment/session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ durationMinutes: 10, candidateId: 'STU-001' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.session || data.sessionId);
    const session = data.session || data;
    assert.strictEqual(session.status, 'IN_PROGRESS');

    const questions = data.questions || [];
    assert.ok(questions.length > 0);
    // Verify strict sanitization: no answers or explanations exposed
    for (const q of questions) {
      assert.strictEqual(q.correctOptionId, undefined, 'correctOptionId must be omitted');
      assert.strictEqual(q.explanation, undefined, 'explanation must be omitted');
    }
  });

  test('POST /api/assessment/answer incrementally saves student choices', async () => {
    const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ durationMinutes: 10, candidateId: 'STU-001' })
    });
    const startData = await startRes.json();
    const sessionId = startData.session ? startData.session.id : startData.sessionId;

    const ansRes = await fetch(`${baseUrl}/api/assessment/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_a' })
    });
    assert.strictEqual(ansRes.status, 200);
    const ansData = await ansRes.json();
    assert.ok(ansData.saved);

    const session = datastore.getSession(sessionId);
    const savedOption = typeof session.answers.q1 === 'object' ? session.answers.q1.selectedOptionId : session.answers.q1;
    assert.strictEqual(savedOption, 'opt_a');
  });

  test('POST /api/assessment/submit computes score, accuracy, and marks SUBMITTED', async () => {
    const startRes = await fetch(`${baseUrl}/api/assessment/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ durationMinutes: 10, candidateId: 'STU-001' })
    });
    const startData = await startRes.json();
    const sessionId = startData.session ? startData.session.id : startData.sessionId;

    // Answer q1 correctly (opt_a) and q2 incorrectly (opt_b)
    await fetch(`${baseUrl}/api/assessment/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId, questionId: 'q1', selectedOptionId: 'opt_a' })
    });
    await fetch(`${baseUrl}/api/assessment/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId, questionId: 'q2', selectedOptionId: 'opt_b' })
    });

    const submitRes = await fetch(`${baseUrl}/api/assessment/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId })
    });
    assert.strictEqual(submitRes.status, 200);
    const submitData = await submitRes.json();
    assert.strictEqual(submitData.status, 'SUBMITTED');

    // q1 correct (+2), q2 incorrect (-0.5) => score = 1.5
    const score = submitData.score !== undefined ? submitData.score : submitData.summary.score;
    assert.strictEqual(score, 1.5);
  });
});
