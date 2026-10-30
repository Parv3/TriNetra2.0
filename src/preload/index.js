/**
 * Host Preload Bridge
 * Exposes window.proctorAPI to the renderer process via contextBridge.
 * Adheres strictly to PROJECT.md § Interface Contracts.
 */

let contextBridge = null;
let ipcRenderer = null;

try {
  const electron = require('electron');
  contextBridge = electron.contextBridge;
  ipcRenderer = electron.ipcRenderer;
} catch (_) {
  // Graceful fallback for non-Electron test execution
}

/**
 * Validates that an argument is a non-empty string.
 */
function assertString(val, name) {
  if (typeof val !== 'string' || !val.trim()) {
    throw new TypeError(`[proctorAPI] Argument '${name}' must be a non-empty string.`);
  }
}

/**
 * Validates that an argument is a function callback.
 */
function assertFunction(fn, name) {
  if (typeof fn !== 'function') {
    throw new TypeError(`[proctorAPI] Argument '${name}' must be a function.`);
  }
}

function createProctorAPI(ipc = ipcRenderer) {
  if (!ipc) {
    return {};
  }

  return {
    // --- Backend & System ---
    getBackendPort: async () => {
      return ipc.invoke('system:get-backend-port');
    },

    getServerUrl: async () => {
      return ipc.invoke('system:get-server-url');
    },

    setServerUrl: async (url) => {
      assertString(url, 'url');
      return ipc.invoke('system:set-server-url', url);
    },

    getAppVersion: async () => {
      return ipc.invoke('system:get-app-version');
    },

    // --- Tab Management & Navigation ---
    createTab: async (url = 'about:blank') => {
      if (url !== undefined && typeof url !== 'string') {
        throw new TypeError('[proctorAPI] url must be a string.');
      }
      return ipc.invoke('tab:create', url);
    },

    switchTab: async (tabId) => {
      assertString(tabId, 'tabId');
      return ipc.invoke('tab:switch', tabId);
    },

    closeTab: async (tabId) => {
      assertString(tabId, 'tabId');
      return ipc.invoke('tab:close', tabId);
    },

    navigateTab: async (tabId, url) => {
      assertString(tabId, 'tabId');
      if (typeof url !== 'string') {
        throw new TypeError('[proctorAPI] url must be a string.');
      }
      return ipc.invoke('tab:navigate', tabId, url);
    },

    getAllTabs: async () => {
      return ipc.invoke('tab:get-all');
    },

    getActiveTab: async () => {
      return ipc.invoke('tab:get-active');
    },

    setSessionId: async (sessionId) => {
      assertString(sessionId, 'sessionId');
      return ipc.invoke('session:set-id', sessionId);
    },

    startLockdown: async (sessionId) => {
      assertString(sessionId, 'sessionId');
      return ipc.invoke('integrity:start', sessionId);
    },

    stopLockdown: async () => {
      return ipc.invoke('integrity:stop');
    },

    setExamContext: async (context) => {
      return ipc.invoke('exam:set-context', context || null);
    },

    onPolicyBlocked: (callback) => {
      assertFunction(callback, 'callback');
      const listener = (_event, info) => {
        try { callback(info); } catch (err) { console.error('[proctorAPI] onPolicyBlocked listener:', err); }
      };
      ipc.on('policy:blocked', listener);
      return () => ipc.removeListener && ipc.removeListener('policy:blocked', listener);
    },

    onTabUpdated: (callback) => {
      assertFunction(callback, 'callback');
      const listener = (_event, tab) => {
        try {
          callback(tab);
        } catch (err) {
          console.error('[proctorAPI] Error in onTabUpdated listener:', err);
        }
      };
      ipc.on('tab:updated', listener);
      return () => {
        if (typeof ipc.removeListener === 'function') {
          ipc.removeListener('tab:updated', listener);
        }
      };
    },

    // --- Audit & Telemetry IPC ---
    logActivity: async (event) => {
      if (!event || typeof event !== 'object') {
        throw new TypeError('[proctorAPI] event must be an object.');
      }
      return ipc.invoke('audit:log-activity', event);
    },

    onProctorWarning: (callback) => {
      assertFunction(callback, 'callback');
      const listener = (_event, warning) => {
        try {
          callback(warning);
        } catch (err) {
          console.error('[proctorAPI] Error in onProctorWarning listener:', err);
        }
      };
      ipc.on('proctor:warning', listener);
      return () => {
        if (typeof ipc.removeListener === 'function') {
          ipc.removeListener('proctor:warning', listener);
        }
      };
    },

    onDisqualify: (callback) => {
      assertFunction(callback, 'callback');
      const listener = (_event, reason) => {
        try {
          callback(reason);
        } catch (err) {
          console.error('[proctorAPI] Error in onDisqualify listener:', err);
        }
      };
      ipc.on('proctor:disqualify', listener);
      return () => {
        if (typeof ipc.removeListener === 'function') {
          ipc.removeListener('proctor:disqualify', listener);
        }
      };
    },

    // --- Window Controls ---
    minimizeWindow: () => {
      ipc.send('window:minimize');
    },

    maximizeWindow: () => {
      ipc.send('window:maximize');
    },

    closeWindow: () => {
      ipc.send('window:close');
    }
  };
}

const proctorAPI = createProctorAPI();

if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  try {
    contextBridge.exposeInMainWorld('proctorAPI', proctorAPI);
  } catch (_) {}
}

module.exports = {
  proctorAPI,
  createProctorAPI
};
