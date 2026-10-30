/**
 * Search Query & AI Prompt Interceptor Engine
 * Extracts and classifies search engine queries and AI assistant prompts.
 */

const http = require('node:http');

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

const AI_SERVICES = [
  'chatgpt',
  'claude',
  'copilot',
  'deepseek',
  'perplexity',
  'gemini',
  'openai'
];

class SearchTracker {
  constructor(options = {}) {
    this.backendPort = options.backendPort || 4100;
    this.currentSessionId = options.sessionId || null;
    this.host = options.host || '127.0.0.1';
    this.transport = http;
    // Central-server deployments pass a full URL (possibly https) instead of a local port.
    if (options.backendUrl) {
      const u = new URL(options.backendUrl);
      this.host = u.hostname;
      this.transport = u.protocol === 'https:' ? require('node:https') : http;
      this.backendPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    }
  }

  setSessionId(sessionId) {
    this.currentSessionId = sessionId;
  }

  setBackendPort(port) {
    this.backendPort = port;
  }

  /** Points search-event reporting at another exam server (e.g. the proctor's laptop). */
  setBackendUrl(backendUrl) {
    const u = new URL(backendUrl);
    this.host = u.hostname;
    this.transport = u.protocol === 'https:' ? require('node:https') : http;
    this.backendPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  }

  /**
   * Pure function to extract search query or AI prompt from an arbitrary URL.
   * Returns: { service: string, query: string, url: string, isFlaggedAiTool: boolean } | null
   */
  static extractSearchQuery(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
      return null;
    }

    let u;
    try {
      u = new URL(targetUrl.trim());
    } catch {
      return null;
    }

    // Only process http / https URLs
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return null;
    }

    const host = u.hostname.toLowerCase();
    const params = u.searchParams;

    // 1. AI Service Subdomains & Hostnames (evaluated before generic search)
    if (host.includes('gemini.google.com')) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'Gemini',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    if (
      host.includes('chatgpt.com') ||
      host.includes('chat.openai.com') ||
      (host.includes('openai.com') && (u.pathname.includes('/chat') || params.has('q') || params.has('prompt')))
    ) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'ChatGPT',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    if (
      host.includes('claude.ai') ||
      (host.includes('anthropic.com') && (u.pathname.includes('/chat') || params.has('q') || params.has('prompt')))
    ) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'Claude',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    if (host.includes('perplexity.ai')) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'Perplexity',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    if (host.includes('copilot.microsoft.com')) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'Copilot',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    if (host.includes('deepseek.com')) {
      const q = params.get('q') || params.get('prompt') || '';
      return {
        service: 'DeepSeek',
        query: q,
        url: targetUrl,
        isFlaggedAiTool: true
      };
    }

    // 2. Standard Search Engines
    // Google (excluding gemini.google.com handled above)
    if (host.includes('google.') && params.has('q')) {
      return {
        service: 'Google',
        query: params.get('q'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    // Bing
    if (host.includes('bing.com') && params.has('q')) {
      return {
        service: 'Bing',
        query: params.get('q'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    // DuckDuckGo
    if (host.includes('duckduckgo.com') && params.has('q')) {
      return {
        service: 'DuckDuckGo',
        query: params.get('q'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    // Yahoo (uses 'p' query param)
    if (host.includes('yahoo.com') && params.has('p')) {
      return {
        service: 'Yahoo',
        query: params.get('p'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    // Baidu
    if (host.includes('baidu.com') && (params.has('wd') || params.has('word'))) {
      return {
        service: 'Baidu',
        query: params.get('wd') || params.get('word'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    // Ecosia
    if (host.includes('ecosia.org') && params.has('q')) {
      return {
        service: 'Ecosia',
        query: params.get('q'),
        url: targetUrl,
        isFlaggedAiTool: false
      };
    }

    return null;
  }

  /**
   * Helper to format direct AI prompt submissions (from DOM/network interceptor).
   */
  static interceptAIPrompt(service, promptText, targetUrl) {
    if (!promptText || typeof promptText !== 'string') {
      return null;
    }
    const cleanPrompt = promptText.trim();
    if (!cleanPrompt) return null;

    const svc = service || 'AI Assistant';
    return {
      service: svc,
      query: cleanPrompt,
      url: targetUrl || `https://${svc.toLowerCase().replace(/[^a-z0-9]/g, '')}.com/chat`,
      isFlaggedAiTool: true,
      timestamp: Date.now()
    };
  }

  /**
   * Dispatches an intercepted search or AI event to the local backend service.
   */
  async dispatchSearchEvent(event, sessionId = this.currentSessionId) {
    if (!sessionId) {
      console.warn('[SearchTracker] No active sessionId set; skipping search-event dispatch.');
      return false;
    }
    if (!event || !event.service || event.query === undefined) {
      return false;
    }

    const payload = JSON.stringify({
      sessionId,
      service: event.service,
      query: event.query,
      url: event.url || '',
      isFlaggedAiTool: Boolean(event.isFlaggedAiTool),
      timestamp: event.timestamp || Date.now()
    });

    return new Promise((resolve) => {
      const req = this.transport.request({
        hostname: this.host,
        port: this.backendPort,
        path: '/api/proctor/search-event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 2000
      }, (res) => {
        res.resume(); // Drain stream
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });

      req.on('error', (err) => {
        console.error('[SearchTracker] Failed to dispatch search event to backend:', err.message);
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Helper attached to WebContents navigation events.
   */
  async handleNavigation(url, tabId, sessionId = this.currentSessionId) {
    const extracted = SearchTracker.extractSearchQuery(url);
    if (extracted && extracted.query !== '') {
      await this.dispatchSearchEvent({
        ...extracted,
        tabId,
        timestamp: Date.now()
      }, sessionId);
      return extracted;
    }
    return null;
  }
}

module.exports = {
  SearchTracker,
  AI_DOMAINS,
  AI_SERVICES
};
