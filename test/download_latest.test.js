const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/backend/app');

// The install page's buttons all use /download/latest: the server looks up the newest GitHub
// Release itself (cached), so visitors on a shared network never hit GitHub's API limit.
describe('Download link for the install page', () => {
  let server;
  let base;
  let apiCalls = 0;
  let release = null;

  const fetchFn = async (url) => {
    apiCalls++;
    assert.match(url, /api\.github\.com\/repos\/Parv3\/TriNetra2\.0\/releases\/latest$/);
    if (!release) return { ok: false, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, json: async () => release };
  };

  before(async () => {
    server = http.createServer(createApp({ inMemoryOnly: true, fetchFn, findLocalInstaller: false }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('with no release yet, it falls back to the releases page', async () => {
    const res = await fetch(`${base}/download/latest`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://github.com/Parv3/TriNetra2.0/releases/latest');
  });

  test('with a release, it sends the browser straight to the .exe', async () => {
    release = {
      tag_name: 'v1.0.0',
      assets: [
        { name: 'latest.yml', size: 400, browser_download_url: 'https://example.test/latest.yml' },
        { name: 'Trinetra.Secure.Browser.Setup.1.0.0.exe', size: 122951252, browser_download_url: 'https://github.com/Parv3/TriNetra2.0/releases/download/v1.0.0/Trinetra.Secure.Browser.Setup.1.0.0.exe' }
      ]
    };
    const res = await fetch(`${base}/download/latest`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /releases\/download\/v1\.0\.0\/Trinetra\.Secure\.Browser\.Setup\.1\.0\.0\.exe$/);

    const info = await (await fetch(`${base}/api/system/download`)).json();
    assert.equal(info.release.version, 'v1.0.0');
    assert.equal(info.release.sizeMb, 117);
  });

  test('the release lookup is cached, not repeated for every visitor', async () => {
    const before = apiCalls;
    for (let i = 0; i < 5; i++) await fetch(`${base}/download/latest`, { redirect: 'manual' });
    assert.equal(apiCalls, before);
  });
});
