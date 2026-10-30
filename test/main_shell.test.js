const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const windowManager = require('../src/main/windowManager');
const ipcHandlers = require('../src/main/ipcHandlers');

class MockWebContents {
  constructor() {
    this.mainFrame = { id: 'root-frame' };
    this.listeners = new Map();
    this.sentEvents = [];
    this.windowOpenHandler = null;
  }
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }
  emit(event, ...args) {
    const list = this.listeners.get(event) || [];
    for (const fn of list) fn(...args);
  }
  send(channel, ...args) {
    this.sentEvents.push({ channel, args });
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class MockBrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this.isShown = false;
    this._isMaximized = false;
    this._isMinimized = false;
    this._isDestroyed = false;
    this.listeners = new Map();
    this.webContents = new MockWebContents();
  }
  show() { this.isShown = true; }
  minimize() { this._isMinimized = true; }
  maximize() {
    this._isMaximized = true;
    this.emit('maximize');
  }
  unmaximize() {
    this._isMaximized = false;
    this.emit('unmaximize');
  }
  isMaximized() { return this._isMaximized; }
  close() {
    this._isDestroyed = true;
    this.emit('closed');
  }
  destroy() {
    this._isDestroyed = true;
    this.emit('closed');
  }
  isDestroyed() { return this._isDestroyed; }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  once(event, fn) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    this.on(event, wrapper);
  }
  emit(event, ...args) {
    const list = this.listeners.get(event) || [];
    for (const fn of list) fn(...args);
  }
  removeListener(event, fn) {
    const list = this.listeners.get(event) || [];
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }
}

class MockIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }
  handle(channel, fn) { this.handlers.set(channel, fn); }
  removeHandler(channel) { this.handlers.delete(channel); }
  on(channel, fn) {
    if (!this.listeners.has(channel)) this.listeners.set(channel, []);
    this.listeners.get(channel).push(fn);
  }
  removeAllListeners(channel) { this.listeners.delete(channel); }
  async invoke(channel, event, ...args) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No IPC handler registered for '${channel}'`);
    return fn(event, ...args);
  }
  emit(channel, event, ...args) {
    const list = this.listeners.get(channel) || [];
    for (const fn of list) fn(event, ...args);
  }
}

describe('Milestone 2 Main Shell & IPC Router Unit Tests', () => {
  let mockIpc;
  let mockWin;

  beforeEach(() => {
    windowManager.destroyAllWindows();
    mockIpc = new MockIpcMain();
    mockWin = windowManager.createMainWindow({ isSmokeTest: true }, MockBrowserWindow);
  });

  afterEach(() => {
    ipcHandlers.unregisterIpcHandlers(mockIpc);
    windowManager.destroyAllWindows();
  });

  // --- Suite 1: Window Security & Configuration ---
  describe('Window Security & Configuration', () => {
    it('S1: Enforces context isolation and denies Node.js integration', () => {
      const prefs = mockWin.options.webPreferences;
      assert.strictEqual(prefs.contextIsolation, true);
      assert.strictEqual(prefs.nodeIntegration, false);
      assert.strictEqual(prefs.nodeIntegrationInWorker, false);
      assert.strictEqual(prefs.sandbox, true);
      assert.strictEqual(prefs.webSecurity, true);
      assert.strictEqual(prefs.allowRunningInsecureContent, false);
      assert.strictEqual(prefs.webviewTag, false);
    });

    it('S2: Sets frameless styling and dark background theme', () => {
      assert.strictEqual(mockWin.options.frame, false);
      assert.strictEqual(mockWin.options.backgroundColor, '#090d16');
      assert.strictEqual(mockWin.options.minWidth, 1024);
      assert.strictEqual(mockWin.options.minHeight, 700);
    });

    it('S3: Blocks top-level external navigation in the host window', () => {
      let defaultPrevented = false;
      const fakeEvent = {
        preventDefault: () => { defaultPrevented = true; }
      };

      // Allowed local loopback URL
      mockWin.webContents.emit('will-navigate', fakeEvent, 'http://127.0.0.1:4100/app');
      assert.strictEqual(defaultPrevented, false);

      // Blocked external URL
      mockWin.webContents.emit('will-navigate', fakeEvent, 'https://external-phishing.com');
      assert.strictEqual(defaultPrevented, true);
    });

    it('S4: Denies window.open popups via setWindowOpenHandler', () => {
      assert.ok(mockWin.webContents.windowOpenHandler);
      const res = mockWin.webContents.windowOpenHandler({ url: 'https://popup.com' });
      assert.deepStrictEqual(res, { action: 'deny' });
    });
  });

  // --- Suite 2: Window Controls & State Management ---
  describe('Window Controls & State Management', () => {
    it('W1: Toggles maximize and unmaximize correctly', () => {
      assert.strictEqual(windowManager.isMainWindowMaximized(), false);

      const isMax1 = windowManager.toggleMaximizeMainWindow();
      assert.strictEqual(isMax1, true);
      assert.strictEqual(mockWin.isMaximized(), true);

      const isMax2 = windowManager.toggleMaximizeMainWindow();
      assert.strictEqual(isMax2, false);
      assert.strictEqual(mockWin.isMaximized(), false);
    });

    it('W2: Minimizes and closes main window', () => {
      windowManager.minimizeMainWindow();
      assert.strictEqual(mockWin._isMinimized, true);

      windowManager.closeMainWindow();
      assert.strictEqual(windowManager.getMainWindow(), null);
    });
  });

  // --- Suite 3: IPC Router Security & Validation ---
  describe('IPC Router Security & Validation', () => {
    beforeEach(() => {
      ipcHandlers.registerIpcHandlers({
        mainWindow: mockWin,
        backendPort: 4200,
        appVersion: '2.0.0'
      }, mockIpc);
    });

    it('I1: Discloses backend port and app version to authorized caller', async () => {
      const authorizedEvent = { senderFrame: mockWin.webContents.mainFrame };

      const port = await mockIpc.invoke('system:get-backend-port', authorizedEvent);
      assert.strictEqual(port, 4200);

      const portApp = await mockIpc.invoke('app:get-backend-port', authorizedEvent);
      assert.strictEqual(portApp, 4200);

      const version = await mockIpc.invoke('system:get-app-version', authorizedEvent);
      assert.strictEqual(version, '2.0.0');

      const isMax = await mockIpc.invoke('window:is-maximized', authorizedEvent);
      assert.strictEqual(isMax, false);
    });

    it('I2: Rejects unauthorized callers from untrusted subframes', async () => {
      const untrustedEvent = { senderFrame: { id: 'rogue-iframe' } };

      await assert.rejects(async () => {
        await mockIpc.invoke('system:get-backend-port', untrustedEvent);
      }, /Unauthorized IPC invocation/);

      await assert.rejects(async () => {
        await mockIpc.invoke('system:get-app-version', untrustedEvent);
      }, /Unauthorized IPC invocation/);
    });

    it('I3: Executes window controls via IPC messages from authorized frame', () => {
      const authorizedEvent = { senderFrame: mockWin.webContents.mainFrame };

      mockIpc.emit('window:minimize', authorizedEvent);
      assert.strictEqual(mockWin._isMinimized, true);

      mockIpc.emit('window:maximize', authorizedEvent);
      assert.strictEqual(mockWin.isMaximized(), true);

      mockIpc.emit('window:close', authorizedEvent);
      assert.strictEqual(windowManager.getMainWindow(), null);
    });

    it('I4: Cleanly unregisters all handlers on teardown', async () => {
      ipcHandlers.unregisterIpcHandlers(mockIpc);

      assert.strictEqual(mockIpc.handlers.size, 0);
      assert.strictEqual(mockIpc.listeners.size, 0);

      await assert.rejects(async () => {
        await mockIpc.invoke('system:get-backend-port', {});
      }, /No IPC handler registered/);
    });
  });
});
