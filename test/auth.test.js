const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

test.describe('Authentication & Biometric Verification Suite', () => {
  let server;
  let baseUrl;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    datastore.addCandidate({
      id: 'STU-001',
      name: 'Alex Rivera',
      email: 'alex.rivera@university.edu',
      rollNo: 'CS-2026-042',
      faceRegistered: false,
      createdAt: Date.now()
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

  test('POST /api/auth/otp/request with registered email returns 200 and OTP', async () => {
    const res = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.otp || data.devOtp);
  });

  test('POST /api/auth/otp/request with unregistered email returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unknown.user@university.edu' })
    });
    assert.strictEqual(res.status, 404);
  });

  test('POST /api/auth/otp/verify with valid OTP returns token and candidate', async () => {
    const reqRes = await fetch(`${baseUrl}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu' })
    });
    const { devOtp, otp } = await reqRes.json();
    const code = otp || devOtp;

    const verifyRes = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu', otp: code })
    });
    assert.strictEqual(verifyRes.status, 200);
    const data = await verifyRes.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.token);
    assert.strictEqual(data.candidate.id, 'STU-001');
  });

  test('POST /api/auth/otp/verify with invalid OTP returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alex.rivera@university.edu', otp: '999999' })
    });
    assert.strictEqual(res.status, 401);
  });

  test('POST /api/auth/face/verify registers candidate baseline photo', async () => {
    const res = await fetch(`${baseUrl}/api/auth/face/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU-001',
        candidateId: 'STU-001',
        imageBase64: 'data:image/jpeg;base64,mockFaceDataLongEnoughStringHere',
        faceSnapshot: 'data:image/jpeg;base64,mockFaceDataLongEnoughStringHere'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.faceVerified, true);
  });
});
