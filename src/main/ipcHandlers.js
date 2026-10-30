/**
 * IPC Communication Router
 * Handles IPC messaging between preload bridges, window manager, and backend.
 */

let electronIpcMain = null;
try {
  const electron = require('electron');
  electronIpcMain = electron.ipcMain;
} catch (_) {}

const windowManager = require('./windowManager');

let registeredIpcInstance = null;

function isAuthorizedSender(event, mainWindow) {
  if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) {
    return false;
  }
  // If senderFrame is available, ensure it originates from the mainFrame
  if (event && event.senderFrame && mainWindow.webContents && mainWindow.webContents.mainFrame) {
    return event.senderFrame === mainWindow.webContents.mainFrame;
  }
  return true;
}

function registerIpcHandlers({ mainWindow, backendPort, backendUrl, appVersion, tabManager, searchTracker, integrityMonitor, searchPolicy, fetchFn }, ipc = electronIpcMain) {
  const serverUrl = backendUrl || (backendPort ? `http://127.0.0.1:${backendPort}` : null);
  registeredIpcInstance = ipc;
  if (!ipc) return;

  const currentFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);

  // 1. Backend Port Exposure (support both system: and app: prefixes)
  const portHandler = (event) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: get-backend-port');
    }
    return backendPort;
  };
  ipc.handle('system:get-backend-port', portHandler);

  // Full server URL: the embedded backend, or the central exam server in deployments
  ipc.handle('system:get-server-url', (event) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: get-server-url');
    }
    return serverUrl;
  });
  ipc.handle('app:get-backend-port', portHandler);

  // 2. Application Version Exposure
  const versionHandler = (event) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: get-version');
    }
    return appVersion || '1.0.0';
  };
  ipc.handle('system:get-app-version', versionHandler);
  ipc.handle('app:get-version', versionHandler);

  // 3. Window State Query & Controls
  ipc.handle('window:is-maximized', (event) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: window:is-maximized');
    }
    return windowManager.isMainWindowMaximized();
  });

  ipc.on('window:minimize', (event) => {
    if (isAuthorizedSender(event, mainWindow)) {
      windowManager.minimizeMainWindow();
    }
  });

  ipc.on('window:maximize', (event) => {
    if (isAuthorizedSender(event, mainWindow)) {
      windowManager.toggleMaximizeMainWindow();
    }
  });

  ipc.on('window:close', (event) => {
    if (isAuthorizedSender(event, mainWindow)) {
      windowManager.closeMainWindow();
    }
  });

  // 4. Activity Telemetry Forwarding
  const activityHandler = async (event, activityEvent) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: log-activity');
    }
    return { recorded: true, timestamp: Date.now() };
  };
  ipc.handle('audit:log-activity', activityHandler);
  ipc.handle('telemetry:log-activity', activityHandler);

  // Session ID Synchronization
  ipc.handle('session:set-id', (_event, sessionId) => {
    if (tabManager && typeof tabManager.setSessionId === 'function') {
      tabManager.setSessionId(sessionId);
    }
    if (searchTracker && typeof searchTracker.setSessionId === 'function') {
      searchTracker.setSessionId(sessionId);
    }
    return { ok: true, sessionId };
  });

  // The question on screen, used by the search policy to judge relevance (null clears it)
  ipc.handle('exam:set-context', (event, context) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: exam:set-context');
    }
    if (searchPolicy) searchPolicy.setContext(context && typeof context === 'object' ? {
      questionText: String(context.questionText || '').slice(0, 2000),
      options: Array.isArray(context.options) ? context.options.map(o => String(o).slice(0, 300)).slice(0, 6) : [],
      category: String(context.category || '').slice(0, 120),
      rules: context.rules || {}
    } : null);
    return { ok: true };
  });

  // Exam lockdown lifecycle (integrity monitor: displays, processes, focus, capture protection)
  ipc.handle('integrity:start', (event, sessionId) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: integrity:start');
    }
    if (integrityMonitor && typeof sessionId === 'string' && sessionId) integrityMonitor.start(sessionId);
    return { ok: Boolean(integrityMonitor) };
  });
  ipc.handle('integrity:stop', (event) => {
    if (!isAuthorizedSender(event, mainWindow)) {
      throw new Error('Unauthorized IPC invocation: integrity:stop');
    }
    if (integrityMonitor) integrityMonitor.stop();
    return { ok: true };
  });

  // 5. Guest Preload Events Forwarding
  ipc.on('proctor:guest-event', async (_event, payload) => {
    if (!payload || !payload.channel) return;

    if (payload.channel === 'search-event' && searchTracker && typeof searchTracker.dispatchSearchEvent === 'function') {
      try {
        await searchTracker.dispatchSearchEvent(payload);
      } catch (_) {}
    } else if (payload.channel === 'input-activity' && currentFetch && serverUrl) {
      try {
        const sessionId = (tabManager && tabManager.sessionId) || (searchTracker && searchTracker.currentSessionId);
        if (sessionId) {
          await currentFetch(`${serverUrl}/api/proctor/input-activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              type: payload.type || payload.eventType || 'KEYSTROKE',
              data: payload.details || payload
            })
          });
        }
      } catch (_) {}
    }
  });

  // 6. Tab Manager Integration
  if (tabManager && typeof tabManager.registerIpcHandlers === 'function') {
    tabManager.registerIpcHandlers(ipc, mainWindow);
  }
}

function unregisterIpcHandlers(ipc = registeredIpcInstance || electronIpcMain) {
  if (!ipc) return;

  const handleChannels = [
    'system:get-backend-port',
    'system:get-server-url',
    'app:get-backend-port',
    'system:get-app-version',
    'app:get-version',
    'window:is-maximized',
    'audit:log-activity',
    'telemetry:log-activity',
    'session:set-id',
    'integrity:start',
    'exam:set-context',
    'integrity:stop',
    'tab:create',
    'tab:switch',
    'tab:close',
    'tab:navigate',
    'tab:get-all',
    'tab:get-active'
  ];

  for (const channel of handleChannels) {
    if (typeof ipc.removeHandler === 'function') {
      try {
        ipc.removeHandler(channel);
      } catch (_) {}
    }
  }

  const onChannels = [
    'window:minimize',
    'window:maximize',
    'window:close',
    'proctor:guest-event'
  ];

  for (const channel of onChannels) {
    if (typeof ipc.removeAllListeners === 'function') {
      try {
        ipc.removeAllListeners(channel);
      } catch (_) {}
    }
  }

  registeredIpcInstance = null;
}

module.exports = {
  registerIpcHandlers,
  unregisterIpcHandlers,
  isAuthorizedSender
};
