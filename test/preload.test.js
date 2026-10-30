const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createProctorAPI } = require('../src/preload/index');
const { parseAiPayload, isDisallowedShortcut } = require('../src/preload/guest-preload');

describe('Host Preload Bridge Contract (proctorAPI)', () => {
  let mockIpc;
  let proctorAPI;

  beforeEach(() => {
    mockIpc = {
      handlers: new Map(),
      listeners: new Map(),
      invocations: [],
      sent: [],
      invoke: async (channel, ...args) => {
        mockIpc.invocations.push({ channel, args });
        const handler = mockIpc.handlers.get(channel);
        return handler ? handler(...args) : null;
      },
      send: (channel, ...args) => {
        mockIpc.sent.push({ channel, args });
      },
      on: (channel, fn) => {
        if (!mockIpc.listeners.has(channel)) mockIpc.listeners.set(channel, []);
        mockIpc.listeners.get(channel).push(fn);
      },
      removeListener: (channel, fn) => {
        const list = mockIpc.listeners.get(channel) || [];
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
    };

    proctorAPI = createProctorAPI(mockIpc);
  });

  it('P1: All required proctorAPI methods exist and have function types', () => {
    const required = [
      'getBackendPort', 'getAppVersion', 'createTab', 'switchTab', 'closeTab',
      'navigateTab', 'onTabUpdated', 'logActivity', 'onProctorWarning', 'onDisqualify',
      'minimizeWindow', 'maximizeWindow', 'closeWindow'
    ];
    for (const m of required) {
      assert.strictEqual(typeof proctorAPI[m], 'function', `Method ${m} must exist`);
    }
  });

  it('P2: Invokes system and tab management IPC channels correctly', async () => {
    mockIpc.handlers.set('system:get-backend-port', () => 4100);
    mockIpc.handlers.set('system:get-app-version', () => '1.0.0');
    mockIpc.handlers.set('tab:create', (url) => 'tab_new_123');
    mockIpc.handlers.set('tab:switch', (tabId) => ({ active: tabId }));
    mockIpc.handlers.set('tab:close', (tabId) => ({ closed: tabId }));
    mockIpc.handlers.set('tab:navigate', (tabId, url) => ({ navigated: url }));
    mockIpc.handlers.set('audit:log-activity', (event) => ({ recorded: true }));

    const port = await proctorAPI.getBackendPort();
    assert.strictEqual(port, 4100);

    const version = await proctorAPI.getAppVersion();
    assert.strictEqual(version, '1.0.0');

    const tabId = await proctorAPI.createTab('https://wikipedia.org');
    assert.strictEqual(tabId, 'tab_new_123');

    await proctorAPI.switchTab('tab_new_123');
    await proctorAPI.navigateTab('tab_new_123', 'https://google.com');
    await proctorAPI.closeTab('tab_new_123');
    await proctorAPI.logActivity({ type: 'TEST', value: 123 });

    assert.strictEqual(mockIpc.invocations[0].channel, 'system:get-backend-port');
    assert.strictEqual(mockIpc.invocations[1].channel, 'system:get-app-version');
    assert.strictEqual(mockIpc.invocations[2].channel, 'tab:create');
    assert.strictEqual(mockIpc.invocations[3].channel, 'tab:switch');
    assert.strictEqual(mockIpc.invocations[4].channel, 'tab:navigate');
    assert.strictEqual(mockIpc.invocations[5].channel, 'tab:close');
    assert.strictEqual(mockIpc.invocations[6].channel, 'audit:log-activity');
  });

  it('P3: Subscribes and unsubscribes event listeners cleanly without leaks', () => {
    let receivedTab = null;
    let receivedWarning = null;
    let receivedDisqualify = null;

    const unsubTab = proctorAPI.onTabUpdated((tab) => { receivedTab = tab; });
    const unsubWarn = proctorAPI.onProctorWarning((w) => { receivedWarning = w; });
    const unsubDisq = proctorAPI.onDisqualify((r) => { receivedDisqualify = r; });

    assert.strictEqual(mockIpc.listeners.get('tab:updated').length, 1);
    assert.strictEqual(mockIpc.listeners.get('proctor:warning').length, 1);
    assert.strictEqual(mockIpc.listeners.get('proctor:disqualify').length, 1);

    // Simulate event triggers
    mockIpc.listeners.get('tab:updated')[0]({}, { id: 'tab_1', title: 'Test Tab' });
    mockIpc.listeners.get('proctor:warning')[0]({}, { type: 'GAZE_DIVERSION', strikeCount: 2 });
    mockIpc.listeners.get('proctor:disqualify')[0]({}, 'Max strikes reached');

    assert.strictEqual(receivedTab.id, 'tab_1');
    assert.strictEqual(receivedWarning.type, 'GAZE_DIVERSION');
    assert.strictEqual(receivedDisqualify, 'Max strikes reached');

    // Unsubscribe
    unsubTab();
    unsubWarn();
    unsubDisq();

    assert.strictEqual(mockIpc.listeners.get('tab:updated').length, 0);
    assert.strictEqual(mockIpc.listeners.get('proctor:warning').length, 0);
    assert.strictEqual(mockIpc.listeners.get('proctor:disqualify').length, 0);
  });

  it('P4: Dispatches synchronous window controls via send', () => {
    proctorAPI.minimizeWindow();
    proctorAPI.maximizeWindow();
    proctorAPI.closeWindow();

    assert.strictEqual(mockIpc.sent.length, 3);
    assert.strictEqual(mockIpc.sent[0].channel, 'window:minimize');
    assert.strictEqual(mockIpc.sent[1].channel, 'window:maximize');
    assert.strictEqual(mockIpc.sent[2].channel, 'window:close');
  });

  it('P5: Rejects invalid parameters with proper TypeErrors', async () => {
    await assert.rejects(async () => proctorAPI.switchTab(123), /tabId/);
    await assert.rejects(async () => proctorAPI.switchTab('   '), /tabId/);
    await assert.rejects(async () => proctorAPI.closeTab(null), /tabId/);
    await assert.rejects(async () => proctorAPI.navigateTab('tab_1', 123), /url/);
    await assert.rejects(async () => proctorAPI.createTab(123), /url/);
    await assert.rejects(async () => proctorAPI.logActivity(null), /event/);
    assert.throws(() => proctorAPI.onTabUpdated('not a func'), /callback/);
  });
});

describe('Guest Preload Script Parsers & Heuristics', () => {
  it('G1: Parses ChatGPT conversation payload and extracts prompt', () => {
    const body = JSON.stringify({
      action: 'next',
      messages: [
        {
          id: 'msg_1',
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Solve Dijkstra algorithm for graph G'] }
        }
      ]
    });

    const parsed = parseAiPayload('/backend-api/conversation', body);
    assert.ok(parsed);
    assert.strictEqual(parsed.service, 'ChatGPT');
    assert.strictEqual(parsed.query, 'Solve Dijkstra algorithm for graph G');
  });

  it('G2: Parses Claude chat completion payload and extracts prompt', () => {
    const body = JSON.stringify({
      prompt: 'Write an MCQ test on binary search trees',
      model: 'claude-3-opus'
    });

    const parsed = parseAiPayload('/api/organizations/1/chat_conversations/1/completion', body);
    assert.ok(parsed);
    assert.strictEqual(parsed.service, 'Claude');
    assert.strictEqual(parsed.query, 'Write an MCQ test on binary search trees');
  });

  it('G3: Returns null for non-matching URLs or malformed bodies', () => {
    assert.strictEqual(parseAiPayload('/other/url', '{}'), null);
    assert.strictEqual(parseAiPayload('/backend-api/conversation', 'not json'), null);
    assert.strictEqual(parseAiPayload('/backend-api/conversation', null), null);
  });

  it('G4: Identifies disallowed hotkeys Alt+Tab, F12, DevTools, Ctrl+U', () => {
    assert.strictEqual(isDisallowedShortcut({ altKey: true, key: 'Tab' }), 'Alt+Tab');
    assert.strictEqual(isDisallowedShortcut({ altKey: true, code: 'Tab' }), 'Alt+Tab');
    assert.strictEqual(isDisallowedShortcut({ key: 'F12' }), 'F12');
    assert.strictEqual(isDisallowedShortcut({ ctrlKey: true, shiftKey: true, key: 'I' }), 'DevTools');
    assert.strictEqual(isDisallowedShortcut({ ctrlKey: true, shiftKey: true, key: 'J' }), 'DevTools');
    assert.strictEqual(isDisallowedShortcut({ ctrlKey: true, key: 'u' }), 'Ctrl+U');
    assert.strictEqual(isDisallowedShortcut({ ctrlKey: true, key: 'c' }), null);
    assert.strictEqual(isDisallowedShortcut({ key: 'Enter' }), null);
  });
});
