/**
 * Guest Preload Script
 * Injected into guest web tabs (partition 'persist:guest-session')
 * Intercepts AI prompts, search queries, disallowed shortcuts, and mouse bursts.
 */

(function () {
  'use strict';

  let ipcRenderer = null;
  try {
    const electron = require('electron');
    ipcRenderer = electron.ipcRenderer;
  } catch (_) {}

  const STATE = {
    mouse: {
      startTime: 0,
      count: 0,
      totalDistance: 0,
      lastX: 0,
      lastY: 0,
      timer: null
    },
    lastInterceptedQuery: '',
    lastInterceptedAt: 0
  };

  /**
   * Safely forward guest telemetry to the main process.
   */
  function emitGuestEvent(channel, payload) {
    if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return;
    try {
      ipcRenderer.send('proctor:guest-event', {
        channel,
        ...payload,
        timestamp: payload.timestamp || Date.now()
      });
    } catch (_) {
      // Avoid breaking guest tab if IPC fails
    }
  }

  // =========================================================================
  // 1. DOM AI Prompt Interception (ChatGPT, Claude, Perplexity)
  // =========================================================================

  function notifyPromptIntercepted(service, queryText) {
    if (!queryText || typeof queryText !== 'string') return;
    const clean = queryText.trim();
    if (!clean || clean.length < 2) return;

    // Deduplicate rapid dual events (DOM submit + network request within 1s)
    const now = Date.now();
    if (STATE.lastInterceptedQuery === clean && now - STATE.lastInterceptedAt < 1000) {
      return;
    }
    STATE.lastInterceptedQuery = clean;
    STATE.lastInterceptedAt = now;

    const currentUrl = typeof window !== 'undefined' && window.location ? window.location.href : '';

    emitGuestEvent('search-event', {
      service,
      query: clean,
      url: currentUrl,
      isFlaggedAiTool: true,
      detectionMethod: 'dom_interception'
    });
  }

  function setupChatGPTInterceptor() {
    if (typeof window === 'undefined' || !window.location) return;
    const host = window.location.hostname ? window.location.hostname.toLowerCase() : '';
    if (!host.includes('chatgpt.com') && !host.includes('openai.com')) return;

    function getPromptText() {
      const el = document.querySelector('#prompt-textarea') ||
                 document.querySelector('div[contenteditable="true"]') ||
                 document.querySelector('textarea[data-id="root"]');
      if (!el) return '';
      return el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
    }

    // Enter key submit on prompt input
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const target = e.target;
        if (target && (target.id === 'prompt-textarea' || target.getAttribute('contenteditable') === 'true' || target.tagName === 'TEXTAREA')) {
          const text = getPromptText();
          if (text) notifyPromptIntercepted('ChatGPT', text);
        }
      }
    }, true);

    // Send button click
    document.addEventListener('click', (e) => {
      const btn = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('button[data-testid="send-button"], button[aria-label="Send prompt"], button[data-testid="fruitjuice-send-button"]')
        : null;
      if (btn) {
        const text = getPromptText();
        if (text) notifyPromptIntercepted('ChatGPT', text);
      }
    }, true);
  }

  function setupClaudeInterceptor() {
    if (typeof window === 'undefined' || !window.location) return;
    const host = window.location.hostname ? window.location.hostname.toLowerCase() : '';
    if (!host.includes('claude.ai')) return;

    function getClaudePromptText() {
      const el = document.querySelector('div.ProseMirror[contenteditable="true"]') ||
                 document.querySelector('div[contenteditable="true"]') ||
                 document.querySelector('fieldset div[contenteditable="true"]');
      if (!el) return '';
      return el.innerText || el.textContent || '';
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        const target = e.target;
        if (target && target.getAttribute('contenteditable') === 'true') {
          const text = getClaudePromptText();
          if (text) notifyPromptIntercepted('Claude', text);
        }
      }
    }, true);

    document.addEventListener('click', (e) => {
      const btn = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('button[aria-label="Send Message"], button[aria-label="Send message"]')
        : null;
      if (btn) {
        const text = getClaudePromptText();
        if (text) notifyPromptIntercepted('Claude', text);
      }
    }, true);
  }

  // =========================================================================
  // 2. Asynchronous Network Interception (window.fetch & XMLHttpRequest)
  // =========================================================================

  function parseAiPayload(urlStr, bodyStr) {
    if (!bodyStr || typeof bodyStr !== 'string') return null;

    try {
      const body = JSON.parse(bodyStr);

      // ChatGPT: /backend-api/conversation
      if (urlStr.includes('/backend-api/conversation')) {
        if (Array.isArray(body.messages)) {
          const userMsg = body.messages.find(m => m.author && m.author.role === 'user') || body.messages[body.messages.length - 1];
          if (userMsg && userMsg.content && Array.isArray(userMsg.content.parts)) {
            return { service: 'ChatGPT', query: userMsg.content.parts.join('\n') };
          }
        }
      }

      // Claude: /chat_conversations/*/completion or /chat_conversations
      if (urlStr.includes('/chat_conversations') || urlStr.includes('/completion')) {
        if (typeof body.prompt === 'string') {
          return { service: 'Claude', query: body.prompt };
        }
        if (Array.isArray(body.messages)) {
          const lastMsg = body.messages[body.messages.length - 1];
          if (lastMsg && typeof lastMsg.content === 'string') {
            return { service: 'Claude', query: lastMsg.content };
          }
        }
      }
    } catch (_) {}

    return null;
  }

  // Injected into the guest page's Main World to intercept native fetch/XHR
  function injectMainWorldNetworkHook() {
    if (typeof document === 'undefined') return;

    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
          window.fetch = async function(...args) {
            try {
              const [resource, config] = args;
              const url = typeof resource === 'string' ? resource : (resource ? resource.url : '');
              if (config && config.method && config.method.toUpperCase() === 'POST' && config.body) {
                window.postMessage({ type: '__PROCTOR_NET_REQ__', url, body: config.body }, '*');
              }
            } catch(e) {}
            return origFetch.apply(this, args);
          };
        }

        if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._proctorMethod = method;
            this._proctorUrl = url;
            return origOpen.apply(this, [method, url, ...rest]);
          };
          XMLHttpRequest.prototype.send = function(body) {
            try {
              if (this._proctorMethod && this._proctorMethod.toUpperCase() === 'POST' && body) {
                window.postMessage({ type: '__PROCTOR_NET_REQ__', url: this._proctorUrl, body }, '*');
              }
            } catch(e) {}
            return origSend.apply(this, [body]);
          };
        }
      })();
    `;
    (document.head || document.documentElement || document.body || {}).appendChild &&
      (document.head || document.documentElement || document.body).appendChild(script);
    if (script.parentNode) {
      script.remove();
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== '__PROCTOR_NET_REQ__') return;
        const parsed = parseAiPayload(event.data.url || '', event.data.body);
        if (parsed) {
          notifyPromptIntercepted(parsed.service, parsed.query);
        }
      });
    }
  }

  // =========================================================================
  // 3. Disallowed Hotkeys & Clipboard Logging
  // =========================================================================

  function isDisallowedShortcut(e) {
    const isAltTab = e.altKey && (e.key === 'Tab' || e.code === 'Tab');
    const isF12 = e.key === 'F12';
    const isDevTools = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j');
    const isViewSource = (e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U');
    if (isAltTab || isF12 || isDevTools || isViewSource) {
      return isAltTab ? 'Alt+Tab' : (isF12 ? 'F12' : (isDevTools ? 'DevTools' : 'Ctrl+U'));
    }
    return null;
  }

  function setupKeyboardAndClipboardInterceptors() {
    if (typeof document === 'undefined') return;

    document.addEventListener('keydown', (e) => {
      const keyName = isDisallowedShortcut(e);
      if (keyName) {
        emitGuestEvent('input-activity', {
          eventType: 'KEYSTROKE',
          type: 'KEYSTROKE',
          details: {
            key: e.key,
            code: e.code,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            name: keyName,
            isDevTools: keyName === 'F12' || keyName === 'DevTools'
          }
        });
      }
    }, true);

    document.addEventListener('copy', () => {
      const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection().toString() : '';
      emitGuestEvent('input-activity', {
        eventType: 'CLIPBOARD',
        type: 'CLIPBOARD',
        details: {
          action: 'COPY',
          length: selection.length,
          preview: selection.substring(0, 100)
        }
      });
    }, true);

    document.addEventListener('paste', (e) => {
      let pasteText = '';
      if (e.clipboardData) {
        pasteText = e.clipboardData.getData('text') || '';
      }
      emitGuestEvent('input-activity', {
        eventType: 'CLIPBOARD',
        type: 'CLIPBOARD',
        details: {
          action: 'PASTE',
          length: pasteText.length,
          preview: pasteText.substring(0, 100)
        }
      });
    }, true);

    if (typeof window !== 'undefined') {
      window.addEventListener('blur', () => {
        emitGuestEvent('input-activity', {
          eventType: 'WINDOW_BLUR',
          type: 'WINDOW_BLUR',
          details: { reason: 'Guest window lost focus' }
        });
      });

      window.addEventListener('focus', () => {
        emitGuestEvent('input-activity', {
          eventType: 'WINDOW_FOCUS',
          type: 'WINDOW_FOCUS',
          details: { reason: 'Guest window gained focus' }
        });
      });
    }

    document.addEventListener('mouseleave', () => {
      emitGuestEvent('input-activity', {
        eventType: 'MOUSE_LEAVE_WINDOW',
        type: 'MOUSE_LEAVE_WINDOW',
        details: { reason: 'Mouse exited viewport boundary' }
      });
    });
  }

  // =========================================================================
  // 4. Throttled Mouse Activity Aggregator (500ms Window)
  // =========================================================================

  function flushMouseBurst() {
    if (STATE.mouse.count > 0) {
      emitGuestEvent('input-activity', {
        eventType: 'MOUSE_BURST',
        type: 'MOUSE_BURST',
        details: {
          timestamp: STATE.mouse.startTime,
          durationMs: 500,
          moveCount: STATE.mouse.count,
          distance: Math.round(STATE.mouse.totalDistance)
        }
      });
    }
    STATE.mouse.count = 0;
    STATE.mouse.totalDistance = 0;
    STATE.mouse.startTime = 0;
    STATE.mouse.timer = null;
  }

  function setupMouseTracking() {
    if (typeof document === 'undefined') return;

    document.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (!STATE.mouse.startTime) {
        STATE.mouse.startTime = now;
        STATE.mouse.lastX = e.clientX;
        STATE.mouse.lastY = e.clientY;
        STATE.mouse.count = 1;
        STATE.mouse.totalDistance = 0;
        STATE.mouse.timer = setTimeout(flushMouseBurst, 500);
        return;
      }

      const dx = e.clientX - STATE.mouse.lastX;
      const dy = e.clientY - STATE.mouse.lastY;
      STATE.mouse.totalDistance += Math.sqrt(dx * dx + dy * dy);
      STATE.mouse.count += 1;
      STATE.mouse.lastX = e.clientX;
      STATE.mouse.lastY = e.clientY;
    }, { passive: true });
  }

  // =========================================================================
  // 5. Search-results sanitizer
  // Search engines now print answers above the results (AI summaries, answer boxes,
  // "People also ask"). Those are hidden so candidates see sources, not answers.
  // =========================================================================

  const ANSWER_BOX_SELECTORS = {
    'bing.com': ['#b_results .b_ans', '#b_context', '.b_ai', '#b_sydConvCont', '.rqnaContainer', '[data-tag="RelatedQnA"]', '.df_alaskaAns'],
    'duckduckgo.com': ['[data-react-module-id="assist"]', '[data-layout="ai"]', '.module--about', '[data-testid="answer"]'],
    'google.': ['[data-attrid="wa:/description"]', '.xpdopen', '.related-question-pair', '[jsname="N760b"]', '.kp-wholepage']
  };
  const ANSWER_HEADINGS = /^(ai overview|people also ask|featured snippet|copilot answer|search assist|related questions|ai-generated answer)$/i;

  function sanitizeSearchResults() {
    const host = window.location.hostname.toLowerCase();
    const key = Object.keys(ANSWER_BOX_SELECTORS).find(k => host.includes(k));
    if (!key) return;

    const hide = (el) => {
      if (el && el.style && el.dataset.trinetraHidden !== '1') {
        el.style.setProperty('display', 'none', 'important');
        el.dataset.trinetraHidden = '1';
      }
    };
    const sweep = () => {
      ANSWER_BOX_SELECTORS[key].forEach(sel => document.querySelectorAll(sel).forEach(hide));
      // Selector-free fallback: hide the block under any heading that labels an answer widget.
      document.querySelectorAll('h1, h2, h3, [role="heading"], span, div').forEach(el => {
        if (el.childElementCount === 0 && ANSWER_HEADINGS.test((el.textContent || '').trim())) {
          hide(el.closest('[data-hveid], [data-layout], .b_ans, li, section, block-component') || el.parentElement);
        }
      });
    };
    const style = document.createElement('style');
    style.textContent = ANSWER_BOX_SELECTORS[key].join(', ') + ' { display: none !important; }';
    (document.head || document.documentElement).appendChild(style);
    sweep();
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; sweep(); }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Initialize all subsystems safely if in browser environment
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sanitizeSearchResults);
      else sanitizeSearchResults();
      setupChatGPTInterceptor();
      setupClaudeInterceptor();
      injectMainWorldNetworkHook();
      setupKeyboardAndClipboardInterceptors();
      setupMouseTracking();
    } catch (err) {
      console.warn('[GuestPreload] Initialization warning:', err);
    }
  }

  // Export internal functions for unit test verification
  if (typeof module !== 'undefined') {
    module.exports = {
      parseAiPayload,
      isDisallowedShortcut,
      notifyPromptIntercepted,
      flushMouseBurst,
      STATE
    };
  }
})();
