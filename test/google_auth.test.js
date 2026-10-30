const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../src/backend/app');
const authService = require('../src/backend/services/authService');
const config = require('../src/backend/config');
const datastore = require('../src/backend/db/datastore');

// Stands in for Supabase Auth: one Google user, reachable by access or refresh token.
function fakeSupabase(calls) {
  return async (url, init = {}) => {
    calls.push(url);
    const auth = (init.headers && init.headers.Authorization) || '';
    const ok = (data) => ({ ok: true, json: async () => data });
    const user = { email: 'Asha.Rao@gmail.com', user_metadata: { full_name: 'Asha Rao', avatar_url: 'https://x/a.png' } };
    if (url.endsWith('/auth/v1/user') && auth === 'Bearer good-access') return ok(user);
    if (url.includes('grant_type=refresh_token') && JSON.parse(init.body).refresh_token === 'refresh-1') {
      return ok({ access_token: 'good-access', refresh_token: 'refresh-2', user });
    }
    if (url.endsWith('/auth/v1/settings')) return ok({ external: { email: true, google: false } });
    if (url.endsWith('/auth/v1/otp')) return ok({});
    if (url.endsWith('/auth/v1/verify') && JSON.parse(init.body).token === '123456') {
      return ok({ access_token: 'good-access', refresh_token: 'refresh-from-email', user });
    }
    return { ok: false, json: async () => ({ msg: 'invalid' }) };
  };
}

describe('Account sign-in via Supabase (email code and Google)', () => {
  let server;
  let baseUrl;
  const calls = [];
  const saved = {};

  const call = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };

  const post = async (body) => {
    const res = await fetch(`${baseUrl}/api/auth/google/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };

  before(async () => {
    await datastore.init({ inMemoryOnly: true });
    saved.url = config.SUPABASE_URL;
    saved.key = config.SUPABASE_ANON_KEY;
    config.SUPABASE_URL = 'https://demo.supabase.co';
    config.SUPABASE_ANON_KEY = 'anon';
    authService.fetchFn = fakeSupabase(calls);
    datastore.addCandidate({ id: 'G-OTHER', name: 'Someone Else', email: 'other@uni.edu', createdAt: Date.now() });
    datastore.addCandidate({ id: 'G-UNCLAIMED', name: 'Ravi Kumar', email: 'gunclaimed@candidate.local', createdAt: Date.now() });

    server = http.createServer(createApp({ inMemoryOnly: true }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    config.SUPABASE_URL = saved.url;
    config.SUPABASE_ANON_KEY = saved.key;
    authService.fetchFn = null;
    server.close();
  });

  test('reports the signed-in Google user without a roll number', async () => {
    const { status, data } = await post({ accessToken: 'good-access' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.google.email, 'asha.rao@gmail.com');
    assert.strictEqual(data.google.name, 'Asha Rao');
    assert.strictEqual(data.profile, null);
    assert.strictEqual(data.token, undefined);
  });

  test('creates a profile for a new roll number and issues a candidate token', async () => {
    const { status, data } = await post({ accessToken: 'good-access', rollNo: 'g-new-1', name: 'Asha Rao' });
    assert.strictEqual(status, 200);
    assert.ok(data.token);
    assert.strictEqual(data.session.authMethod, 'GOOGLE');
    assert.strictEqual(datastore.getCandidateById('G-NEW-1').email, 'asha.rao@gmail.com');
  });

  test('stays signed in: a refresh token signs in again and is rotated', async () => {
    const { status, data } = await post({ refreshToken: 'refresh-1', rollNo: 'G-NEW-1' });
    assert.strictEqual(status, 200);
    assert.ok(data.token);
    assert.strictEqual(data.refreshToken, 'refresh-2');
  });

  test('a Gmail linked to one roll number cannot take another', async () => {
    const { status, data } = await post({ accessToken: 'good-access', rollNo: 'G-NEW-2', name: 'Asha Rao' });
    assert.strictEqual(status, 409);
    assert.strictEqual(data.code, 'EMAIL_LINKED_ELSEWHERE');
  });

  test("refuses someone else's roll number", async () => {
    datastore.updateCandidate('G-NEW-1', { email: 'moved@uni.edu' });
    const { status, data } = await post({ accessToken: 'good-access', rollNo: 'G-OTHER', name: 'Asha Rao' });
    assert.strictEqual(status, 409);
    assert.strictEqual(data.code, 'ROLL_NO_TAKEN');
  });

  test('rejects an invalid Google session', async () => {
    const { status, data } = await post({ accessToken: 'forged', rollNo: 'G-UNCLAIMED', name: 'Ravi Kumar' });
    assert.strictEqual(status, 401);
    assert.strictEqual(data.code, 'GOOGLE_SESSION_INVALID');
    assert.ok(calls.some(u => u === 'https://demo.supabase.co/auth/v1/user'));
  });

  test('reports which sign-in methods are switched on', async () => {
    const { data } = await call('/api/auth/google/config');
    assert.deepStrictEqual(data, { enabled: true, email: true, google: false });
  });

  test('emails a code, refuses a quick resend, and signs in with the right code', async () => {
    const sent = await call('/api/auth/email/send', { email: 'Asha.Rao@gmail.com' });
    assert.strictEqual(sent.status, 200);
    assert.ok(calls.some(u => u.endsWith('/auth/v1/otp')));

    const again = await call('/api/auth/email/send', { email: 'asha.rao@gmail.com' });
    assert.strictEqual(again.status, 429);

    const wrong = await call('/api/auth/email/verify', { email: 'asha.rao@gmail.com', code: '000000' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.data.code, 'INVALID_CODE');

    const ok = await call('/api/auth/email/verify', { email: 'asha.rao@gmail.com', code: '123 456' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.google.email, 'asha.rao@gmail.com');
    assert.strictEqual(ok.data.refreshToken, 'refresh-from-email');
    assert.strictEqual(ok.data.token, undefined, 'verifying the email alone does not start an exam session');
  });

  test('rejects a malformed email address', async () => {
    const { status, data } = await call('/api/auth/email/send', { email: 'not-an-email' });
    assert.strictEqual(status, 400);
    assert.strictEqual(data.code, 'INVALID_EMAIL');
  });
});
