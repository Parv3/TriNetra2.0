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
    return { ok: false, json: async () => ({ msg: 'invalid' }) };
  };
}

describe('Google sign-in via Supabase', () => {
  let server;
  let baseUrl;
  const calls = [];
  const saved = {};

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
});
