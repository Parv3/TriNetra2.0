const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { TabManager } = require('../src/main/tabManager');

// --- Headless Mocks ---
class MockWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = 'about:blank';
    this.title = 'Mock Page';
    this.closed = false;
  }
  loadURL(url) {
    this.url = url;
    this.emit('did-start-loading');
    this.emit('did-navigate', {}, url);
    this.emit('did-stop-loading');
    return Promise.resolve();
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
  close() {
    this.closed = true;
    this.emit('destroyed');
  }
}

class MockWebContentsView {
  constructor(webPreferences = {}) {
    this.webPreferences = webPreferences;
    this.webContents = new MockWebContents();
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }
  setBounds(bounds) {
    this.bounds = bounds;
  }
}

class MockMainWindow {
  constructor() {
    this.views = [];
    this.contentView = {
      addChildView: (v) => { this.views.push(v); },
      removeChildView: (v) => {
        const idx = this.views.indexOf(v);
        if (idx !== -1) this.views.splice(idx, 1);
      }
    };
    this.webContents = {
      send: (ch, data) => { this.messages.push({ channel: ch, data }); },
      isDestroyed: () => false
    };
    this.messages = [];
  }
  getContentBounds() {
    return { width: 1280, height: 800 };
  }
  on() {}
}

class MockIpc {
  constructor() {
    this.handlers = new Map();
  }
  handle(channel, fn) {
    this.handlers.set(channel, fn);
  }
  async invoke(channel, ...args) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler for ${channel}`);
    return fn({}, ...args);
  }
}

describe('TabManager Unit Test Suite', () => {
  let tm;
  let mockWin;
  let sentTelemetry;

  beforeEach(() => {
    sentTelemetry = [];
    mockWin = new MockMainWindow();
    tm = new TabManager({
      mainWindow: mockWin,
      backendUrl: 'http://127.0.0.1:4100',
      sessionId: 'sess_test_unit_1',
      viewFactory: (prefs) => new MockWebContentsView(prefs),
      fetchFn: async (url, opts) => {
        sentTelemetry.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200, json: async () => ({ recorded: true }) };
      }
    });
    tm.init(mockWin);
  });

  // --- Suite 1: Pinned Assessment Tab ---
  describe('Tab 0 Pinned Assessment Tab', () => {
    it('initializes with Tab 0 as pinned and active', () => {
      assert.strictEqual(tm.tabs.size, 1);
      const pinned = tm.tabs.get('tab_assessment_pinned');
      assert.ok(pinned);
      assert.strictEqual(pinned.isPinned, true);
      assert.strictEqual(pinned.canClose, false);
      assert.strictEqual(pinned.isActive, true);
      assert.strictEqual(tm.activeTabId, 'tab_assessment_pinned');
    });

    it('rejects attempt to close pinned assessment tab with exact error', () => {
      assert.throws(() => {
        tm.closeTab('tab_assessment_pinned');
      }, /Pinned assessment tab cannot be closed/);

      assert.throws(() => {
        tm.closeTab(0);
      }, /Pinned assessment tab cannot be closed/);
    });

    it('rejects external URL navigation on Tab 0', () => {
      assert.throws(() => {
        tm.navigateTab('tab_assessment_pinned', 'https://google.com');
      }, /Pinned assessment tab cannot navigate/);
    });
  });

  // --- Suite 2: Guest Tab Lifecycle & Security ---
  describe('Guest Tab Lifecycle & Security', () => {
    it('creates guest tab with valid URL and makes it active', () => {
      const tabId = tm.createTab('https://www.wikipedia.org');
      assert.ok(typeof tabId === 'string');
      assert.strictEqual(tm.tabs.size, 2);
      assert.strictEqual(tm.activeTabId, tabId);

      const tab = tm.tabs.get(tabId);
      assert.strictEqual(tab.isPinned, false);
      assert.strictEqual(tab.canClose, true);
      assert.strictEqual(tab.url, 'https://www.wikipedia.org/');
    });

    it('enforces maximum concurrent tabs limit', () => {
      tm.maxTabs = 3;
      tm.createTab('https://site1.com');
      tm.createTab('https://site2.com');
      assert.throws(() => {
        tm.createTab('https://site3.com');
      }, /Maximum concurrent tabs reached/);
    });

    it('rejects blocked protocol schemes (file:, javascript:, data:)', () => {
      assert.throws(() => {
        tm.createTab('file:///etc/passwd');
      }, /Security Exception: Blocked protocol scheme 'file:'/);

      assert.throws(() => {
        tm.createTab('javascript:alert(1)');
      }, /Security Exception: Blocked protocol scheme 'javascript:'/);

      assert.throws(() => {
        tm.createTab('data:text/html,bad');
      }, /Security Exception: Blocked protocol scheme 'data:'/);
    });

    it('normalizes missing protocol and plain text search queries', () => {
      const tabId1 = tm.createTab('github.com');
      assert.strictEqual(tm.tabs.get(tabId1).url, 'https://github.com/');

      const tabId2 = tm.createTab('dijkstra shortest path algorithm');
      assert.ok(tm.tabs.get(tabId2).url.includes('google.com/search?q='));
    });
  });

  // --- Suite 3: Tab Switching & Duration Accounting ---
  describe('Tab Switching & Duration Accounting', () => {
    it('switches between tabs and tracks focused duration accurately', async () => {
      const tabId = tm.createTab('https://duckduckgo.com');
      assert.strictEqual(tm.activeTabId, tabId);

      // Artificially simulate 250ms elapsed
      const guestTab = tm.tabs.get(tabId);
      guestTab.lastActivatedAt = Date.now() - 250;

      // Switch back to assessment tab
      tm.switchTab('tab_assessment_pinned');
      assert.strictEqual(tm.activeTabId, 'tab_assessment_pinned');
      assert.ok(guestTab.activeDurationMs >= 250);

      // Verify TAB_SWITCH telemetry was sent
      const switchEvents = sentTelemetry.filter(e => e.body.type === 'TAB_SWITCH');
      assert.ok(switchEvents.length >= 1);
      const lastSwitch = switchEvents[switchEvents.length - 1].body;
      assert.strictEqual(lastSwitch.tabId, tabId);
      assert.ok(lastSwitch.duration >= 250);
    });

    it('switching to non-existent tab throws Error', () => {
      assert.throws(() => {
        tm.switchTab('tab_does_not_exist');
      }, /Tab not found/);
    });

    it('switching to already active tab is an idempotent no-op', () => {
      const initialCount = sentTelemetry.length;
      tm.switchTab('tab_assessment_pinned');
      assert.strictEqual(sentTelemetry.length, initialCount);
    });
  });

  // --- Suite 4: Tab Closing & Fallback ---
  describe('Tab Closing & Fallback', () => {
    it('closing active guest tab falls back to pinned assessment tab', () => {
      const tabId = tm.createTab('https://bing.com');
      assert.strictEqual(tm.activeTabId, tabId);

      const res = tm.closeTab(tabId);
      assert.strictEqual(res, true);
      assert.strictEqual(tm.tabs.has(tabId), false);
      assert.strictEqual(tm.activeTabId, 'tab_assessment_pinned');
    });

    it('closing inactive tab does not alter active tab', () => {
      const tab1 = tm.createTab('https://site1.com');
      const tab2 = tm.createTab('https://site2.com');
      assert.strictEqual(tm.activeTabId, tab2);

      tm.closeTab(tab1);
      assert.strictEqual(tm.tabs.has(tab1), false);
      assert.strictEqual(tm.activeTabId, tab2);
    });
  });

  // --- Suite 5: AI Tool Detection ---
  describe('AI Tool Detection', () => {
    it('flags ChatGPT and Claude domains as AI tools', () => {
      const chatGptTab = tm.createTab('https://chatgpt.com/c/exam-help');
      assert.strictEqual(tm.tabs.get(chatGptTab).isAiTool, true);

      const claudeTab = tm.createTab('https://claude.ai/chat');
      assert.strictEqual(tm.tabs.get(claudeTab).isAiTool, true);

      const normalTab = tm.createTab('https://en.wikipedia.org');
      assert.strictEqual(tm.tabs.get(normalTab).isAiTool, false);
    });
  });

  // --- Suite 6: Telemetry Resilience ---
  describe('Telemetry Buffering & Resilience', () => {
    it('buffers telemetry when backend is not yet available and flushes on connect', async () => {
      const tmBuffer = new TabManager({
        fetchFn: async (url, opts) => {
          sentTelemetry.push({ url, body: JSON.parse(opts.body) });
          return { ok: true };
        }
      });

      // No backendUrl or sessionId yet
      tmBuffer.createTab('https://test.com');
      assert.ok(tmBuffer.telemetryBuffer.length > 0);

      // Now set sessionId and backend
      tmBuffer.setSessionId('sess_buffered_1');
      tmBuffer.setBackendUrl('http://127.0.0.1:4100');

      assert.strictEqual(tmBuffer.telemetryBuffer.length, 0);
      assert.ok(sentTelemetry.some(t => t.body.sessionId === 'sess_buffered_1'));
    });
  });

  // --- Suite 7: IPC Handlers ---
  describe('IPC Handlers', () => {
    it('registers and executes tab IPC methods', async () => {
      const mockIpc = new MockIpc();
      tm.registerIpcHandlers(mockIpc, mockWin);

      const newId = await mockIpc.invoke('tab:create', 'https://example.com');
      assert.ok(newId);

      const allTabs = await mockIpc.invoke('tab:get-all');
      assert.strictEqual(allTabs.length, 2);

      await mockIpc.invoke('tab:navigate', newId, 'https://example.org');
      assert.strictEqual(tm.tabs.get(newId).url, 'https://example.org/');

      await mockIpc.invoke('tab:close', newId);
      assert.strictEqual(tm.tabs.has(newId), false);
    });
  });
});
