/**
 * Electron Main Process Entry Point
 * Supervised embedded Express backend, single-instance lock, window & tab lifecycle.
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// An installed app's working directory is unpredictable (often read-only), so keep exams,
// attempts and certificates in the user's app-data folder. Must run before the backend
// config is loaded. `npm start` from the repo keeps using ./data.
if (app.isPackaged && !process.env.TRINETRA_DATA_DIR) {
  process.env.TRINETRA_DATA_DIR = path.join(app.getPath('userData'), 'data');
}

/**
 * Deployment settings from a trinetra.config.json next to the app executable or in its
 * user-data folder (the first one found wins):
 *   serverUrl        central exam server for candidate machines (skips the embedded one)
 *   databaseUrl      cloud PostgreSQL (e.g. Supabase) that mirrors every student's activity
 *   supabaseUrl,
 *   supabaseAnonKey  Supabase project used for "Continue with Google"
 * Environment variables of the same meaning take precedence.
 */
function readAppConfig() {
  const candidates = [path.join(path.dirname(process.execPath), 'trinetra.config.json')];
  try { candidates.push(path.join(app.getPath('userData'), 'trinetra.config.json')); } catch (_) {}
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
  }
  return {};
}

const appConfig = readAppConfig();
const BUNDLED_SUPABASE = { url: 'https://yttybuitwhrscfeabjxz.supabase.co', anonKey: 'sb_publishable_piTcmmumQu7M8T5r5NNSOA_ZgcdT4_y' };
if (!process.env.DATABASE_URL && appConfig.databaseUrl) process.env.DATABASE_URL = String(appConfig.databaseUrl);
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = String(appConfig.supabaseUrl || BUNDLED_SUPABASE.url);
if (!process.env.SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY = String(appConfig.supabaseAnonKey || BUNDLED_SUPABASE.anonKey);

const { startServer, stopServer } = require('../backend/server');
const windowManager = require('./windowManager');
const { tabManager } = require('./tabManager');
const { SearchTracker } = require('./searchTracker');
const ipcHandlers = require('./ipcHandlers');
const { IntegrityMonitor } = require('./integrityMonitor');
const { SearchPolicy } = require('./searchPolicy');
const packageJson = require('../../package.json');

/**
 * Central-server mode: candidate machines point at one exam server instead of running
 * their own (TRINETRA_SERVER_URL or "serverUrl" in trinetra.config.json). Without it, the
 * app runs its own embedded server (single laptop / LAN host).
 */
function resolveCentralServerUrl() {
  const url = process.env.TRINETRA_SERVER_URL || appConfig.serverUrl;
  return url ? String(url).replace(/\/+$/, '') : null;
}

// Check CLI flags
const isSmokeTest = process.argv.includes('--smoke-test');
const isInMemory = isSmokeTest || process.argv.includes('--in-memory');

// In CI/headless or smoke mode, disable hardware acceleration
if (isSmokeTest) {
  app.disableHardwareAcceleration();
  const smokeTimeout = setTimeout(() => {
    console.error('[SmokeTest] Failsafe timeout reached (10s). Terminating.');
    process.exit(1);
  }, 10000);
  smokeTimeout.unref();
}

// Single-instance lock enforcement
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock && !isSmokeTest) {
  console.warn('[Main] Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = windowManager.getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  let activeBackend = null;
  let integrityMonitor = null;
  let isShuttingDown = false;

  async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      if (integrityMonitor) integrityMonitor.stop();
      ipcHandlers.unregisterIpcHandlers();
      if (tabManager && typeof tabManager.destroy === 'function') {
        tabManager.destroy();
      }
      windowManager.destroyAllWindows();
      if (activeBackend) {
        await stopServer();
        activeBackend = null;
      }
    } catch (err) {
      console.error('[Main] Error during clean shutdown:', err);
    }
  }

  app.whenReady().then(async () => {
    try {
      // 0. Configure permissions for camera & media access
      const { session } = require('electron');
      if (session && session.defaultSession) {
        if (typeof session.defaultSession.setPermissionRequestHandler === 'function') {
          session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
            callback(true);
          });
        }
        if (typeof session.defaultSession.setPermissionCheckHandler === 'function') {
          session.defaultSession.setPermissionCheckHandler(() => true);
        }
      }

      // 1. Use the central exam server if configured, otherwise boot the embedded backend
      const centralUrl = resolveCentralServerUrl();
      let backendUrl;
      if (centralUrl) {
        backendUrl = centralUrl;
        console.log(`[Main] Using central exam server ${backendUrl}`);
      } else {
        activeBackend = await startServer({ inMemoryOnly: isInMemory });
        backendUrl = `http://127.0.0.1:${activeBackend.port}`;
      }
      const backendPort = activeBackend ? activeBackend.port : null;

      // 1b. Desktop-level integrity checks (displays, processes, focus, DevTools)
      const { screen } = require('electron');
      integrityMonitor = new IntegrityMonitor({ backendUrl, screen });
      app.on('web-contents-created', (_event, contents) => integrityMonitor.guardWebContents(contents));

      // 2. Initialize tracking and tab subsystems
      const searchTracker = new SearchTracker({ backendUrl });

      // 3. Initialize main window
      const mainWindow = windowManager.createMainWindow({
        backendPort,
        isSmokeTest,
        preloadPath: path.join(__dirname, '../preload/index.js')
      });
      integrityMonitor.attachWindow(mainWindow);

      // 4. Initialize tab manager (every guest navigation goes through the search policy)
      const searchPolicy = new SearchPolicy();
      tabManager.init(mainWindow, {
        searchPolicy,
        ...(centralUrl ? { backendUrl } : { backendPort }),
        preloadPath: path.join(__dirname, '../preload/guest-preload.js')
      });

      // 5. Register IPC communication
      ipcHandlers.registerIpcHandlers({
        mainWindow,
        backendPort,
        backendUrl,
        appVersion: packageJson.version || '1.0.0',
        tabManager,
        searchTracker,
        integrityMonitor,
        searchPolicy
      });

      if (isSmokeTest) {
        // Smoke verification: verify health endpoint
        const healthRes = await fetch(`${backendUrl}/api/health`);
        const healthData = await healthRes.json();
        if (healthData.status !== 'ok') {
          throw new Error(`Smoke health check failed: ${JSON.stringify(healthData)}`);
        }
        console.log(`[SmokeTest] PASSED: ${centralUrl ? `central server ${backendUrl}` : `embedded backend on port ${backendPort}`}, shell initialized cleanly.`);
        await gracefulShutdown();
        app.exit(0);
        return;
      }

      // 6. Load application renderer
      const rendererPath = path.join(__dirname, '../renderer/index.html');
      if (fs.existsSync(rendererPath)) {
        await mainWindow.loadFile(rendererPath);
      } else {
        await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>Smart Proctoring Browser</title>
              <style>
                body { background: #f8fafc; color: #0f172a; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              </style>
            </head>
            <body>
              <div style="text-align: center;">
                <h2>Smart Proctoring Browser</h2>
                <p>Milestone 2 Desktop Shell Active</p>
              </div>
            </body>
          </html>
        `)}`);
      }
    } catch (err) {
      console.error('[Main] Fatal application initialization error:', err);
      await gracefulShutdown();
      app.exit(1);
    }
  });

  app.on('window-all-closed', async () => {
    await gracefulShutdown();
    app.quit();
  });

  app.on('before-quit', async () => {
    await gracefulShutdown();
  });

  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}
