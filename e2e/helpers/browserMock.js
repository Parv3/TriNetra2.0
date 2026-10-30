/**
 * Browser & Preload Bridge Simulation Helper for E2E Testing
 *
 * Simulates:
 * 1. window.proctorAPI preload contract (lifecycle, tabs, telemetry, window controls)
 * 2. Multi-tab manager state and pinned assessment tab protection
 * 3. Protocol whitelisting (http/https allowed; file/javascript/data blocked)
 * 4. Search query extractor (Google, Bing, DuckDuckGo, Yahoo)
 * 5. AI Prompt capture hooks (ChatGPT, Claude)
 * 6. Keystroke shortcut detection and throttled mouse burst logging
 */

const crypto = require('node:crypto');

const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:', 'chrome:', 'vbscript:', 'about:'];
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

class BrowserMock {
  constructor(options = {}) {
    this.backendPort = options.backendPort || 4100;
    this.appVersion = options.appVersion || '1.0.0-competition';
    this.maxTabs = options.maxTabs || 20;

    // Tabs state
    this.tabs = new Map();
    this.activeTabId = null;
    this.tabListeners = [];
    this.warningListeners = [];
    this.disqualifyListeners = [];
    this.loggedActivities = [];

    // Initialize pinned assessment tab
    this.assessmentTabId = 'tab_assessment_pinned';
    this.tabs.set(this.assessmentTabId, {
      id: this.assessmentTabId,
      url: `http://127.0.0.1:${this.backendPort}/app/assessment`,
      title: 'Active Assessment',
      isPinned: true,
      canClose: false,
      createdAt: Date.now()
    });
    this.activeTabId = this.assessmentTabId;
  }

  // --- window.proctorAPI Implementation ---
  get proctorAPI() {
    return {
      getBackendPort: async () => this.backendPort,
      getAppVersion: async () => this.appVersion,

      createTab: async (targetUrl = 'about:blank') => {
        return this.createTab(targetUrl);
      },

      switchTab: async (tabId) => {
        return this.switchTab(tabId);
      },

      closeTab: async (tabId) => {
        return this.closeTab(tabId);
      },

      navigateTab: async (tabId, targetUrl) => {
        return this.navigateTab(tabId, targetUrl);
      },

      onTabUpdated: (callback) => {
        this.tabListeners.push(callback);
        return () => {
          const idx = this.tabListeners.indexOf(callback);
          if (idx !== -1) this.tabListeners.splice(idx, 1);
        };
      },

      logActivity: async (event) => {
        this.loggedActivities.push({ ...event, recordedAt: Date.now() });
      },

      onProctorWarning: (callback) => {
        this.warningListeners.push(callback);
        return () => {
          const idx = this.warningListeners.indexOf(callback);
          if (idx !== -1) this.warningListeners.splice(idx, 1);
        };
      },

      onDisqualify: (callback) => {
        this.disqualifyListeners.push(callback);
        return () => {
          const idx = this.disqualifyListeners.indexOf(callback);
          if (idx !== -1) this.disqualifyListeners.splice(idx, 1);
        };
      },

      minimizeWindow: () => { this.windowState = 'minimized'; },
      maximizeWindow: () => { this.windowState = 'maximized'; },
      closeWindow: () => { this.windowState = 'closed'; }
    };
  }

  // --- Tab Management ---
  createTab(targetUrl = 'https://www.google.com') {
    if (this.tabs.size >= this.maxTabs) {
      throw new Error(`Maximum concurrent tabs reached (${this.maxTabs})`);
    }

    const tabId = `tab_${crypto.randomUUID()}`;
    const sanitizedUrl = this.sanitizeAndValidateUrl(targetUrl);

    const tab = {
      id: tabId,
      url: sanitizedUrl,
      title: 'New Tab',
      isPinned: false,
      canClose: true,
      createdAt: Date.now()
    };

    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;
    this.notifyTabUpdated(tab);
    return tabId;
  }

  switchTab(tabId) {
    if (!this.tabs.has(tabId)) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    const previousTabId = this.activeTabId;
    this.activeTabId = tabId;
    const tab = this.tabs.get(tabId);

    // Emits tab update
    this.notifyTabUpdated(tab);

    return {
      previousTabId,
      activeTabId: tabId,
      tab
    };
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    if (tab.isPinned || !tab.canClose) {
      throw new Error('Pinned assessment tab cannot be closed');
    }

    this.tabs.delete(tabId);

    // If active tab was closed, switch back to pinned assessment tab
    if (this.activeTabId === tabId) {
      this.activeTabId = this.assessmentTabId;
    }

    return true;
  }

  navigateTab(tabId, targetUrl) {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    const validatedUrl = this.sanitizeAndValidateUrl(targetUrl);
    tab.url = validatedUrl;
    tab.title = this.deriveTitleFromUrl(validatedUrl);

    this.notifyTabUpdated(tab);
    return tab;
  }

  sanitizeAndValidateUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return 'about:blank';
    }

    let urlObj;
    try {
      urlObj = new URL(rawUrl.trim());
    } catch (err) {
      // Try prepending https:// if missing scheme
      try {
        urlObj = new URL(`https://${rawUrl.trim()}`);
      } catch (innerErr) {
        throw new Error(`Malformed URL: ${rawUrl}`);
      }
    }

    const protocol = urlObj.protocol.toLowerCase();
    if (BLOCKED_PROTOCOLS.includes(protocol)) {
      throw new Error(`Security Exception: Blocked protocol scheme '${protocol}'`);
    }

    if (!ALLOWED_PROTOCOLS.includes(protocol) && protocol !== 'about:') {
      throw new Error(`Security Exception: Protocol '${protocol}' is not whitelisted`);
    }

    return urlObj.href;
  }

  deriveTitleFromUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      return u.hostname || 'Web Page';
    } catch {
      return 'Web Page';
    }
  }

  notifyTabUpdated(tab) {
    for (const listener of this.tabListeners) {
      try {
        listener(tab);
      } catch (err) {
        // Safe listener execution
      }
    }
  }

  // --- Search Engine Query Extractor ---
  static extractSearchQuery(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return null;

    try {
      const u = new URL(targetUrl);
      const host = u.hostname.toLowerCase();

      // Google
      if (host.includes('google.') && u.searchParams.has('q')) {
        return {
          service: 'Google',
          query: u.searchParams.get('q'),
          url: targetUrl
        };
      }

      // Bing
      if (host.includes('bing.com') && u.searchParams.has('q')) {
        return {
          service: 'Bing',
          query: u.searchParams.get('q'),
          url: targetUrl
        };
      }

      // DuckDuckGo
      if (host.includes('duckduckgo.com') && u.searchParams.has('q')) {
        return {
          service: 'DuckDuckGo',
          query: u.searchParams.get('q'),
          url: targetUrl
        };
      }

      // Yahoo
      if (host.includes('yahoo.com') && u.searchParams.has('p')) {
        return {
          service: 'Yahoo',
          query: u.searchParams.get('p'),
          url: targetUrl
        };
      }

      // ChatGPT
      if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
        // Query param or prompt path
        const q = u.searchParams.get('q') || u.searchParams.get('prompt') || '';
        return {
          service: 'ChatGPT',
          query: q,
          url: targetUrl
        };
      }

      // Claude
      if (host.includes('claude.ai')) {
        const q = u.searchParams.get('q') || u.searchParams.get('prompt') || '';
        return {
          service: 'Claude',
          query: q,
          url: targetUrl
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // --- AI Service Interceptor Helper ---
  static interceptAIPrompt(service, promptText, targetUrl) {
    if (!promptText || typeof promptText !== 'string') {
      return null;
    }
    const cleanPrompt = promptText.trim();
    if (!cleanPrompt) return null;

    return {
      service: service || 'AI Assistant',
      query: cleanPrompt,
      url: targetUrl || `https://${(service || 'ai').toLowerCase()}.com/chat`,
      timestamp: Date.now()
    };
  }

  // --- Input Tracking Aggregator ---
  static aggregateMouseActivity(movements, intervalMs = 500) {
    if (!Array.isArray(movements) || movements.length === 0) {
      return [];
    }

    const bursts = [];
    let currentBurst = {
      startTime: movements[0].timestamp,
      count: 0,
      totalDistance: 0,
      lastX: movements[0].x,
      lastY: movements[0].y
    };

    for (const m of movements) {
      if (m.timestamp - currentBurst.startTime > intervalMs) {
        if (currentBurst.count > 0) {
          bursts.push({
            timestamp: currentBurst.startTime,
            durationMs: intervalMs,
            moveCount: currentBurst.count,
            distance: Math.round(currentBurst.totalDistance)
          });
        }
        currentBurst = {
          startTime: m.timestamp,
          count: 1,
          totalDistance: 0,
          lastX: m.x,
          lastY: m.y
        };
      } else {
        const dx = m.x - currentBurst.lastX;
        const dy = m.y - currentBurst.lastY;
        currentBurst.totalDistance += Math.sqrt(dx * dx + dy * dy);
        currentBurst.count += 1;
        currentBurst.lastX = m.x;
        currentBurst.lastY = m.y;
      }
    }

    if (currentBurst.count > 0) {
      bursts.push({
        timestamp: currentBurst.startTime,
        durationMs: intervalMs,
        moveCount: currentBurst.count,
        distance: Math.round(currentBurst.totalDistance)
      });
    }

    return bursts;
  }
}

module.exports = { BrowserMock, BLOCKED_PROTOCOLS, ALLOWED_PROTOCOLS };
