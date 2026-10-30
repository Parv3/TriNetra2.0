/**
 * TabsUI — Tab Strip and Omnibox Controller
 * Renders Chrome-like tabs, handles add/close/switch, omnibox URL navigation.
 * Keeps pinned assessment tab permanently accessible for returning to exam.
 */
(function () {
  'use strict';

  const TabsUI = {
    tabs: [],
    activeTabId: null,

    async init() {
      this.bindEvents();
      this.setupProctorAPIListener();
      await this.loadInitialTabs();
    },

    bindEvents() {
      document.getElementById('btn-new-tab')?.addEventListener('click', () => this.createTab());

      const omnibox = document.getElementById('omnibox-input');
      omnibox?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.navigateOmnibox(omnibox.value.trim());
        }
      });
    },

    async loadInitialTabs() {
      const proctorAPI = window.proctorAPI;
      if (proctorAPI && typeof proctorAPI.getAllTabs === 'function') {
        try {
          const tabs = await proctorAPI.getAllTabs();
          if (Array.isArray(tabs) && tabs.length > 0) {
            this.tabs = tabs;
            const active = tabs.find(t => t.isActive);
            this.activeTabId = active ? active.id : tabs[0].id;
            this.render();
            return;
          }
        } catch (_) {}
      }

      // Fallback / Initial pinned tab setup
      if (!this.tabs.some(t => t.id === 'tab_assessment_pinned' || t.isPinned)) {
        this.tabs = [{
          id: 'tab_assessment_pinned',
          title: 'Exam',
          url: 'http://127.0.0.1:4100/app/assessment',
          isPinned: true,
          canClose: false,
          isActive: true,
          isLoading: false,
          isAiTool: false
        }, ...this.tabs];
        this.activeTabId = 'tab_assessment_pinned';
      }
      this.render();
    },

    setupProctorAPIListener() {
      const proctorAPI = window.proctorAPI;
      if (!proctorAPI || !proctorAPI.onTabUpdated) return;

      proctorAPI.onTabUpdated((data) => {
        if (data.allTabs && data.allTabs.length > 0) {
          this.tabs = data.allTabs;
          const active = data.allTabs.find(t => t.isActive);
          if (active) {
            this.activeTabId = active.id;
            if (active.isPinned) {
              window.switchView(this.homeView());
            } else {
              window.switchView('native-tab');
            }
          }
        } else if (data.id) {
          const existing = this.tabs.find(t => t.id === data.id);
          if (existing) {
            Object.assign(existing, data);
          }
        }

        // Guarantee pinned tab is never lost
        if (!this.tabs.some(t => t.id === 'tab_assessment_pinned' || t.isPinned)) {
          this.tabs.unshift({
            id: 'tab_assessment_pinned',
            title: 'Exam',
            url: 'http://127.0.0.1:4100/app/assessment',
            isPinned: true,
            canClose: false,
            isActive: !this.tabs.some(t => t.isActive),
            isLoading: false,
            isAiTool: false
          });
        }

        this.render();

        // Update omnibox
        const activeTab = this.tabs.find(t => t.id === this.activeTabId) || this.tabs[0];
        if (activeTab) {
          const omnibox = document.getElementById('omnibox-input');
          if (omnibox && document.activeElement !== omnibox) {
            omnibox.value = activeTab.isPinned ? '' : (activeTab.url || '');
          }
          // Show AI badge
          const aiBadge = document.getElementById('omnibox-ai-badge');
          if (aiBadge) {
            aiBadge.classList.toggle('hidden', !activeTab.isAiTool);
          }
        }
      });
    },

    render() {
      const strip = document.getElementById('tab-strip');
      if (!strip) return;

      strip.innerHTML = this.tabs.map(tab => {
        let cls = 'tab-item';
        if (tab.isActive) cls += ' active';
        if (tab.isPinned) cls += ' pinned';
        if (tab.isAiTool) cls += ' ai-flagged';

        const pinIcon = tab.isPinned ? `
          <span class="tab-pin-icon" title="Locked Assessment">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v8M5 10h14M8 10l-1 9h10l-1-9"/>
            </svg>
          </span>
        ` : '';

        return `
          <div class="${cls}" data-tab-id="${tab.id}" title="${this.escapeAttr(tab.url || tab.title || '')}">
            ${tab.isLoading ? '<div class="tab-loading"></div>' : ''}
            ${pinIcon}
            <span class="tab-ai-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              </svg>
            </span>
            <span class="tab-title">${this.escapeHtml(tab.title || (tab.isPinned ? 'Exam' : 'New tab'))}</span>
            ${tab.canClose ? `<button class="tab-close" data-close-id="${tab.id}" title="Close tab">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>` : ''}
          </div>
        `;
      }).join('');

      // Bind tab click events
      strip.querySelectorAll('.tab-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.tab-close')) return;
          this.switchTab(item.dataset.tabId);
        });
      });
      strip.querySelectorAll('.tab-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeTab(btn.dataset.closeId);
        });
      });
    },

    normalizeUrl(raw) {
      if (!raw || !raw.trim()) return 'https://www.google.com';
      const trimmed = raw.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
      const isDomain = !trimmed.includes(' ') && (
        /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed) ||
        /^localhost(:\d+)?(\/.*)?$/i.test(trimmed)
      );
      if (isDomain) return `https://${trimmed}`;
      return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    },

    async createTab(url) {
      const targetUrl = this.normalizeUrl(url);
      const proctorAPI = window.proctorAPI;
      if (proctorAPI && proctorAPI.createTab) {
        try {
          const tabId = await proctorAPI.createTab(targetUrl);
          if (tabId) {
            await this.switchTab(tabId);
          }
        } catch (e) {
          console.warn('Create tab failed:', e);
        }
      } else {
        // Fallback: browser preview mode
        const id = 'tab_' + Math.random().toString(36).slice(2);
        const isAi = /(chatgpt|openai|claude\.ai|perplexity|deepseek|gemini\.google|copilot\.microsoft)/i.test(targetUrl);
        this.tabs.push({
          id,
          title: this.deriveTitle(targetUrl),
          url: targetUrl,
          isActive: false,
          isPinned: false,
          canClose: true,
          isLoading: false,
          isAiTool: isAi
        });
        this.switchTab(id);
      }
    },

    deriveTitle(urlStr) {
      try {
        const u = new URL(urlStr);
        return u.hostname.replace(/^www\./, '') || 'Search';
      } catch (_) {
        return 'Web Page';
      }
    },

    async switchTab(tabId) {
      const proctorAPI = window.proctorAPI;
      const isPinned = tabId === 'tab_assessment_pinned' || (this.tabs.find(t => t.id === tabId)?.isPinned);

      if (proctorAPI && proctorAPI.switchTab) {
        try {
          await proctorAPI.switchTab(tabId);
        } catch (e) {
          console.warn('Switch tab failed:', e);
        }
      }

      this.tabs.forEach(t => t.isActive = t.id === tabId);
      this.activeTabId = tabId;
      this.render();

      const activeTab = this.tabs.find(t => t.id === tabId);
      const omnibox = document.getElementById('omnibox-input');
      if (omnibox && activeTab) {
        omnibox.value = activeTab.isPinned ? '' : (activeTab.url || '');
      }

      // Switching back to pinned assessment tab always restores the Exam view
      if (isPinned) {
        window.switchView(this.homeView());
      } else if (proctorAPI) {
        // Electron mode: hide all renderer DOM so the native WebContentsView is visible
        window.switchView('native-tab');
      } else {
        // Pure browser preview mode fallback (only when Electron is absent)
        const iframe = document.getElementById('guest-browser-iframe');
        if (activeTab && iframe) {
          window.switchView('guest-browser');
          if (iframe.src !== activeTab.url) {
            iframe.src = activeTab.url;
          }
        }
      }
    },

    async closeTab(tabId) {
      const proctorAPI = window.proctorAPI;
      if (proctorAPI && proctorAPI.closeTab) {
        try {
          await proctorAPI.closeTab(tabId);
        } catch (e) {
          console.warn('Close tab failed:', e);
        }
      } else {
        this.tabs = this.tabs.filter(t => t.id !== tabId);
        if (this.activeTabId === tabId && this.tabs.length > 0) {
          this.activeTabId = this.tabs[this.tabs.length - 1].id;
          this.switchTab(this.activeTabId);
        }
        this.render();
      }
    },

    async navigateOmnibox(input) {
      if (!input) return;
      const targetUrl = this.normalizeUrl(input);
      const activeTab = this.tabs.find(t => t.isActive);
      if (!activeTab || activeTab.isPinned) {
        // Open in new tab
        this.createTab(targetUrl);
        return;
      }

      const proctorAPI = window.proctorAPI;
      if (proctorAPI && proctorAPI.navigateTab) {
        try {
          await proctorAPI.navigateTab(activeTab.id, targetUrl);
        } catch (e) {
          console.warn('Navigate failed:', e);
        }
      } else {
        activeTab.url = targetUrl;
        activeTab.title = this.deriveTitle(targetUrl);
        activeTab.isAiTool = /(chatgpt|openai|claude\.ai|perplexity|deepseek|gemini\.google|copilot\.microsoft)/i.test(targetUrl);
        this.render();
      }
    },

    // The pinned tab hosts the app itself: the exam once started, sign-in before that.
    homeView() {
      const st = window.AppState || {};
      if (st.disqualified) return 'disqualified';
      if (st.submitted) return 'results';
      return st.sessionId ? 'exam' : 'auth';
    },

    escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    escapeAttr(str) {
      return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
  };

  window.TabsUI = TabsUI;
})();
