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

  app.use(cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      const err = new Error('CORS Not Allowed: Origin is untrusted');
      err.status = 403;
      err.code = 'CORS_NOT_ALLOWED';
      return callback(err);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Session-Token', 'X-Dev-Candidate'],
    credentials: true
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
  app.get('/download', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../renderer/download.html'));
  });
  app.get('/api/system/download', (req, res) => {
    const file = findInstaller();
    let sizeMb = null;
    try { if (file) sizeMb = Math.round(require('fs').statSync(file).size / 1048576); } catch (_) {}
    res.json({
      available: Boolean(file),
      fileName: file ? path.basename(file) : null,
      sizeMb,
      version: require('../../package.json').version,
      releaseUrl: process.env.TRINETRA_RELEASE_URL || 'https://github.com/Parv3/TriNetra2.0/releases/latest'
    });
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
    res.status(200).json({ ...mirror.status, configured: Boolean(config.DATABASE_URL) });
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
