const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/backend/app');
const datastore = require('../src/backend/db/datastore');

test.describe('Health & Server Configuration Suite', () => {
  let server;
  let baseUrl;

  test.before(async () => {
    await datastore.init({ inMemoryOnly: true });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('GET /api/health returns HTTP 200 with status ok and uptime', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
    assert.ok(typeof data.uptime === 'number');
    assert.ok(typeof data.timestamp === 'number');
  });

  test('CORS headers allow local loopback origins', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://localhost:3000' }
    });
    assert.strictEqual(res.status, 200);
    const allowOrigin = res.headers.get('access-control-allow-origin');
    assert.ok(allowOrigin === '*' || allowOrigin === 'http://localhost:3000');
  });

  test('Unknown route returns HTTP 404 with error payload', async () => {
    const res = await fetch(`${baseUrl}/api/non-existent-endpoint`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
  });
});
