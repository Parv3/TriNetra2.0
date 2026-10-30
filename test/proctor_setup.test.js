const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

// First (owner) proctor account: only from the server's own computer, or with the host's setup key.
describe('Owner proctor setup', () => {
  let server;
  let baseUrl;
  const proxied = { 'X-Forwarded-For': '203.0.113.7' };

  const call = async (method, headers = {}, body) => {
    const res = await fetch(`${baseUrl}/api/auth/proctor/setup`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
  const owner = { name: 'Owner', email: 'owner@example.test', password: 'long-enough-1' };

  before(async () => {
    server = http.createServer(createApp({ inMemoryOnly: true }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    await datastore.init({ inMemoryOnly: true });
    delete process.env.TRINETRA_SETUP_KEY;
  });
  after(() => {
    delete process.env.TRINETRA_SETUP_KEY;
    server.close();
  });

  test('a request through a proxy is not treated as this computer', async () => {
    const info = await call('GET', proxied);
    assert.strictEqual(info.data.needsSetup, true);
    assert.strictEqual(info.data.fromThisComputer, false);
    assert.strictEqual(info.data.setupKeyRequired, false);

    const { status, data } = await call('POST', proxied, owner);
    assert.strictEqual(status, 403);
    assert.strictEqual(data.code, 'SETUP_LOCAL_ONLY');
  });

  test('with a setup key, a remote owner can set up only with the right key', async () => {
    process.env.TRINETRA_SETUP_KEY = 'k3y-from-render';
    assert.strictEqual((await call('GET', proxied)).data.setupKeyRequired, true);

    const wrong = await call('POST', proxied, { ...owner, setupKey: 'guess' });
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(wrong.data.code, 'BAD_SETUP_KEY');

    const right = await call('POST', proxied, { ...owner, setupKey: 'k3y-from-render' });
    assert.strictEqual(right.status, 201);
    assert.match(right.data.proctorId, /^PR-/);

    const again = await call('POST', proxied, { ...owner, setupKey: 'k3y-from-render' });
    assert.strictEqual(again.status, 409, 'only one owner account');
  });

  test('the server computer itself can still set up without a key', async () => {
    const { status } = await call('POST', {}, owner);
    assert.strictEqual(status, 201);
  });
});
