/**
 * Window Manager
 * Controls BrowserWindow creation, frameless controls, and security configurations.
 */

let electronBrowserWindow = null;
try {
  const electron = require('electron');
  electronBrowserWindow = electron.BrowserWindow;
} catch (_) {}

const path = require('node:path');

let mainWindow = null;

function createMainWindow(options = {}, ElectronBrowserWindow = electronBrowserWindow) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const defaultPreload = path.join(__dirname, '../preload/index.js');
  const preloadPath = options.preloadPath || defaultPreload;

  const win = new ElectronBrowserWindow({
    width: options.width || 1280,
    height: options.height || 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    frame: options.frame !== undefined ? options.frame : false,
    titleBarStyle: options.frame ? 'default' : 'hidden',
    backgroundColor: options.backgroundColor || '#090d16',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      webviewTag: false
    }
  });

  mainWindow = win;

  // Reveal window smoothly when DOM is ready (except in smoke test)
  if (typeof win.once === 'function') {
    win.once('ready-to-show', () => {
      if (!options.isSmokeTest) {
        win.show();
      }
    });
  }

  // Guard: Restrict top-level navigation in host window
  if (win.webContents && typeof win.webContents.on === 'function') {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[Renderer] ${message}`);
    });

    win.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        const u = new URL(navigationUrl);
        if (u.protocol === 'file:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
          return;
        }
      } catch (_) {}
      event.preventDefault();
    });

    // Guard: Deny popup windows
    if (typeof win.webContents.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
  }

  // Track window maximize / restore state
  if (typeof win.on === 'function') {
    win.on('maximize', () => {
      if (win.webContents && typeof win.webContents.send === 'function') {
        win.webContents.send('window:maximized-change', true);
      }
    });

    win.on('unmaximize', () => {
      if (win.webContents && typeof win.webContents.send === 'function') {
        win.webContents.send('window:maximized-change', false);
      }
    });

    win.on('closed', () => {
      mainWindow = null;
    });
  }

  return win;
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function minimizeMainWindow() {
  const win = getMainWindow();
  if (win && typeof win.minimize === 'function') {
    win.minimize();
  }
}

function toggleMaximizeMainWindow() {
  const win = getMainWindow();
  if (win && typeof win.isMaximized === 'function') {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  }
  return false;
}

function closeMainWindow() {
  const win = getMainWindow();
  if (win && typeof win.close === 'function') {
    win.close();
  }
}

function isMainWindowMaximized() {
  const win = getMainWindow();
  return win && typeof win.isMaximized === 'function' ? win.isMaximized() : false;
}

function destroyAllWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  mainWindow = null;
}

module.exports = {
  createMainWindow,
  getMainWindow,
  minimizeMainWindow,
  toggleMaximizeMainWindow,
  closeMainWindow,
  isMainWindowMaximized,
  destroyAllWindows
};
