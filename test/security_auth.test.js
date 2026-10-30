const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');
const { createApp } = require('../src/backend/app');
const authService = require('../src/backend/services/authService');
const config = require('../src/backend/config');
const datastore = require('../src/backend/db/datastore');
const websocketService = require('../src/backend/services/websocketService');

describe('Security & Role-Based Access Control Suite', () => {
  let server;
  let port;
  let baseUrl;
  let proctorToken;
  let candidateToken;

  before(async () => {
    await datastore.init({ inMemoryOnly: true });

    // Seed test candidate
    datastore.addCandidate({
      id: 'SEC-STU-001',
      name: 'Security Test Student',
      email: 'sec@test.edu',
      faceRegistered: false,
      createdAt: Date.now()
    });

    const app = createApp({ inMemoryOnly: true });
    server = http.createServer(app);
    websocketService.init(server, { datastore });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Cryptographic HMAC-SHA256 Token Signing & Validation', () => {
    test('1.1 signs and validates tokens with correct role payload', () => {
      const token = authService.signToken({
        sub: 'test-proctor',
        role: 'proctor',
        username: 'admin'
      });
      assert.ok(token.includes('.'));
      const parts = token.split('.');
      assert.strictEqual(parts.length, 3);

      const payload = authService.verifyToken(token);
      assert.ok(payload);
      assert.strictEqual(payload.role, 'proctor');
      assert.strictEqual(payload.sub, 'test-proctor');
    });

    test('1.2 rejects tampered tokens', () => {
      const token = authService.signToken({ sub: 'user1', role: 'candidate' });
      const parts = token.split('.');
      // Tamper with payload: change candidate to proctor
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'user1', role: 'proctor' })).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const verified = authService.verifyToken(tamperedToken);
      assert.strictEqual(verified, null);
    });

    test('1.3 rejects expired tokens', () => {
      const expiredToken = authService.signToken({
        sub: 'user-expired',
        role: 'candidate',
        exp: Math.floor(Date.now() / 1000) - 100 // 100s in past
      });

      const verified = authService.verifyToken(expiredToken);
      assert.strictEqual(verified, null);
    });
  });

  describe('2. Proctor Authentication & Login API', () => {
    test('2.1 rejects proctor login with missing or invalid credentials', async () => {
      const res1 = await fetch(`${baseUrl}/api/auth/proctor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(res1.status, 400);

      const res2 = await fetch(`${baseUrl}/api/auth/proctor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrongpassword' })
      });
      assert.strictEqual(res2.status, 401);
    });

    test('2.2 successfully logs in proctor with valid credentials and returns signed JWT', async () => {
      const res = await fetch(`${baseUrl}/api/auth/proctor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: config.PROCTOR_USERNAME,
          password: config.PROCTOR_PASSWORD
        })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.role, 'proctor');
      assert.ok(data.token);
      proctorToken = data.token;
    });

    test('2.3 candidate login via OTP returns signed candidate JWT', async () => {
      const otpRes = authService.requestOtp('SEC-STU-001');
      assert.ok(otpRes.success);
      const verifyRes = authService.verifyOtp('SEC-STU-001', '123456');
      assert.ok(verifyRes.token);
      candidateToken = verifyRes.token;

      const payload = authService.verifyToken(candidateToken);
      assert.strictEqual(payload.role, 'candidate');
      assert.strictEqual(payload.candidateId, 'SEC-STU-001');
    });

    test('2.4 GET /api/auth/me verifies current identity and role', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${proctorToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.authenticated, true);
      assert.strictEqual(data.role, 'proctor');
    });
  });

  describe('3. Role-Based Authorization on Administrative Endpoints', () => {
    test('3.1 candidate token cannot access proctor audit overview (HTTP 403)', async () => {
      const res = await fetch(`${baseUrl}/api/audit/overview`, {
        headers: { 'Authorization': `Bearer ${candidateToken}` }
      });
      assert.strictEqual(res.status, 403);
    });

    test('3.2 candidate token cannot create exams (HTTP 403)', async () => {
      const res = await fetch(`${baseUrl}/api/assessment/exams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${candidateToken}`
        },
        body: JSON.stringify({ title: 'Unauthorized Exam' })
      });
      assert.strictEqual(res.status, 403);
    });

    test('3.3 proctor token can successfully access audit overview and exams', async () => {
      const resOverview = await fetch(`${baseUrl}/api/audit/overview`, {
        headers: { 'Authorization': `Bearer ${proctorToken}` }
      });
      assert.strictEqual(resOverview.status, 200);

      const resExam = await fetch(`${baseUrl}/api/assessment/exams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${proctorToken}`
        },
        body: JSON.stringify({ title: 'Authorized Proctor Exam', durationMinutes: 20 })
      });
      assert.strictEqual(resExam.status, 201);
    });
  });

  describe('4. WebSocket Upgrade Authentication & Impersonation Prevention', () => {
    test('4.1 query parameter ?role=proctor without valid token is rejected in enforced auth mode', async () => {
      const prevEnforce = config.ENFORCE_AUTH;
      config.ENFORCE_AUTH = true;

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/proctor?role=proctor`);
        const closePromise = new Promise((resolve) => {
          ws.on('close', (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
          ws.on('error', () => {});
        });

        const result = await closePromise;
        assert.strictEqual(result.code, 4401);
        assert.ok(result.reason.includes('Unauthorized'));
      } finally {
        config.ENFORCE_AUTH = prevEnforce;
      }
    });

    test('4.2 valid proctor JWT allows proctor connection', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/proctor?role=proctor&token=${encodeURIComponent(proctorToken)}`);
      const msgPromise = new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          resolve(msg);
        });
        ws.on('error', reject);
      });

      const welcome = await msgPromise;
      assert.strictEqual(welcome.type, 'CONNECTED');
      assert.strictEqual(welcome.role, 'proctor');
      ws.close();
    });

    test('4.3 valid candidate token allows candidate telemetry connection', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/proctor?role=student&sessionId=sess_test_sec_1&token=${encodeURIComponent(candidateToken)}`);
      const msgPromise = new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          resolve(msg);
        });
        ws.on('error', reject);
      });

      const welcome = await msgPromise;
      assert.strictEqual(welcome.type, 'CONNECTED');
      assert.strictEqual(welcome.role, 'student');
      assert.strictEqual(welcome.sessionId, 'sess_test_sec_1');
      ws.close();
    });
  });
});
