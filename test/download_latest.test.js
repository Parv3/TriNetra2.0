const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/backend/app');

// The install page's buttons all use /download/latest: the server finds the newest GitHub
// Release itself (cached), so visitors on a shared network never hit GitHub's API limit, and
// when the server's own API calls are limited (cloud hosts share addresses) it uses GitHub's
// permanent link to the file in the latest release.
const API = 'https://api.github.com/repos/Parv3/TriNetra2.0/releases/latest';
const DIRECT = 'https://github.com/Parv3/TriNetra2.0/releases/latest/download/Trinetra.Secure.Browser.Setup.1.0.0.exe';
const ASSET = 'https://github.com/Parv3/TriNetra2.0/releases/download/v1.0.0/Trinetra.Secure.Browser.Setup.1.0.0.exe';
const RELEASE = {
  tag_name: 'v1.0.0',
  assets: [
    { name: 'latest.yml', size: 400, browser_download_url: 'https://example.test/latest.yml' },
    { name: 'Trinetra.Secure.Browser.Setup.1.0.0.exe', size: 122951252, browser_download_url: ASSET }
  ]
};

const servers = [];
async function serverWith(github) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    return github(url, init);
  };
  const server = http.createServer(createApp({ inMemoryOnly: true, fetchFn, findLocalInstaller: false }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}
const latest = (base) => fetch(`${base}/download/latest`, { redirect: 'manual' });
const ok = (body, headers = {}) => ({ ok: true, status: 200, json: async () => body, headers: new Map(Object.entries(headers)) });
const fail = (status) => ({ ok: false, status, json: async () => ({ message: 'nope' }), headers: new Map() });

describe('Download link for the install page', () => {
  after(() => servers.forEach(s => s.close()));

  test('with no release anywhere, it falls back to the releases page', async () => {
    const { base } = await serverWith(() => fail(404));
    const res = await latest(base);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://github.com/Parv3/TriNetra2.0/releases/latest');
  });

  test('with a release, it sends the browser straight to the .exe', async () => {
    const { base } = await serverWith((url) => (url === API ? ok(RELEASE) : fail(404)));
    const res = await latest(base);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), ASSET);
    const info = await (await fetch(`${base}/api/system/download`)).json();
    assert.equal(info.release.version, 'v1.0.0');
    assert.equal(info.release.sizeMb, 117);
  });

  test("when GitHub's API is rate-limited (as on Render), the permanent release link is used", async () => {
    const { base, calls } = await serverWith((url, init) => {
      if (url === API) return fail(403);
      if (url === DIRECT && init.method === 'HEAD') return ok(null, { 'content-length': '122951252' });
      return fail(404);
    });
    const res = await latest(base);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), DIRECT);
    assert.ok(calls.includes(`HEAD ${DIRECT}`), 'checked the file exists before linking to it');
    const info = await (await fetch(`${base}/api/system/download`)).json();
    assert.equal(info.release.sizeMb, 117);
  });

  test('the release lookup is cached, not repeated for every visitor', async () => {
    const { base, calls } = await serverWith((url) => (url === API ? ok(RELEASE) : fail(404)));
    for (let i = 0; i < 6; i++) await latest(base);
    assert.equal(calls.length, 1);
  });
});
