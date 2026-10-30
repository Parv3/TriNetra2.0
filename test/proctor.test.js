const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

test.describe('Proctoring Telemetry Ingestion Suite', () => {
  let server;
  let baseUrl;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    datastore.createSession({
      id: 'sess_proctor_1',
      candidateId: 'STU-001',
      status: 'IN_PROGRESS',
      startedAt: Date.now(),
      durationMinutes: 10,
      expiresAt: Date.now() + 600000,
      strikeCount: 0,
      maxStrikes: 5,
      questionIds: [],
      answers: {}
    });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('POST /api/proctor/violation ingests NO_FACE and issues WARN', async () => {
    const res = await fetch(`${baseUrl}/api/proctor/violation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_proctor_1',
        type: 'NO_FACE',
        message: 'Candidate absent from webcam frame',
        snapshotBase64: 'data:image/webp;base64,mockAbsenceFrame'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.strikeCount, 1);
    assert.strictEqual(data.action, 'WARN');
    assert.strictEqual(data.disqualified, false);

    const violations = datastore.getViolationsBySession('sess_proctor_1');
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].type, 'NO_FACE');
  });

  test('Reaching 5 strikes auto-disqualifies session to DISQUALIFIED', async () => {
    // Send 3 more violations (strikes 2, 3, 4)
    for (let i = 2; i <= 4; i++) {
      const res = await fetch(`${baseUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess_proctor_1',
          type: 'GAZE_DIVERSION',
          message: `Gaze diversion ${i}`
        })
      });
      const data = await res.json();
      assert.strictEqual(data.action, 'WARN');
    }

    // 5th strike triggers disqualification
    const fifthRes = await fetch(`${baseUrl}/api/proctor/violation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_proctor_1',
        type: 'MULTIPLE_FACES',
        message: 'Multiple faces detected in frame'
      })
    });
    assert.strictEqual(fifthRes.status, 200);
    const fifthData = await fifthRes.json();
    assert.strictEqual(fifthData.strikeCount, 5);
    assert.strictEqual(fifthData.action, 'DISQUALIFY');
    assert.strictEqual(fifthData.disqualified, true);

    const session = datastore.getSession('sess_proctor_1');
    assert.strictEqual(session.status, 'DISQUALIFIED');
    assert.ok(session.submittedAt);
  });

  test('POST /api/proctor/tab-event logs tab navigation and detects AI domains', async () => {
    const res = await fetch(`${baseUrl}/api/proctor/tab-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_proctor_1',
        type: 'TAB_NAVIGATE',
        url: 'https://chatgpt.com/c/solve-exam',
        title: 'ChatGPT'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.recorded, true);
    assert.strictEqual(data.isFlaggedAiTool, true);
  });

  test('POST /api/proctor/search-event logs AI prompt query text', async () => {
    const res = await fetch(`${baseUrl}/api/proctor/search-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_proctor_1',
        service: 'ChatGPT',
        query: 'solve question 1 ipc nodejs',
        url: 'https://chatgpt.com'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.recorded, true);
    assert.strictEqual(data.flagged, true);
  });

  test('POST /api/proctor/input-activity records copy/paste events', async () => {
    const res = await fetch(`${baseUrl}/api/proctor/input-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess_proctor_1',
        type: 'CLIPBOARD',
        data: { action: 'paste', textLength: 85, targetElement: 'body' }
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.recorded, true);
  });
});
