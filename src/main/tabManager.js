/**
 * Tab Manager & WebContentsView Container Controller
 *
 * Implements:
 * 1. Pinned Assessment Tab 0 (cannot be closed, locked to exam).
 * 2. Dynamic Guest Tabs (1..N) with WebContentsView isolation.
 * 3. Security partitioning ('persist:guest-session', sandbox, contextIsolation).
 * 4. Protocol whitelisting (http/https/about:blank allowed; file/javascript/data blocked).
 * 5. Active tab duration accounting and telemetry dispatch to local backend.
 * 6. Pure JavaScript dependency injection support for headless unit tests.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:', 'chrome:', 'vbscript:', 'edge:', 'devtools:'];
const ALLOWED_PROTOCOLS = ['http:', 'https:', 'about:'];

const AI_DOMAINS = [
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'anthropic.com',
  'deepseek.com',
  'perplexity.ai',
  'gemini.google.com',
  'copilot.microsoft.com'
];

class TabManager {
  constructor(options = {}) {
    this.mainWindow = options.mainWindow || null;
    this.viewFactory = options.viewFactory || null;
    this.fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    this.backendUrl = options.backendUrl || null;
    this.backendPort = options.backendPort || 4100;
    this.sessionId = options.sessionId || null;
    this.preloadPath = options.preloadPath || path.resolve(__dirname, '../preload/guest-preload.js');
    this.guestPartition = options.guestPartition || 'persist:guest-session';
    this.maxTabs = options.maxTabs || 20;
    this.topBarHeight = options.topBarHeight || 114; // Default height of titlebar (36) + tab strip (38) + omnibox (40)

    this.assessmentTabId = 'tab_assessment_pinned';
    this.tabs = new Map();
    this.activeTabId = null;
    this.listeners = new Set();
    this.telemetryBuffer = [];

    // Auto-initialize pinned tab
    this.initPinnedTab();
  }

  init(mainWindow, options = {}) {
    this.mainWindow = mainWindow;
    if (options.backendUrl) this.backendUrl = options.backendUrl;
    if (options.backendPort) {
      this.backendPort = options.backendPort;
      this.backendUrl = `http://127.0.0.1:${options.backendPort}`;
    }
    if (options.sessionId) this.sessionId = options.sessionId;
    if (options.preloadPath) this.preloadPath = options.preloadPath;
    if (options.topBarHeight) this.topBarHeight = options.topBarHeight;
    if (options.searchPolicy) this.searchPolicy = options.searchPolicy;

    if (this.mainWindow && typeof this.mainWindow.on === 'function') {
      this.mainWindow.on('resize', () => {
        this.updateActiveViewBounds();
      });
    }

    // Configure session security if electron session available
    this.configureSessionSecurity();
  }

  initPinnedTab() {
    const pinnedTab = {
      id: this.assessmentTabId,
      index: 0,
      title: 'MCQ Assessment',
      url: `http://127.0.0.1:${this.backendPort}/app/assessment`,
      isPinned: true,
      canClose: false,
      isActive: true,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      createdAt: Date.now(),
      lastActivatedAt: Date.now(),
      activeDurationMs: 0,
      isAiTool: false,
      view: null
    };

    this.tabs.set(this.assessmentTabId, pinnedTab);
    this.activeTabId = this.assessmentTabId;
  }

  configureSessionSecurity() {
    try {
      const electron = require('electron');
      if (electron && electron.session) {
        const guestSession = electron.session.fromPartition(this.guestPartition);
        if (guestSession) {
          // Standard Chrome user agent so Google and documentation render normally
          if (typeof guestSession.setUserAgent === 'function') {
            guestSession.setUserAgent(
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            );
          }

          if (typeof guestSession.setPermissionRequestHandler === 'function') {
            guestSession.setPermissionRequestHandler((webContents, permission, callback) => {
              const BLOCKED = ['media', 'camera', 'microphone', 'geolocation', 'notifications', 'midi'];
              callback(!BLOCKED.includes(permission));
            });
          }

          // Every top-level navigation in a guest tab passes the search policy first.
          // webRequest also covers loadURL() calls, which never fire 'will-navigate'.
          if (guestSession.webRequest && typeof guestSession.webRequest.onBeforeRequest === 'function') {
            guestSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
              if (details.resourceType !== 'mainFrame' || !this.searchPolicy) return callback({});
              if (this.backendUrl && details.url.startsWith(this.backendUrl)) return callback({});
              const verdict = this.searchPolicy.evaluate(details.url);
              if (verdict.action === 'rewrite') return callback({ redirectURL: verdict.url });
              if (verdict.action === 'block') {
                this.reportBlocked(verdict, details.url);
                const params = new URLSearchParams({ reason: verdict.reason, detail: verdict.detail || '', q: verdict.query || '', site: verdict.service || '' });
                return callback({ redirectURL: `${this.backendUrl}/blocked.html?${params}` });
              }
              return callback({});
            });
          }

          // Strip restrictive embedding headers on guest web search tabs
          if (guestSession.webRequest && typeof guestSession.webRequest.onHeadersReceived === 'function') {
            guestSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
              const responseHeaders = {};
              for (const [key, value] of Object.entries(details.responseHeaders || {})) {
                const lower = key.toLowerCase();
                if (lower === 'x-frame-options' || lower === 'frame-options') {
                  continue;
                }
                if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
                  const cleaned = (Array.isArray(value) ? value : [value]).map(csp =>
                    csp.replace(/frame-ancestors[^;]+;?/gi, '')
                  );
                  responseHeaders[key] = cleaned;
                  continue;
                }
                responseHeaders[key] = value;
              }
              callback({ cancel: false, responseHeaders });
            });
          }
        }
      }
    } catch (_) {
      // In test environment without native Electron
    }
  }

  createView(webPreferences = {}) {
    if (typeof this.viewFactory === 'function') {
      return this.viewFactory(webPreferences);
    }
    try {
      const { WebContentsView } = require('electron');
      return new WebContentsView({
        webPreferences: {
          partition: this.guestPartition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: this.preloadPath,
          allowRunningInsecureContent: true,
          javascript: true,
          webSecurity: false,
          ...webPreferences
        }
      });
    } catch (err) {
      // Graceful fallback if native WebContentsView is unavailable
      return null;
    }
  }

  createTab(targetUrl = 'about:blank') {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error(`Maximum concurrent tabs reached (${this.maxTabs})`);
    }

    const sanitizedUrl = this.sanitizeAndValidateUrl(targetUrl);
    const tabId = `tab_${crypto.randomUUID()}`;
    const isAi = this.checkIsAiDomain(sanitizedUrl);

    let view = null;
    try {
      view = this.createView();
    } catch (_) {
      // Fallback for mock environments
    }

    const tab = {
      id: tabId,
      index: this.tabs.size,
      title: this.deriveTitleFromUrl(sanitizedUrl),
      url: sanitizedUrl,
      isPinned: false,
      canClose: true,
      isActive: false,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      createdAt: Date.now(),
      lastActivatedAt: Date.now(),
      activeDurationMs: 0,
      isAiTool: isAi,
      view
    };

    // Attach view listeners if present
    if (view && view.webContents) {
      this.attachWebContentsListeners(tab, view.webContents);
      if (typeof view.webContents.loadURL === 'function') {
        view.webContents.loadURL(sanitizedUrl).catch(() => {});
      }
    }

    this.tabs.set(tabId, tab);

    // Switch to newly created tab
    this.switchTab(tabId);

    // Dispatch TAB_NAVIGATE telemetry for initial tab load
    this.dispatchTelemetry('TAB_NAVIGATE', {
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      timestamp: Date.now()
    });

    return tabId;
  }

  attachWebContentsListeners(tab, webContents) {
    if (typeof webContents.on !== 'function') return;

    webContents.on('did-start-loading', () => {
      tab.isLoading = true;
      this.notifyTabUpdated(tab);
    });

    webContents.on('did-stop-loading', () => {
      tab.isLoading = false;
      this.notifyTabUpdated(tab);
    });

    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.log(`[GuestTab Fail] ${errorCode}: ${errorDescription} on ${validatedURL}`);
    });

    webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.title;
      this.notifyTabUpdated(tab);
    });

    webContents.on('did-navigate', (_event, url) => {
      this.handleWebContentsNavigate(tab, url);
    });

    webContents.on('did-navigate-in-page', (_event, url) => {
      this.handleWebContentsNavigate(tab, url);
    });

    webContents.on('will-navigate', (event, url) => {
      try {
        const u = new URL(url);
        if (!['http:', 'https:', 'about:'].includes(u.protocol)) {
          event.preventDefault();
        }
      } catch (_) {
        event.preventDefault();
      }
    });

    if (typeof webContents.setWindowOpenHandler === 'function') {
      webContents.setWindowOpenHandler(({ url }) => {
        try {
          const u = new URL(url);
          if (['http:', 'https:'].includes(u.protocol)) {
            this.createTab(url);
          }
        } catch (_) {}
        return { action: 'deny' };
      });
    }
  }

  handleWebContentsNavigate(tab, url) {
    tab.url = url;
    tab.title = this.deriveTitleFromUrl(url);
    tab.isAiTool = this.checkIsAiDomain(url);

    this.dispatchTelemetry('TAB_NAVIGATE', {
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      timestamp: Date.now()
    });

    this.notifyTabUpdated(tab);
  }

  switchTab(tabId) {
    // Also accept 0 as shorthand for assessmentTabId
    const resolvedId = tabId === 0 ? this.assessmentTabId : tabId;
    if (!this.tabs.has(resolvedId)) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    if (resolvedId === this.activeTabId) {
      return {
        previousTabId: resolvedId,
        activeTabId: resolvedId,
        tab: this.tabs.get(resolvedId)
      };
    }

    const now = Date.now();
    const prevTab = this.tabs.get(this.activeTabId);
    let durationMs = 0;

    if (prevTab) {
      durationMs = Math.max(0, now - (prevTab.lastActivatedAt || prevTab.createdAt || now));
      prevTab.activeDurationMs = (prevTab.activeDurationMs || 0) + durationMs;
      prevTab.isActive = false;

      // Dispatches TAB_SWITCH telemetry with accumulated duration on previous tab
      this.dispatchTelemetry('TAB_SWITCH', {
        tabId: prevTab.id,
        title: prevTab.title,
        url: prevTab.url,
        duration: durationMs,
        timestamp: now
      });

      // Detach previous view from mainWindow if present
      if (prevTab.view && this.mainWindow && this.mainWindow.contentView) {
        try {
          this.mainWindow.contentView.removeChildView(prevTab.view);
        } catch (_) {}
      }
    }

    const newTab = this.tabs.get(resolvedId);
    newTab.isActive = true;
    newTab.lastActivatedAt = now;
    this.activeTabId = resolvedId;

    // Attach new view to mainWindow if present
    if (newTab.view && this.mainWindow && this.mainWindow.contentView) {
      try {
        this.mainWindow.contentView.addChildView(newTab.view);
        newTab.view.setBounds(this.getGuestBounds());
      } catch (_) {}
    }

    this.notifyTabUpdated(newTab);

    return {
      previousTabId: prevTab ? prevTab.id : null,
      activeTabId: resolvedId,
      tab: newTab
    };
  }

  closeTab(tabId) {
    const resolvedId = tabId === 0 ? this.assessmentTabId : tabId;
    const tab = this.tabs.get(resolvedId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    if (tab.isPinned || !tab.canClose || resolvedId === this.assessmentTabId) {
      throw new Error('Pinned assessment tab cannot be closed');
    }

    // If active tab is being closed, switch to adjacent or fallback to pinned tab
    if (this.activeTabId === resolvedId) {
      const remainingTabs = Array.from(this.tabs.values()).filter(t => t.id !== resolvedId);
      const fallbackTab = remainingTabs.length > 0 ? remainingTabs[remainingTabs.length - 1] : null;
      const targetId = fallbackTab ? fallbackTab.id : this.assessmentTabId;
      this.switchTab(targetId);
    }

    // Clean up view
    if (tab.view) {
      if (this.mainWindow && this.mainWindow.contentView) {
        try {
          this.mainWindow.contentView.removeChildView(tab.view);
        } catch (_) {}
      }
      if (tab.view.webContents && typeof tab.view.webContents.close === 'function') {
        try {
          tab.view.webContents.close();
        } catch (_) {}
      }
      tab.view = null;
    }

    this.tabs.delete(resolvedId);
    this.reindexTabs();

    const activeTab = this.tabs.get(this.activeTabId);
    if (activeTab) {
      this.notifyTabUpdated(activeTab);
    }

    return true;
  }

  navigateTab(tabId, rawUrl) {
    const resolvedId = tabId === 0 ? this.assessmentTabId : tabId;
    const tab = this.tabs.get(resolvedId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    if (tab.isPinned || resolvedId === this.assessmentTabId) {
      throw new Error('Pinned assessment tab cannot navigate to external URLs');
    }

    const validatedUrl = this.sanitizeAndValidateUrl(rawUrl);
    tab.url = validatedUrl;
    tab.title = this.deriveTitleFromUrl(validatedUrl);
    tab.isAiTool = this.checkIsAiDomain(validatedUrl);

    if (tab.view && tab.view.webContents && typeof tab.view.webContents.loadURL === 'function') {
      tab.view.webContents.loadURL(validatedUrl).catch(() => {});
    }

    this.dispatchTelemetry('TAB_NAVIGATE', {
      tabId: tab.id,
      title: tab.title,
      url: validatedUrl,
      timestamp: Date.now()
    });

    this.notifyTabUpdated(tab);
    return tab;
  }

  getGuestBounds() {
    if (!this.mainWindow || typeof this.mainWindow.getContentBounds !== 'function') {
      return { x: 0, y: this.topBarHeight, width: 1200, height: 724 };
    }
    const bounds = this.mainWindow.getContentBounds();
    return {
      x: 0,
      y: this.topBarHeight,
      width: Math.max(0, bounds.width),
      height: Math.max(0, bounds.height - this.topBarHeight)
    };
  }

  updateActiveViewBounds() {
    const activeTab = this.tabs.get(this.activeTabId);
    if (activeTab && activeTab.view && typeof activeTab.view.setBounds === 'function') {
      activeTab.view.setBounds(this.getGuestBounds());
    }
  }

  sanitizeAndValidateUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return 'https://www.google.com';
    }

    const trimmed = rawUrl.trim();
    if (trimmed === 'about:blank') {
      return 'about:blank';
    }

    // Check if it starts with a protocol scheme
    if (/^https?:\/\//i.test(trimmed)) {
      let urlObj;
      try {
        urlObj = new URL(trimmed);
      } catch (_) {
        throw new Error(`Malformed URL: ${rawUrl}`);
      }

      const protocol = urlObj.protocol.toLowerCase();
      if (BLOCKED_PROTOCOLS.includes(protocol) || (protocol === 'about:' && urlObj.href !== 'about:blank')) {
        throw new Error(`Security Exception: Blocked protocol scheme '${protocol}'`);
      }

      if (!ALLOWED_PROTOCOLS.includes(protocol)) {
        throw new Error(`Security Exception: Protocol '${protocol}' is not whitelisted`);
      }

      return urlObj.href;
    }

    // Check if it's explicitly a blocked protocol like data:, file:, javascript:
    const schemeMatch = trimmed.match(/^([a-zA-Z0-9+.-]+):/);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase() + ':';
      if (BLOCKED_PROTOCOLS.includes(scheme)) {
        throw new Error(`Security Exception: Blocked protocol scheme '${scheme}'`);
      }
    }

    // Check if it's a domain name with a TLD or IP address and NO spaces
    const isDomain = !trimmed.includes(' ') && (
      /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed) ||
      /^localhost(:\d+)?(\/.*)?$/i.test(trimmed) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)
    );

    if (isDomain) {
      return new URL(`https://${trimmed}`).href;
    }

    // Plain text queries (single words or phrases like "chatgpt", "quicksort algorithm", "math")
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }

  deriveTitleFromUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.protocol === 'about:') return 'New Tab';
      return u.hostname || 'Web Page';
    } catch {
      return 'Web Page';
    }
  }

  checkIsAiDomain(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      return AI_DOMAINS.some(d => host.includes(d));
    } catch {
      return false;
    }
  }

  reindexTabs() {
    let idx = 0;
    for (const tab of this.tabs.values()) {
      tab.index = idx++;
    }
  }

  getTabSummary(tab) {
    if (!tab) return null;
    return {
      id: tab.id,
      index: tab.index,
      title: tab.title,
      url: tab.url,
      isPinned: tab.isPinned,
      canClose: tab.canClose,
      isActive: tab.isActive,
      isLoading: tab.isLoading,
      isAiTool: tab.isAiTool
    };
  }

  getTabsSummary() {
    return Array.from(this.tabs.values()).map(t => this.getTabSummary(t));
  }

  getActiveTab() {
    return this.tabs.get(this.activeTabId) || null;
  }

  notifyTabUpdated(tab) {
    const payload = {
      ...this.getTabSummary(tab),
      allTabs: this.getTabsSummary()
    };

    if (this.mainWindow && this.mainWindow.webContents && typeof this.mainWindow.webContents.send === 'function') {
      try {
        this.mainWindow.webContents.send('tab:updated', payload);
        this.mainWindow.webContents.send('TAB_UPDATED', payload);
      } catch (_) {}
    }

    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (_) {}
    }
  }

  onTabUpdated(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
    this.flushTelemetryBuffer();
  }

  setBackendUrl(url) {
    this.backendUrl = url;
    this.flushTelemetryBuffer();
  }

  setBackendPort(port) {
    this.backendPort = port;
    this.backendUrl = `http://127.0.0.1:${port}`;
    const pinned = this.tabs.get(this.assessmentTabId);
    if (pinned) {
      pinned.url = `http://127.0.0.1:${port}/app/assessment`;
    }
    this.flushTelemetryBuffer();
  }

  /** Logs a blocked navigation and tells the exam UI so it can explain (and offer guided help). */
  reportBlocked(verdict, url) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send('policy:blocked', { reason: verdict.reason, detail: verdict.detail, query: verdict.query || null, site: verdict.service || null });
    }
    if (!this.fetchFn || !this.sessionId || !this.backendUrl) return;
    this.fetchFn(`${this.backendUrl}/api/proctor/search-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        service: verdict.service || (verdict.reason === 'AI_SITE' ? 'AI assistant' : 'Web search'),
        query: verdict.query || `Tried to open ${verdict.service || url}`,
        url,
        isFlaggedAiTool: verdict.reason === 'AI_SITE',
        blocked: true,
        blockReason: verdict.reason
      })
    }).catch(() => {});
  }

  async dispatchTelemetry(type, payload) {
    if (!this.fetchFn) return;

    if (!this.sessionId || !this.backendUrl) {
      this.telemetryBuffer.push({ type, payload });
      return;
    }

    const body = {
      sessionId: this.sessionId,
      type,
      ...payload
    };

    try {
      await this.fetchFn(`${this.backendUrl}/api/proctor/tab-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (_) {
      // Buffer on network error for resilience
      this.telemetryBuffer.push({ type, payload });
    }
  }

  flushTelemetryBuffer() {
    if (!this.sessionId || !this.backendUrl || this.telemetryBuffer.length === 0) return;
    const queue = [...this.telemetryBuffer];
    this.telemetryBuffer = [];
    for (const item of queue) {
      this.dispatchTelemetry(item.type, item.payload);
    }
  }

  registerIpcHandlers(ipc, mainWindow) {
    if (!ipc) return;

    ipc.handle('tab:create', async (_event, url) => {
      return this.createTab(url);
    });

    ipc.handle('tab:switch', async (_event, tabId) => {
      const res = this.switchTab(tabId);
      return {
        previousTabId: res.previousTabId,
        activeTabId: res.activeTabId,
        tab: this.getTabSummary(res.tab)
      };
    });

    ipc.handle('tab:close', async (_event, tabId) => {
      return this.closeTab(tabId);
    });

    ipc.handle('tab:navigate', async (_event, tabId, url) => {
      const tab = this.navigateTab(tabId, url);
      return this.getTabSummary(tab);
    });

    ipc.handle('tab:get-all', async () => {
      return this.getTabsSummary();
    });

    ipc.handle('tab:get-active', async () => {
      return this.getTabSummary(this.getActiveTab());
    });
  }

  destroy() {
    for (const tab of this.tabs.values()) {
      if (tab.view && tab.view.webContents && typeof tab.view.webContents.close === 'function') {
        try { tab.view.webContents.close(); } catch (_) {}
      }
    }
    this.tabs.clear();
    this.listeners.clear();
  }
}

const tabManager = new TabManager();

module.exports = {
  TabManager,
  tabManager,
  BLOCKED_PROTOCOLS,
  ALLOWED_PROTOCOLS,
  AI_DOMAINS
};
