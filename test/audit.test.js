const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

test.describe('Audit Reporting & Export Suite', () => {
  let server;
  let baseUrl;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    datastore.addCandidate({
      id: 'STU-001',
      name: 'Alex Rivera',
      email: 'alex.rivera@university.edu',
      rollNo: 'CS-2026-042',
      baselinePhoto: 'data:image/jpeg;base64,mockBaseline'
    });
    datastore.createSession({
      id: 'sess_audit_1',
      candidateId: 'STU-001',
      status: 'SUBMITTED',
      startedAt: Date.now() - 600000,
      submittedAt: Date.now(),
      durationMinutes: 10,
      strikeCount: 2,
      score: 18,
      maxScore: 20,
      accuracy: 90.0,
      questionIds: [],
      answers: {}
    });

    datastore.addViolation({
      id: 'viol_1',
      sessionId: 'sess_audit_1',
      candidateId: 'STU-001',
      type: 'GAZE_DIVERSION',
      severity: 'WARNING',
      confidence: 0.95,
      message: 'Gaze diverted for 4s',
      snapshot: 'data:image/webp;base64,mockSnap',
      strikeNumber: 1,
      timestamp: Date.now() - 400000
    });

    datastore.addTabActivity({
      id: 'tab_1',
      sessionId: 'sess_audit_1',
      candidateId: 'STU-001',
      eventType: 'AI_SEARCH_QUERY',
      service: 'ChatGPT',
      domain: 'chatgpt.com',
      queryText: 'how to solve ipc',
      isFlaggedAiTool: true,
      timestamp: Date.now() - 300000
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

  test('GET /api/audit/session/:id/report returns comprehensive JSON report', async () => {
    const res = await fetch(`${baseUrl}/api/audit/session/sess_audit_1/report`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.candidate.name, 'Alex Rivera');
    assert.strictEqual(data.session.status, 'SUBMITTED');
    assert.strictEqual(data.violationSummary.totalViolations, 1);
    assert.strictEqual(data.tabActivitySummary.aiToolVisits, 1);

    // Verify timeline is sorted ascending by timestamp
    assert.ok(data.timeline && data.timeline.length > 0);
    for (let i = 1; i < data.timeline.length; i++) {
      assert.ok(data.timeline[i].timestamp >= data.timeline[i - 1].timestamp, 'Timeline must be chronological');
    }

    // Verify integrity score calculations
    assert.ok(typeof data.integrityScore.score === 'number');
    assert.ok(['LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK'].includes(data.integrityScore.rating));
  });

  test('GET /api/audit/session/:id/report?format=html returns standalone styled HTML', async () => {
    const res = await fetch(`${baseUrl}/api/audit/session/sess_audit_1/report?format=html`);
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType.includes('text/html'));

    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Smart Proctoring Audit Certificate'));
    assert.ok(html.includes('Alex Rivera'));
    assert.ok(html.includes('sess_audit_1'));
    assert.ok(html.includes('how to solve ipc'));
  });

  test('GET /api/proctor/export/:sessionId?format=html generates printable HTML report', async () => {
    const res = await fetch(`${baseUrl}/api/proctor/export/sess_audit_1?format=html`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('@media print'));
    assert.ok(html.includes('Chronological Audit Timeline'));
  });
});
