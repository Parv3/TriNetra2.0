/**
 * Local HTTPS for LAN candidates.
 * Browsers only allow camera access on secure origins (HTTPS or localhost), so a candidate
 * opening http://<this-laptop's-IP> on another laptop cannot turn their webcam on.
 * This creates a self-signed certificate for this machine's LAN addresses and reuses it
 * across restarts, so candidates accept the browser warning once per device.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(net => net && net.family === 'IPv4' && !net.internal)
    .map(net => net.address);
}

async function ensureCertificate(dataDir) {
  const dir = path.join(dataDir, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const metaFile = path.join(dir, 'meta.json');
  const ips = ['127.0.0.1', ...lanAddresses()].sort();
  const hosts = ['localhost', os.hostname()];

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const stillValid = meta.expiresAt > Date.now() + 7 * 24 * 3600 * 1000;
    const coversAll = ips.every(ip => meta.ips.includes(ip));
    if (stillValid && coversAll) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), ips };
    }
  } catch (_) {
    // first run, or files missing/corrupt — generate below
  }

  const selfsigned = require('selfsigned');
  const days = 365;
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Trinetra exam server' }, { name: 'organizationName', value: 'Trinetra' }],
    {
      days,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...hosts.map(value => ({ type: 2, value })), ...ips.map(ip => ({ type: 7, ip }))] }
      ]
    }
  );

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips, hosts, expiresAt: Date.now() + days * 24 * 3600 * 1000 }));
  return { key: pems.private, cert: pems.cert, ips };
}

module.exports = { ensureCertificate, lanAddresses };
