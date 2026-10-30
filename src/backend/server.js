const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const datastore = require('./db/datastore');
const { seedInitialData } = require('./db/seed');

let activeServer = null;
let activeHttpsServer = null;

/**
 * Second listener over HTTPS for candidates on other machines (camera access needs a
 * secure origin). Same app and WebSocket service; failures here never block startup.
 */
async function startHttpsServer(app, host, preferredPort) {
  if (config.ENV === 'test' || process.env.TRINETRA_DISABLE_HTTPS === '1') return null;
  try {
    const https = require('https');
    const { ensureCertificate } = require('./tls');
    const tls = await ensureCertificate(config.DATA_DIR);
    const server = https.createServer({ key: tls.key, cert: tls.cert }, app);
    for (const port of [preferredPort, 0]) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
        });
        return server;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
  } catch (err) {
    console.warn('[Backend] HTTPS listener unavailable:', err.message);
  }
  return null;
}

async function startServer(options = {}) {
  const preferredPort = options.port !== undefined ? options.port : config.PORT;
  const host = options.host || config.HOST;
  const inMemoryOnly = options.inMemoryOnly ?? (config.ENV === 'test');

  // Initialize DataStore & Seed Initial Records
  await datastore.init({ inMemoryOnly, filePath: options.dbPath });

  // Hosts without a persistent disk keep the state in PostgreSQL (db/cloudState.js).
  // If it can't be loaded, saving stays off so an empty start never overwrites saved exams.
  const stateDbUrl = options.stateDatabaseUrl !== undefined
    ? options.stateDatabaseUrl
    : (process.env.TRINETRA_STATE_IN_DB === '1' ? config.DATABASE_URL : '');
  if (stateDbUrl) {
    const cloudState = require('./db/cloudState');
    try {
      await cloudState.init(stateDbUrl);
      const saved = await cloudState.load();
      if (saved) datastore.data = { ...datastore._createEmptyState(), ...saved };
      datastore.cloudState = cloudState;
      console.log(`[Backend] State stored in PostgreSQL (${saved ? 'restored saved state' : 'nothing saved yet'})`);
    } catch (err) {
      cloudState.status.lastError = err.message;
      console.error('[Backend] Could not load state from PostgreSQL; running without saving:', err.message);
    }
  }

  await seedInitialData(datastore);

  // Mirror student activity into PostgreSQL when DATABASE_URL is set.
  const databaseUrl = options.databaseUrl !== undefined ? options.databaseUrl : config.DATABASE_URL;
  if (databaseUrl) {
    const mirror = require('./db/postgresMirror');
    try {
      await mirror.init(databaseUrl);
      datastore.mirror = mirror;
      mirror.schedule(datastore.data);
      console.log('[Backend] PostgreSQL mirror enabled (schema "trinetra")');
    } catch (err) {
      mirror.status.lastError = err.message;
      console.warn('[Backend] PostgreSQL mirror disabled:', err.message);
    }
  }

  const app = createApp(options);
  const server = http.createServer(app);

  // Dynamic port negotiation with retry fallback
  const maxRetries = options.maxPortRetries !== undefined ? options.maxPortRetries : config.MAX_PORT_RETRIES;
  let currentPort = preferredPort;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(currentPort, host);
      });
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        if (attempt < maxRetries) {
          currentPort = preferredPort === 0 ? 0 : preferredPort + attempt + 1;
        } else {
          // Final fallback: port 0 (OS dynamically assigns free ephemeral port)
          currentPort = 0;
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.once('listening', resolve);
            server.listen(0, host);
          });
          break;
        }
      } else {
        throw err;
      }
    }
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : currentPort;
  const baseUrl = `http://${host}:${actualPort}`;

  activeServer = server;
  app.locals.httpPort = actualPort;

  const httpsPort = options.httpsPort !== undefined ? options.httpsPort : (Number(process.env.HTTPS_PORT) || actualPort + 1000);
  activeHttpsServer = options.https === false ? null : await startHttpsServer(app, host, httpsPort);
  app.locals.httpsPort = activeHttpsServer ? activeHttpsServer.address().port : null;

  // Initialize Real-Time Proctoring WebSocket Server (on both listeners)
  try {
    const websocketService = require('./services/websocketService');
    const proctorService = require('./services/proctorService');
    websocketService.init(server, { datastore, proctorService });
    if (activeHttpsServer) websocketService.attach(activeHttpsServer);
  } catch (wsErr) {
    console.warn('[WebSocket] Initialization notice:', wsErr.message);
  }

  // Start background timer sweeper
  try {
    const timerService = require('./services/timerService');
    if (timerService && typeof timerService.startSweeper === 'function') {
      timerService.startSweeper();
    }
  } catch (_) {}

  if (config.ENV !== 'test') {
    console.log(`[Backend] Server listening on ${baseUrl} (env: ${config.ENV})`);
    if (app.locals.httpsPort) console.log(`[Backend] HTTPS for LAN candidates on port ${app.locals.httpsPort}`);
  }

  return {
    server,
    app,
    port: actualPort,
    httpsPort: app.locals.httpsPort,
    host,
    baseUrl,
    datastore
  };
}

async function stopServer() {
  if (activeServer) {
    try {
      const websocketService = require('./services/websocketService');
      if (websocketService && typeof websocketService.close === 'function') {
        websocketService.close();
      }
    } catch (_) {}

    try {
      const timerService = require('./services/timerService');
      if (timerService && typeof timerService.stopSweeper === 'function') {
        timerService.stopSweeper();
      }
    } catch (_) {}

    await datastore.flush();
    if (datastore.cloudState) {
      await datastore.cloudState.close();
      datastore.cloudState = null;
    }
    if (datastore.mirror) {
      await datastore.mirror.close().catch(() => {});
      datastore.mirror = null;
    }
    // close() waits for every open connection to end, and browsers (the proctor console,
    // candidates' live video) keep theirs open, so drop them or shutdown never finishes.
    const closeServer = (server) => new Promise((resolve) => {
      server.close(resolve);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    await closeServer(activeServer);
    activeServer = null;
    if (activeHttpsServer) {
      await closeServer(activeHttpsServer);
      activeHttpsServer = null;
    }
  }
}

// Auto-start when executed directly from CLI (e.g. node src/backend/server.js)
if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Backend] Fatal startup failure:', err);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  stopServer
};
