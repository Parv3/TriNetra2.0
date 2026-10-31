const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const proctorRoutes = require('./routes/proctorRoutes');
const auditRoutes = require('./routes/auditRoutes');
const assistRoutes = require('./routes/assistRoutes');
const referenceRoutes = require('./routes/referenceRoutes');

function createApp(options = {}) {
  const app = express();

  // CORS helper: Allow loopback, local network (LAN) clients, Electron internal protocols, and non-browser clients
  function isAllowedOrigin(origin) {
    if (!origin || origin === 'null') return true;
    if (origin.startsWith('file://')) return true;
    if (origin.startsWith('app://') || origin.startsWith('electron://') || origin.startsWith('vscode-file://')) return true;
    // Allow localhost, 127.0.0.1, IPv6 loopback
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return true;
    // Allow private IPv4 addresses (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
    if (/^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin)) return true;
    return false;
  }

  // A page served by this server calling its own API, e.g. the console on a cloud address
  // like https://trinetra.onrender.com (the Host header is the public name behind a proxy)
  function isSameOrigin(origin, req) {
    try {
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
      return Boolean(host) && new URL(origin).host.toLowerCase() === host;
    } catch (_) {
      return false;
    }
  }

  const corsOptions = {
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Session-Token', 'X-Dev-Candidate'],
    credentials: true
  };
  app.use(cors((req, callback) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin) || isSameOrigin(origin, req)) {
      return callback(null, { ...corsOptions, origin: true });
    }
    const err = new Error('CORS Not Allowed: Origin is untrusted');
    err.status = 403;
    err.code = 'CORS_NOT_ALLOWED';
    return callback(err);
  }));

  // JSON Body Parser with 10MB limit (essential for base64 webcam photos)
  app.use(express.json({ limit: config.BODY_SIZE_LIMIT || '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: config.BODY_SIZE_LIMIT || '10mb' }));

  // Static route for TensorFlow model weights
  app.use('/models', express.static(path.resolve(__dirname, '../../assets/models')));

  // Static route for Frontend Renderer UI (enables localhost browser preview)
  app.use(express.static(path.resolve(__dirname, '../renderer')));
  app.use('/app', express.static(path.resolve(__dirname, '../renderer')));
  app.use('/worker', express.static(path.resolve(__dirname, '../worker')));

  // Direct route for Admin / Proctor Dashboard
  app.get('/admin', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../renderer/admin.html'));
  });

  // Download page: lets candidates install the secure browser from the proctor's server (LAN)
  // or from the published release. The installer is looked up in TRINETRA_INSTALLER, then
  // ./release (a local build), then an "installer" folder next to the app executable.
  const findInstaller = () => {
    if (options.findLocalInstaller === false) return null;
    const fs = require('fs');
    const dirs = [path.resolve(process.cwd(), 'release'), path.join(path.dirname(process.execPath), 'installer')];
    if (process.env.TRINETRA_INSTALLER && fs.existsSync(process.env.TRINETRA_INSTALLER)) return process.env.TRINETRA_INSTALLER;
    for (const dir of dirs) {
      try {
        const exe = fs.readdirSync(dir).filter(f => /setup.*\.exe$/i.test(f)).sort().pop();
        if (exe) return path.join(dir, exe);
      } catch (_) {}
    }
    return null;
  };
  // Public install landing page (a separate, self-contained page)
  app.get(['/install', '/get'], (req, res) => {
    res.sendFile(path.resolve(__dirname, '../renderer/install.html'));
  });
  app.get('/download', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../renderer/download.html'));
  });
  // The newest installer published as a GitHub Release. Looked up here rather than in each
  // visitor's browser: GitHub allows 60 unauthenticated API calls an hour per network, which
  // a shared campus Wi-Fi uses up quickly. Cached for 10 minutes; a stale answer beats none.
  const RELEASE_REPO = process.env.TRINETRA_RELEASE_REPO || 'Parv3/TriNetra2.0';
  const RELEASES_PAGE = process.env.TRINETRA_RELEASE_URL || `https://github.com/${RELEASE_REPO}/releases/latest`;
  let releaseCache = { at: 0, asset: null };
  const latestReleaseAsset = async () => {
    if (releaseCache.asset && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache.asset;
    try {
      const fetchFn = options.fetchFn || fetch;
      const r = await fetchFn(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'trinetra-exam-server' },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const rel = await r.json();
        const exe = (rel.assets || []).find(a => /\.exe$/i.test(a.name));
        if (exe) releaseCache = { at: Date.now(), asset: { url: exe.browser_download_url, name: exe.name, sizeMb: Math.round(exe.size / 1048576), version: rel.tag_name } };
      }
    } catch (_) {}
    return releaseCache.asset;
  };

  app.get('/api/system/download', async (req, res) => {
    const file = findInstaller();
    let sizeMb = null;
    try { if (file) sizeMb = Math.round(require('fs').statSync(file).size / 1048576); } catch (_) {}
    const release = file ? null : await latestReleaseAsset();
    res.json({
      available: Boolean(file),
      fileName: file ? path.basename(file) : null,
      sizeMb,
      version: require('../../package.json').version,
      release,
      releaseUrl: RELEASES_PAGE
    });
  });

  // One fixed link for every download button: the installer on this server if there is one,
  // otherwise straight to the file in the latest GitHub Release.
  app.get('/download/latest', async (req, res) => {
    const file = findInstaller();
    if (file) return res.download(file, path.basename(file));
    const asset = await latestReleaseAsset();
    return res.redirect(302, asset ? asset.url : RELEASES_PAGE);
  });
  app.get('/download/installer.exe', (req, res) => {
    const file = findInstaller();
    if (!file) return res.status(404).send('No installer is available on this server.');
    res.download(file, path.basename(file));
  });

  // Request logger in development
  if (config.ENV === 'development') {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
      });
      next();
    });
  }

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      env: config.ENV
    });
  });

  // PostgreSQL mirror status (shown in the proctor console)
  app.get('/api/system/database', (req, res) => {
    const mirror = require('./db/postgresMirror');
    const { enabled, lastSavedAt, lastError } = require('./db/cloudState').status;
    res.status(200).json({ ...mirror.status, configured: Boolean(config.DATABASE_URL), stateStore: { enabled, lastSavedAt, lastError } });
  });

  // System Network Info endpoint (provides LAN IP and remote proctor URLs)
  app.get('/api/system/network', (req, res) => {
    const os = require('os');
    const nets = os.networkInterfaces();
    const interfaces = [];
    let preferredIp = '127.0.0.1';

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          interfaces.push({
            name,
            address: net.address
          });
          if (
            preferredIp === '127.0.0.1' ||
            name.toLowerCase().includes('wi-fi') ||
            name.toLowerCase().includes('wlan') ||
            name.toLowerCase().includes('wireless')
          ) {
            preferredIp = net.address;
          }
        }
      }
    }

    if (interfaces.length === 0) {
      interfaces.push({ name: 'Loopback', address: '127.0.0.1' });
    }

    const port = req.app.locals.httpPort || config.PORT || 4100;
    const httpsPort = req.app.locals.httpsPort || null;
    return res.status(200).json({
      success: true,
      preferredIp,
      port,
      httpsPort,
      adminUrl: `http://${preferredIp}:${port}/admin`,
      appUrl: `http://${preferredIp}:${port}/app/index.html`,
      // Candidates on other machines must use this one: browsers block the camera on plain http.
      candidateUrl: httpsPort ? `https://${preferredIp}:${httpsPort}/app/index.html` : null,
      interfaces
    });
  });

  // Mount API routers
  const activeAuthRoutes = options.authRoutes || authRoutes;
  const activeAssessmentRoutes = options.assessmentRoutes || assessmentRoutes;
  const activeProctorRoutes = options.proctorRoutes || proctorRoutes;
  const activeAuditRoutes = options.auditRoutes || auditRoutes;

  if (activeAuthRoutes) app.use('/api/auth', activeAuthRoutes);
  if (activeAssessmentRoutes) app.use('/api/assessment', activeAssessmentRoutes);
  if (activeProctorRoutes) app.use('/api/proctor', activeProctorRoutes);
  if (activeAuditRoutes) app.use('/api/audit', activeAuditRoutes);
  app.use('/api/assist', options.assistRoutes || assistRoutes);
  app.use('/api/reference', options.referenceRoutes || referenceRoutes);

  // 404 Handler
  app.use((req, res, next) => {
    res.status(404).json({
      success: false,
      error: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} not found`
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}

const defaultApp = createApp();

module.exports = defaultApp;
module.exports.createApp = createApp;
module.exports.app = defaultApp;
