/**
 * Trinetra — Proctor & Admin Command Center Controller
 * Real-time candidate telemetry monitoring, live session inspection & proctor intervention.
 */
(function () {
  'use strict';

  const AdminDashboard = {
    baseUrl: 'http://127.0.0.1:4100',
    autoRefreshTimer: null,
    isAutoRefresh: true,
    refreshIntervalMs: 5000,
    currentFilters: {
      status: 'ALL',
      risk: 'ALL',
      search: ''
    },
    activeSessionId: null,
    allSessions: [],
    proctorWs: null,
    activeExamId: 'ALL',
    exams: [],
    proctorToken: (() => {
      try { return localStorage.getItem('trinetra_proctor_token') || sessionStorage.getItem('trinetra_proctor_token') || ''; } catch (_) { return ''; }
    })(),
    proctor: null,

    /**
     * Resolves with a valid proctor token. Shows the sign-in screen (or, on a brand-new
     * server opened from the host computer, the owner setup screen) until there is one.
     */
    async ensureAuthenticated() {
      if (this.proctorToken) {
        try {
          const me = await (await fetch(`${this.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${this.proctorToken}` } })).json();
          if (me.authenticated && me.role === 'proctor') {
            this.setSignedIn(this.proctorToken, me.user);
            return this.proctorToken;
          }
        } catch (_) {}
        this.clearToken();
      }
      return this.showAuthScreen();
    },

    storeToken(token, remember) {
      try {
        (remember ? localStorage : sessionStorage).setItem('trinetra_proctor_token', token);
        (remember ? sessionStorage : localStorage).removeItem('trinetra_proctor_token');
      } catch (_) {}
    },

    clearToken() {
      this.proctorToken = '';
      try { localStorage.removeItem('trinetra_proctor_token'); sessionStorage.removeItem('trinetra_proctor_token'); } catch (_) {}
    },

    setSignedIn(token, user) {
      this.proctorToken = token;
      this.proctor = user || {};
      document.getElementById('proctor-auth').classList.add('hidden');
      const who = document.getElementById('proctor-who');
      if (who) who.textContent = `${this.proctor.name || 'Proctor'}${this.proctor.proctorId ? ` · ${this.proctor.proctorId}` : ''}`;
      const owner = Boolean(this.proctor.isOwner);
      document.getElementById('btn-add-proctor')?.classList.toggle('hidden', !owner);
    },

    async showAuthScreen() {
      const screen = document.getElementById('proctor-auth');
      const show = (id) => ['proctor-login-form', 'proctor-setup-form', 'proctor-setup-remote', 'proctor-setup-done']
        .forEach(f => document.getElementById(f).classList.toggle('hidden', f !== id));
      screen.classList.remove('hidden');

      let setup = { needsSetup: false };
      try { setup = await (await fetch(`${this.baseUrl}/api/auth/proctor/setup`)).json(); } catch (_) {}
      const canSetUp = setup.fromThisComputer || setup.setupKeyRequired;
      show(setup.needsSetup ? (canSetUp ? 'proctor-setup-form' : 'proctor-setup-remote') : 'proctor-login-form');
      document.getElementById('setup-key-field')?.classList.toggle('hidden', !setup.setupKeyRequired);
      document.querySelector('#proctor-auth form:not(.hidden) input')?.focus();

      return new Promise((resolve) => {
        const fail = (id, msg) => { const el = document.getElementById(id); el.textContent = msg; el.classList.remove('hidden'); };

        document.getElementById('proctor-login-form').onsubmit = async (e) => {
          e.preventDefault();
          const remember = document.getElementById('login-remember').checked;
          try {
            const res = await fetch(`${this.baseUrl}/api/auth/proctor/login`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ proctorId: document.getElementById('login-proctor-id').value.trim(), password: document.getElementById('login-password').value })
            });
            const data = await res.json();
            if (!res.ok) return fail('login-error', data.message || 'Sign-in failed.');
            this.storeToken(data.token, remember);
            this.setSignedIn(data.token, { ...data.proctor, proctorId: data.proctor && data.proctor.id });
            resolve(data.token);
          } catch (_) { fail('login-error', 'Could not reach the exam server.'); }
        };

        document.getElementById('proctor-setup-form').onsubmit = async (e) => {
          e.preventDefault();
          const password = document.getElementById('setup-password').value;
          if (password !== document.getElementById('setup-password2').value) return fail('setup-error', 'The passwords don\'t match.');
          try {
            const res = await fetch(`${this.baseUrl}/api/auth/proctor/setup`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: document.getElementById('setup-name').value,
                email: document.getElementById('setup-email').value,
                password,
                setupKey: document.getElementById('setup-key').value
              })
            });
            const data = await res.json();
            if (!res.ok) return fail('setup-error', data.message || 'Setup failed.');
            document.getElementById('setup-done-id').textContent = data.proctorId;
            show('proctor-setup-done');
            document.getElementById('btn-setup-continue').onclick = () => {
              this.storeToken(data.token, true);
              this.setSignedIn(data.token, { ...data.proctor, proctorId: data.proctorId });
              resolve(data.token);
            };
          } catch (_) { fail('setup-error', 'Could not reach the exam server.'); }
        };
      });
    },

    signOut() {
      fetch(`${this.baseUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${this.proctorToken}` } }).catch(() => {});
      this.clearToken();
      location.reload();
    },

    // ── Proctors tab ──
    async fetchProctors() {
      const tbody = document.getElementById('proctors-table-body');
      try {
        const list = await (await this.authFetch(`${this.baseUrl}/api/auth/proctors`)).json();
        const owner = Boolean(this.proctor && this.proctor.isOwner);
        const when = (ts) => ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
        tbody.innerHTML = list.map(p => `
          <tr class="${p.disabled ? 'row-disqualified' : ''}">
            <td class="mono"><strong>${this.escapeHtml(p.id)}</strong></td>
            <td>${this.escapeHtml(p.name)}</td>
            <td class="text-muted">${this.escapeHtml(p.email || '—')}</td>
            <td>${p.isOwner ? '<span class="badge badge-purple">Owner</span>' : p.disabled ? '<span class="badge badge-slate">Disabled</span>' : '<span class="badge badge-emerald">Proctor</span>'}</td>
            <td class="text-muted">${when(p.lastLoginAt)}</td>
            <td class="text-right">${owner && !p.isOwner ? `<button class="btn btn-outline btn-sm" data-proctor="${p.id}" data-disable="${!p.disabled}">${p.disabled ? 'Enable' : 'Disable'}</button>` : ''}</td>
          </tr>`).join('');
        tbody.querySelectorAll('[data-proctor]').forEach(btn => btn.addEventListener('click', async () => {
          await this.authFetch(`${this.baseUrl}/api/auth/proctors/${btn.dataset.proctor}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: btn.dataset.disable === 'true' })
          });
          this.fetchProctors();
        }));
      } catch (_) {}
    },

    bindProctorTab() {
      const $ = (id) => document.getElementById(id);
      $('btn-sign-out')?.addEventListener('click', () => this.signOut());
      $('btn-add-proctor')?.addEventListener('click', () => { $('add-proctor-panel').classList.remove('hidden'); $('add-proctor-status').textContent = ''; $('new-proctor-name').focus(); });
      $('btn-cancel-add-proctor')?.addEventListener('click', () => $('add-proctor-panel').classList.add('hidden'));
      $('btn-change-password')?.addEventListener('click', () => { $('change-password-panel').classList.remove('hidden'); $('pw-status').textContent = ''; $('pw-current').focus(); });
      $('btn-cancel-pw')?.addEventListener('click', () => $('change-password-panel').classList.add('hidden'));
      $('btn-save-proctor')?.addEventListener('click', async () => {
        const res = await this.authFetch(`${this.baseUrl}/api/auth/proctors`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: $('new-proctor-name').value, email: $('new-proctor-email').value })
        });
        const data = await res.json();
        if (!res.ok) { $('add-proctor-status').textContent = data.message || 'Could not create the account.'; return; }
        // Shown once: the server keeps only a hash of the password.
        $('add-proctor-status').innerHTML = `Created <strong class="mono">${this.escapeHtml(data.id)}</strong> with temporary password <strong class="mono">${this.escapeHtml(data.password)}</strong>. Share both with ${this.escapeHtml(data.name)}; this password is not shown again.`;
        $('new-proctor-name').value = ''; $('new-proctor-email').value = '';
        this.fetchProctors();
      });
      $('btn-save-pw')?.addEventListener('click', async () => {
        const res = await this.authFetch(`${this.baseUrl}/api/auth/proctor/password`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: $('pw-current').value, newPassword: $('pw-new').value })
        });
        const data = await res.json();
        $('pw-status').textContent = res.ok ? 'Password changed.' : (data.message || 'Could not change the password.');
        if (res.ok) { $('pw-current').value = ''; $('pw-new').value = ''; }
      });
    },

    async authFetch(url, options = {}) {
      if (!this.proctorToken) {
        await this.ensureAuthenticated();
      }
      const headers = Object.assign({}, options.headers);
      if (this.proctorToken) {
        headers['Authorization'] = `Bearer ${this.proctorToken}`;
      }
      let res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        // Expired or revoked: sign in again, then retry once
        this.clearToken();
        const token = await this.showAuthScreen();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
          res = await fetch(url, { ...options, headers });
        }
      }
      return res;
    },

    async init() {
      // Determine backend URL from window location if running in browser
      if (window.location && window.location.origin && window.location.origin.startsWith('http')) {
        this.baseUrl = window.location.origin;
      }
      document.getElementById('server-url-display').textContent = this.baseUrl.replace(/^https?:\/\//, '');

      await this.ensureAuthenticated();
      this.bindEvents();
      this.bindProctorTab();
      this.startClock();
      this.fetchNetworkInfo();
      this.fetchExamsList();
      this.connectWebSocket();
      this.refreshAll();
      this.startAutoRefresh();
    },

    async fetchNetworkInfo() {
      try {
        const res = await fetch(`${this.baseUrl}/api/system/network`);
        if (!res.ok) return;
        const net = await res.json();
        const shareLink = document.getElementById('net-share-link');
        if (shareLink && net.adminUrl) {
          shareLink.href = net.adminUrl;
          shareLink.textContent = net.adminUrl;
        }
        // Candidates must use HTTPS: browsers refuse the camera on plain http from another machine.
        const candidateLink = document.getElementById('net-candidate-link');
        const candidateUrl = net.candidateUrl || net.appUrl;
        if (candidateLink && candidateUrl) {
          candidateLink.href = candidateUrl;
          candidateLink.textContent = candidateUrl;
          const copy = document.getElementById('btn-copy-candidate-link');
          if (copy && !copy.dataset.bound) {
            copy.dataset.bound = '1';
            copy.addEventListener('click', async () => {
              try { await navigator.clipboard.writeText(candidateUrl); this.showToast('Candidate link copied', 'online'); } catch (_) {}
            });
          }
        }
        this.networkInfo = net;
      } catch (_) {}
    },

    async fetchDatabaseStatus() {
      const el = document.getElementById('db-status');
      try {
        const db = await (await fetch(`${this.baseUrl}/api/system/database`)).json();
        if (!db.configured) return el.classList.add('hidden');
        el.classList.remove('hidden');
        el.classList.toggle('bad', Boolean(db.lastError));
        el.textContent = db.lastError ? 'PostgreSQL: sync error' : db.lastSyncAt ? `PostgreSQL: synced ${new Date(db.lastSyncAt).toLocaleTimeString([], { hour12: false })}` : 'PostgreSQL: connecting';
        el.title = db.lastError || 'Student logs are mirrored to PostgreSQL (schema "trinetra")';
      } catch (_) {}
    },

    async fetchExamsList() {
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/assessment/exams`);
        if (!res.ok) return;
        const exams = await res.json();
        this.exams = Array.isArray(exams) ? exams : [];
        const select = document.getElementById('admin-exam-select');
        if (select) {
          select.innerHTML = '<option value="ALL">All exams</option>' + this.exams.map(ex =>
            `<option value="${this.escapeHtml(ex.id)}">${this.escapeHtml(ex.title)} · ${this.formatCode(ex.code)}</option>`).join('');
          if (!this.exams.some(e => e.id === this.activeExamId)) this.activeExamId = 'ALL';
          select.value = this.activeExamId;
        }
        this.renderExamsTable();
        // First run: nothing to watch yet, so land on the exams list.
        if (this.exams.length === 0 && !this._landedOnExams) {
          this._landedOnExams = true;
          document.getElementById('tab-btn-exams')?.click();
        }
      } catch (_) {}
    },

    formatWhen(ms) {
      return new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    },

    formatCode(code) {
      const c = String(code || '');
      return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
    },

    renderExamsTable() {
      const tbody = document.getElementById('exams-table-body');
      if (!tbody) return;
      if (this.exams.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-exams"><strong>No exams yet</strong><span>Create an exam, add your questions, and share the join code with candidates.</span><button class="btn btn-primary btn-sm" data-action="create">New exam</button></div></td></tr>`;
      } else {
        tbody.innerHTML = this.exams.map(ex => {
          const open = (ex.status || 'OPEN') === 'OPEN';
          const badge = !open ? ['badge-slate', 'Closed']
            : ex.schedule === 'UPCOMING' ? ['badge-amber', `Opens ${this.formatWhen(ex.startsAt)}`]
            : ex.schedule === 'ENDED' ? ['badge-slate', 'Window ended']
            : ['badge-emerald', ex.endsAt ? `Open until ${this.formatWhen(ex.endsAt)}` : 'Open'];
          return `
            <tr>
              <td><div class="candidate-cell"><span class="candidate-cell-name">${this.escapeHtml(ex.title)}</span><span class="candidate-cell-email">${this.escapeHtml(ex.description || '')}</span></div></td>
              <td><button class="code-chip" data-action="copy" data-code="${this.escapeHtml(ex.code)}" title="Copy join code">${this.formatCode(ex.code)}</button></td>
              <td class="mono">${ex.questionCount}</td>
              <td class="mono">${ex.durationMinutes} min</td>
              <td>${ex.sessionCount}${ex.liveCount ? ` <span class="text-success">· ${ex.liveCount} live</span>` : ''}</td>
              <td><span class="badge ${badge[0]}">${badge[1]}</span></td>
              <td class="text-right">
                <button class="btn btn-outline btn-sm" data-action="watch" data-id="${ex.id}">Watch</button>
                <button class="btn btn-outline btn-sm" data-action="toggle" data-id="${ex.id}" data-status="${open ? 'CLOSED' : 'OPEN'}">${open ? 'Close' : 'Reopen'}</button>
              </td>
            </tr>`;
        }).join('');
      }
      tbody.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => this.onExamAction(btn)));
    },

    async onExamAction(btn) {
      const action = btn.dataset.action;
      if (action === 'create') return this.openCreateExamModal();
      if (action === 'copy') {
        try { await navigator.clipboard.writeText(this.formatCode(btn.dataset.code)); this.showToast(`Copied ${this.formatCode(btn.dataset.code)}`, 'online'); } catch (_) {}
        return;
      }
      if (action === 'watch') {
        this.setActiveExam(btn.dataset.id);
        document.getElementById('tab-btn-grid')?.click();
        return;
      }
      if (action === 'toggle') {
        await this.authFetch(`${this.baseUrl}/api/assessment/exams/${btn.dataset.id}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: btn.dataset.status })
        });
        this.fetchExamsList();
      }
    },

    setActiveExam(examId) {
      this.activeExamId = examId || 'ALL';
      const select = document.getElementById('admin-exam-select');
      if (select) select.value = this.activeExamId;
      const exam = this.exams.find(e => e.id === this.activeExamId);
      const label = document.getElementById('grid-room-label');
      if (label) label.textContent = exam ? `${exam.title} (${this.formatCode(exam.code)})` : 'all exams';
      this.refreshAll(true);
    },

    async connectWebSocket() {
      try {
        if (!this.proctorToken) {
          await this.ensureAuthenticated();
        }
        const tokenParam = this.proctorToken ? `&token=${encodeURIComponent(this.proctorToken)}` : '';
        const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws/proctor?role=proctor' + tokenParam;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          // Resume live video after a reconnect if an inspector is open.
          if (this.watchSessionId) this.startWatch(this.watchSessionId);
          console.log('[Dashboard] Live Proctor WebSocket Connected');
          this.showToast('Connected to live telemetry', 'online');
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
          } catch (_) {}
        };

        ws.onclose = () => {
          // Reconnect after 3s
          setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.proctorWs = ws;
      } catch (err) {
        console.warn('[Dashboard] WS connection error:', err);
      }
    },

    handleWebSocketMessage(msg) {
      if (!msg || !msg.type) return;

      if (msg.type === 'CANDIDATE_FRAME') {
        // Update Surveillance Grid tile in real-time
        const tileImg = document.getElementById(`grid-tile-img-${msg.sessionId}`);
        const tilePh = document.getElementById(`grid-tile-ph-${msg.sessionId}`);
        if (tileImg && msg.snapshot) {
          tileImg.src = msg.snapshot;
          tileImg.classList.remove('hidden');
          if (tilePh) tilePh.classList.add('hidden');
        }
        const tileGaze = document.getElementById(`grid-tile-gaze-${msg.sessionId}`);
        if (tileGaze && msg.gaze) {
          tileGaze.textContent = this.gazeLabel(msg.gaze);
          tileGaze.classList.toggle('off', msg.gaze !== 'CENTER');
        }

        // If inspector drawer is open for this student, update viewport
        if (this.activeSessionId === msg.sessionId) {
          this.updateLiveFrameView(msg);
        }
      } else if (msg.type === 'OTP_ISSUED') {
        // Production sign-in: the invigilator checks the student's ID, then reads this out.
        this.appendLiveLog({ category: 'system', studentName: `${msg.studentName} (${msg.studentId})`, summary: `Sign-in code ${msg.otp} — valid ${Math.round((msg.expiresInSeconds || 300) / 60)} min`, timestamp: msg.timestamp });
        this.showToast(`Sign-in code for ${msg.studentName} (${msg.studentId}): ${msg.otp}`, 'online', 30000);
      } else if (msg.type === 'RTC_SIGNAL') {
        this.onRtcSignal(msg);
      } else if (msg.type === 'WATCH_UNAVAILABLE') {
        if (msg.sessionId === this.watchSessionId) this.setLiveMode('Candidate offline — showing last frame');
      } else if (msg.type === 'LIVE_LOG_EVENT') {
        this.appendLiveLog(msg);
      } else if (msg.type === 'EXTREME_SUSPICION_ALERT') {
        this.showExtremeSuspicionPopup(msg);
      } else if (msg.type === 'EXAM_CREATED' || msg.type === 'EXAM_RULES_UPDATED') {
        this.fetchExamsList();
      } else if (msg.type === 'LIVE_ANOMALY') {
        const payload = msg.payload || {};
        const vType = (payload.type || 'INFRACTION').replace(/_/g, ' ');
        this.showToast(`${msg.studentName || msg.sessionId}: ${vType.toLowerCase()}`, 'warning');
        this.refreshAll(true);
      } else if (msg.type === 'CANDIDATE_ONLINE') {
        this.showToast(`${msg.studentName || msg.sessionId} joined`, 'online');
        this.refreshAll(true);
      } else if (msg.type === 'CANDIDATE_OFFLINE') {
        this.showToast(`${msg.studentName || msg.sessionId} disconnected`, 'warning');
        this.refreshAll(true);
      } else if (msg.type === 'SESSION_RESUMED') {
        this.refreshAll(true);
      } else if (msg.type === 'SESSION_TERMINATED') {
        this.showToast(`Session ended: ${msg.studentName || msg.sessionId}`, 'warning');
        this.refreshAll(true);
      }
    },

    showToast(message, type = 'normal', durationMs = 3500) {
      const container = document.getElementById('proctor-toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `proctor-toast ${type}`;
      toast.textContent = message;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.transition = 'opacity 300ms ease, transform 300ms ease';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
      }, durationMs);
    },

    bindEvents() {
      // Main View Navigation Switcher (Grid / Table / Logs)
      document.querySelectorAll('.proctor-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.proctor-tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const view = btn.dataset.view;

          document.querySelectorAll('.dashboard-view-section').forEach(sec => sec.classList.add('hidden'));
          if (view === 'proctors') {
            document.getElementById('section-proctors')?.classList.remove('hidden');
            this.fetchProctors();
          } else if (view === 'exams') {
            document.getElementById('section-exams')?.classList.remove('hidden');
            this.fetchExamsList();
          } else if (view === 'grid') {
            document.getElementById('section-surveillance-grid')?.classList.remove('hidden');
          } else if (view === 'table') {
            document.getElementById('section-candidate-table')?.classList.remove('hidden');
          } else if (view === 'logs') {
            document.getElementById('section-live-logs')?.classList.remove('hidden');
          }
        });
      });

      // Resume a terminated attempt
      document.getElementById('btn-drawer-resume')?.addEventListener('click', () => this.openResumeModal(this.activeSessionId));
      document.getElementById('btn-cancel-resume')?.addEventListener('click', () => document.getElementById('resume-modal').classList.add('hidden'));
      document.getElementById('btn-confirm-resume')?.addEventListener('click', () => this.resumeSession());

      // Extreme Suspicion Modal Buttons
      document.getElementById('btn-close-suspicion-modal')?.addEventListener('click', () => {
        document.getElementById('extreme-suspicion-modal')?.classList.add('hidden');
      });
      document.getElementById('btn-suspicion-inspect')?.addEventListener('click', () => {
        document.getElementById('extreme-suspicion-modal')?.classList.add('hidden');
        if (this._lastAlertSessionId) this.inspectSession(this._lastAlertSessionId);
      });
      document.getElementById('btn-suspicion-warn')?.addEventListener('click', () => {
        if (this._lastAlertSessionId) {
          this.issueProctorWarning(this._lastAlertSessionId, 'Suspicious activity detected. Please keep your focus on the assessment screen.');
          document.getElementById('extreme-suspicion-modal')?.classList.add('hidden');
        }
      });
      document.getElementById('btn-suspicion-disqualify')?.addEventListener('click', () => {
        if (this._lastAlertSessionId) {
          this.showInterventionModal(this._lastAlertSessionId);
          document.getElementById('extreme-suspicion-modal')?.classList.add('hidden');
        }
      });

      // Live Logs Filters
      document.querySelectorAll('.log-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.activeLogFilter = btn.dataset.filter;
          this.filterLiveLogs();
        });
      });
      document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
        const term = document.getElementById('live-logs-terminal');
        if (term) term.innerHTML = '<div class="log-entry log-system"><span class="log-time">[System]</span><span class="log-text">Log terminal cleared. Waiting for events...</span></div>';
        const cnt = document.getElementById('logs-count-badge');
        if (cnt) cnt.textContent = '0 events';
      });

      // Manual refresh
      document.getElementById('btn-manual-refresh')?.addEventListener('click', () => {
        this.refreshAll();
      });

      // Auto-refresh toggle
      const autoBtn = document.getElementById('btn-toggle-autorefresh');
      autoBtn?.addEventListener('click', () => {
        this.isAutoRefresh = !this.isAutoRefresh;
        autoBtn.classList.toggle('active', this.isAutoRefresh);
        if (this.isAutoRefresh) {
          autoBtn.innerHTML = '<span class="refresh-dot"></span> Auto-refresh';
          this.startAutoRefresh();
        } else {
          autoBtn.innerHTML = 'Auto-refresh paused';
          this.stopAutoRefresh();
        }
      });

      // Status chip filters
      document.querySelectorAll('#status-chips .chip').forEach(chip => {
        chip.addEventListener('click', () => {
          document.querySelectorAll('#status-chips .chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          this.currentFilters.status = chip.dataset.status;
          this.fetchSessions();
        });
      });

      // Risk dropdown filter
      document.getElementById('filter-risk-select')?.addEventListener('change', (e) => {
        this.currentFilters.risk = e.target.value;
        this.fetchSessions();
      });

      // Search input
      const searchInput = document.getElementById('filter-search-input');
      const clearBtn = document.getElementById('btn-clear-search');
      let searchDebounce = null;

      searchInput?.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        clearBtn?.classList.toggle('hidden', val.length === 0);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          this.currentFilters.search = val;
          this.fetchSessions();
        }, 250);
      });

      clearBtn?.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        clearBtn.classList.add('hidden');
        this.currentFilters.search = '';
        this.fetchSessions();
      });

      // Close inspector drawer
      document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
        this.closeInspector();
      });
      document.getElementById('inspector-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'inspector-modal') {
          this.closeInspector();
        }
      });

      // Exam Rules & Feature Toggles modal controls
      document.getElementById('btn-open-exam-rules')?.addEventListener('click', () => {
        this.openExamRulesModal();
      });
      document.getElementById('btn-close-rules-modal')?.addEventListener('click', () => {
        document.getElementById('exam-rules-modal')?.classList.add('hidden');
      });
      document.getElementById('exam-rules-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'exam-rules-modal') {
          document.getElementById('exam-rules-modal')?.classList.add('hidden');
        }
      });
      document.getElementById('btn-save-exam-rules')?.addEventListener('click', () => {
        this.saveExamRules();
      });

      // Copy LAN remote proctor link
      document.getElementById('btn-copy-net-link')?.addEventListener('click', () => {
        const url = document.getElementById('net-share-link')?.textContent || `${this.baseUrl}/admin`;
        navigator.clipboard.writeText(url).then(() => {
          const btnText = document.getElementById('copy-btn-text');
          if (btnText) btnText.textContent = 'Copied!';
          this.showToast('Link copied', 'online');
          setTimeout(() => { if (btnText) btnText.textContent = 'Copy Link'; }, 2000);
        }).catch(() => {
          prompt('Copy this remote proctor URL:', url);
        });
      });

      // Exam Selector Change
      document.getElementById('admin-exam-select')?.addEventListener('change', (e) => {
        this.setActiveExam(e.target.value);
      });

      // Create Exam Modal controls
      document.getElementById('btn-open-create-exam')?.addEventListener('click', () => {
        this.openCreateExamModal();
      });
      document.getElementById('btn-close-create-modal')?.addEventListener('click', () => {
        document.getElementById('create-exam-modal')?.classList.add('hidden');
      });
      document.getElementById('create-exam-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'create-exam-modal') {
          document.getElementById('create-exam-modal')?.classList.add('hidden');
        }
      });
      document.getElementById('btn-submit-create-exam')?.addEventListener('click', () => {
        this.submitCreateExam();
      });

      // Send custom proctor alert message from live panel
      document.getElementById('btn-send-custom-msg')?.addEventListener('click', () => {
        this.sendProctorCustomMessage();
      });
      document.getElementById('input-proctor-custom-msg')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.sendProctorCustomMessage();
      });

      // Direct Warning button in drawer
      document.getElementById('btn-drawer-warn')?.addEventListener('click', () => {
        if (!this.activeSessionId) return;
        const msg = prompt('Enter proctor warning message for candidate:', 'Please keep your face centered in camera frame.');
        if (msg) {
          this.issueProctorWarning(this.activeSessionId, msg);
        }
      });

      // HTML Export button
      document.getElementById('btn-export-html-report')?.addEventListener('click', () => {
        if (!this.activeSessionId) return;
        const tokenParam = this.proctorToken ? `&token=${encodeURIComponent(this.proctorToken)}` : '';
        window.open(`${this.baseUrl}/api/audit/session/${this.activeSessionId}/export?format=html${tokenParam}`, '_blank');
      });

      // Disqualify button in drawer
      document.getElementById('btn-drawer-disqualify')?.addEventListener('click', () => {
        if (!this.activeSessionId) return;
        this.showInterventionModal(this.activeSessionId);
      });

      // Disqualification confirmation modal
      document.getElementById('btn-cancel-action')?.addEventListener('click', () => {
        document.getElementById('action-confirm-modal')?.classList.add('hidden');
      });
      document.getElementById('btn-confirm-action')?.addEventListener('click', () => {
        const reason = document.getElementById('action-reason-input')?.value || 'Disqualified by Proctor';
        this.executeDisqualification(this.activeSessionId, reason);
      });
    },

    startClock() {
      const clockEl = document.getElementById('live-clock');
      const update = () => {
        if (clockEl) {
          const d = new Date();
          clockEl.textContent = d.toTimeString().split(' ')[0];
        }
      };
      update();
      setInterval(update, 1000);
    },

    startAutoRefresh() {
      this.stopAutoRefresh();
      this.autoRefreshTimer = setInterval(() => {
        this.refreshAll(true);
      }, this.refreshIntervalMs);
    },

    stopAutoRefresh() {
      if (this.autoRefreshTimer) {
        clearInterval(this.autoRefreshTimer);
        this.autoRefreshTimer = null;
      }
    },

    async refreshAll(isBackground = false) {
      this.fetchDatabaseStatus();
      await Promise.all([
        this.fetchOverview(),
        this.fetchSessions(isBackground)
      ]);
    },

    async fetchOverview() {
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/audit/overview`);
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById('kpi-active-count').textContent = data.activeSessions || 0;
        document.getElementById('kpi-total-count').textContent = data.totalSessions || 0;
        document.getElementById('kpi-submitted-count').textContent = `${data.submittedSessions || 0} submitted`;
        document.getElementById('kpi-violations-count').textContent = data.totalViolations || 0;
        document.getElementById('kpi-ai-count').textContent = data.totalAiQueries || 0;
        document.getElementById('kpi-integrity-score').innerHTML = `${data.averageIntegrity || 100}<span class="unit">/100</span>`;
        document.getElementById('kpi-disqualified-subtext').textContent = `${data.disqualifiedSessions || 0} terminated`;
      } catch (err) {
        console.warn('Overview fetch error:', err);
      }
    },

    async fetchSessions(isBackground = false) {
      const counterText = document.getElementById('sessions-counter-text');
      const tbody = document.getElementById('sessions-table-body');

      try {
        const params = new URLSearchParams();
        if (this.currentFilters.status) params.append('status', this.currentFilters.status);
        if (this.currentFilters.risk) params.append('risk', this.currentFilters.risk);
        if (this.currentFilters.search) params.append('search', this.currentFilters.search);
        if (this.activeExamId && this.activeExamId !== 'ALL') params.append('examId', this.activeExamId);

        const res = await this.authFetch(`${this.baseUrl}/api/audit/sessions?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const sessions = await res.json();
        this.allSessions = sessions;

        if (counterText) {
          counterText.textContent = `Showing ${sessions.length} candidate session${sessions.length === 1 ? '' : 's'}`;
        }

        this.renderSessionsTable(sessions);
        this.renderSurveillanceGrid(sessions);
      } catch (err) {
        console.warn('Sessions fetch error:', err);
        if (!isBackground && tbody) {
          tbody.innerHTML = `
            <tr>
              <td colspan="9" class="text-center py-12 text-muted">
                Failed to load candidate sessions from backend service.
              </td>
            </tr>
          `;
        }
      }
    },

    renderSessionsTable(sessions) {
      const tbody = document.getElementById('sessions-table-body');
      if (!tbody) return;

      if (!sessions || sessions.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" class="text-center py-12 text-muted">
              No candidate sessions found matching the active filters.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = sessions.map(s => {
        const isLive = s.status === 'IN_PROGRESS';
        const isDq = s.status && s.status.includes('DISQUALIFIED');
        let rowCls = '';
        if (isLive) rowCls = 'row-active';
        if (isDq) rowCls = 'row-disqualified';

        const status = isLive ? ['badge-emerald', 'Live']
          : isDq ? ['badge-crimson', 'Terminated']
          : s.status === 'AUTO_SUBMITTED_TIMEOUT' ? ['badge-amber', 'Timed out']
          : (s.status === 'SUBMITTED' || s.status === 'COMPLETED') ? ['badge-slate', 'Submitted']
          : ['badge-slate', s.status || 'Unknown'];

        const tone = s.integrityRating === 'HIGH_RISK' ? 'crimson' : s.integrityRating === 'MEDIUM_RISK' ? 'amber' : 'emerald';
        const riskLabel = { LOW_RISK: 'Low risk', MEDIUM_RISK: 'Medium risk', HIGH_RISK: 'High risk' }[s.integrityRating] || '';
        const maxStrikes = s.maxStrikes || 3;
        const strikes = s.strikeCount || 0;
        const ai = s.aiQueriesCount || 0;
        const started = s.startedAt ? new Date(s.startedAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';

        return `
          <tr class="${rowCls}">
            <td>
              <div class="candidate-cell">
                <span class="candidate-cell-name">${this.escapeHtml(s.candidateName || s.studentId)}</span>
                <span class="candidate-cell-email mono">${this.escapeHtml(s.studentId)}</span>
              </div>
            </td>
            <td><span class="badge ${status[0]}">${status[1]}</span></td>
            <td>
              <div class="integrity-bar-wrap">
                <div class="integrity-bar-head"><strong class="mono">${s.integrityScore}</strong><span class="text-muted">${riskLabel}</span></div>
                <div class="integrity-bar-track"><div class="integrity-bar-fill fill-${tone}" style="width: ${s.integrityScore}%;"></div></div>
              </div>
            </td>
            <td><span class="mono ${strikes >= maxStrikes ? 'text-danger' : strikes ? 'text-warn' : 'text-muted'}">${strikes} / ${maxStrikes}</span>${s.violationsCount > strikes ? `<span class="text-muted"> · ${s.violationsCount} events</span>` : ''}</td>
            <td>${ai ? `<span class="text-danger">${ai} AI ${ai === 1 ? 'visit' : 'visits'}</span>` : s.tabSwitchesCount ? `<span class="text-muted">${s.tabSwitchesCount} tab events</span>` : '<span class="text-muted">—</span>'}</td>
            <td>${s.score !== null && s.score !== undefined ? `<span class="mono">${s.score}/${s.maxScore}</span> <span class="text-muted">${s.percentage}%</span>` : '<span class="text-muted">—</span>'}</td>
            <td class="mono text-muted">${started}</td>
            <td class="text-right"><button class="btn btn-outline btn-sm btn-inspect" data-session-id="${s.id}">Inspect</button></td>
          </tr>`;
      }).join('');

      // Bind inspect buttons
      tbody.querySelectorAll('.btn-inspect').forEach(btn => {
        btn.addEventListener('click', () => {
          this.inspectSession(btn.dataset.sessionId);
        });
      });
    },

    renderSurveillanceGrid(sessions) {
      const grid = document.getElementById('surveillance-grid-container');
      const badge = document.getElementById('badge-grid-count');
      if (!grid) return;

      const live = (sessions || []).filter(s => s.status === 'IN_PROGRESS');
      if (badge) badge.textContent = String(live.length);

      if (!sessions || sessions.length === 0) {
        grid.innerHTML = '<div class="grid-empty-state">No candidates have joined this exam yet.</div>';
        return;
      }

      // Live sessions first, then the most recent finished ones.
      const ordered = [...sessions].sort((a, b) =>
        (Number(b.status === 'IN_PROGRESS') - Number(a.status === 'IN_PROGRESS')) || ((b.startedAt || 0) - (a.startedAt || 0)));

      grid.innerHTML = ordered.map(s => {
        const isLive = s.status === 'IN_PROGRESS';
        const isDq = s.status && s.status.includes('DISQUALIFIED');
        const name = s.candidateName || s.studentName || s.studentId;
        const frame = s.lastSnapshot || '';
        const state = isLive ? 'live' : isDq ? 'dq' : 'done';
        const stateLabel = isLive ? 'Live' : isDq ? 'Terminated' : 'Submitted';
        const alerts = s.violationsCount || 0;

        return `
          <article class="tile tile-${state}${alerts > 0 && isLive ? ' tile-alert' : ''}" id="student-tile-${s.id}">
            <div class="tile-video">
              <img id="grid-tile-img-${s.id}" class="${frame ? '' : 'hidden'}" src="${frame}" alt="">
              <div id="grid-tile-ph-${s.id}" class="tile-placeholder ${frame ? 'hidden' : ''}">${isLive ? 'Waiting for camera' : 'Session ended'}</div>
              <span class="tile-state">${stateLabel}</span>
              <span class="tile-gaze" id="grid-tile-gaze-${s.id}">${this.escapeHtml(this.gazeLabel(s.lastGaze))}</span>
            </div>
            <div class="tile-body">
              <div class="tile-who">
                <span class="tile-name">${this.escapeHtml(name)}</span>
                <span class="tile-id mono">${this.escapeHtml(s.studentId)}</span>
              </div>
              <span class="tile-alerts ${alerts ? 'has' : ''}">${alerts} ${alerts === 1 ? 'alert' : 'alerts'}</span>
            </div>
            <div class="tile-actions">
              <button class="btn btn-sm btn-outline btn-tile-inspect" data-session-id="${s.id}">Inspect</button>
              ${isLive ? `<button class="btn btn-sm btn-outline btn-tile-warn" data-session-id="${s.id}">Warn</button>
              <button class="btn btn-sm btn-danger-quiet btn-tile-disqualify" data-session-id="${s.id}">Terminate</button>` : ''}
              ${isDq ? `<button class="btn btn-sm btn-primary btn-tile-resume" data-session-id="${s.id}">Resume</button>` : ''}
            </div>
          </article>`;
      }).join('');

      grid.querySelectorAll('.btn-tile-inspect').forEach(btn => {
        btn.addEventListener('click', () => this.inspectSession(btn.dataset.sessionId));
      });
      grid.querySelectorAll('.btn-tile-warn').forEach(btn => {
        btn.addEventListener('click', () => {
          const msg = prompt('Warning shown on the candidate\'s screen:', 'Please face the camera and keep your eyes on the screen.');
          if (msg) this.issueProctorWarning(btn.dataset.sessionId, msg);
        });
      });
      grid.querySelectorAll('.btn-tile-resume').forEach(btn => {
        btn.addEventListener('click', () => this.openResumeModal(btn.dataset.sessionId));
      });
      grid.querySelectorAll('.btn-tile-disqualify').forEach(btn => {
        btn.addEventListener('click', () => {
          this.activeSessionId = btn.dataset.sessionId;
          this.showInterventionModal(btn.dataset.sessionId);
        });
      });
    },

    gazeLabel(gaze) {
      if (!gaze || gaze === 'CENTER') return 'On screen';
      return String(gaze).replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
    },

    appendLiveLog(msg) {
      const term = document.getElementById('live-logs-terminal');
      const badge = document.getElementById('logs-count-badge');
      if (!term) return;

      const category = msg.category || 'system';
      const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString();
      const studentLabel = msg.studentName || msg.sessionId;

      const entry = document.createElement('div');
      entry.className = `log-entry log-${category}`;
      entry.dataset.category = category;
      entry.innerHTML = `
        <span class="log-time">[${timeStr}]</span>
        <span class="log-student-tag">${this.escapeHtml(studentLabel)}</span>
        <span class="log-text">${this.escapeHtml(msg.summary || msg.reason || 'Activity recorded')}</span>
      `;

      term.appendChild(entry);
      term.scrollTop = term.scrollHeight;

      this.logEventCount = (this.logEventCount || 0) + 1;
      if (badge) badge.textContent = `${this.logEventCount} events`;
    },

    filterLiveLogs() {
      const filter = this.activeLogFilter || 'all';
      const entries = document.querySelectorAll('.log-entry');
      entries.forEach(e => {
        if (filter === 'all' || e.dataset.category === filter || e.classList.contains('log-system')) {
          e.classList.remove('hidden');
        } else {
          e.classList.add('hidden');
        }
      });
    },

    showExtremeSuspicionPopup(msg) {
      this._lastAlertSessionId = msg.sessionId;
      const modal = document.getElementById('extreme-suspicion-modal');
      const nameEl = document.getElementById('suspicion-candidate-name');
      const idEl = document.getElementById('suspicion-candidate-id');
      const reasonEl = document.getElementById('suspicion-reason-text');
      const imgEl = document.getElementById('suspicion-snapshot-img');

      if (nameEl) nameEl.textContent = msg.studentName || msg.sessionId;
      if (idEl) idEl.textContent = `${msg.sessionId}`;
      if (reasonEl) reasonEl.textContent = msg.reason || 'Extreme suspicion infraction detected';

      if (imgEl) {
        if (msg.snapshot) {
          imgEl.src = msg.snapshot;
          imgEl.classList.remove('hidden');
        } else {
          imgEl.src = '';
          imgEl.classList.add('hidden');
        }
      }

      if (modal) modal.classList.remove('hidden');

      // Visual toast notification
      this.showToast(`${msg.studentName || msg.sessionId}: ${msg.reason}`, 'warning');
    },

    // ── Live video (WebRTC) for the candidate open in the inspector ──

    setLiveMode(text, isRtc = false) {
      const el = document.getElementById('live-mode');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('rtc', isRtc);
      el.classList.toggle('hidden', !text);
    },

    sendWs(payload) {
      if (this.proctorWs && this.proctorWs.readyState === WebSocket.OPEN) this.proctorWs.send(JSON.stringify(payload));
    },

    startWatch(sessionId) {
      if (this.watchSessionId && this.watchSessionId !== sessionId) this.stopWatch();
      this.watchSessionId = sessionId;
      this.rtcLive = false;
      if (typeof RTCPeerConnection === 'undefined') return;
      this.setLiveMode('Connecting live video…');
      this.sendWs({ type: 'WATCH_START', sessionId });
    },

    async onRtcSignal(msg) {
      if (msg.sessionId !== this.watchSessionId) return;
      try {
        if (msg.description && msg.description.type === 'offer') {
          if (this.rtc) this.rtc.close();
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pc.pendingCandidates = [];
          this.rtc = pc;
          const video = document.getElementById('live-video');
          pc.ontrack = (e) => {
            video.srcObject = e.streams[0] || new MediaStream([e.track]);
            video.play().catch(() => {});
            video.classList.remove('hidden');
            document.getElementById('live-stream-viewport').classList.add('hidden');
            document.getElementById('live-stream-placeholder').classList.add('hidden');
            this.rtcLive = true;
            this.setLiveMode('Live video', true);
          };
          pc.onicecandidate = (e) => {
            if (e.candidate) this.sendWs({ type: 'RTC_SIGNAL', sessionId: msg.sessionId, candidate: e.candidate });
          };
          pc.onconnectionstatechange = () => {
            if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && this.rtc === pc) {
              this.rtcLive = false;
              video.classList.add('hidden');
              document.getElementById('live-stream-viewport').classList.remove('hidden');
              this.setLiveMode('Video interrupted — showing snapshots');
            }
          };
          await pc.setRemoteDescription(msg.description);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendWs({ type: 'RTC_SIGNAL', sessionId: msg.sessionId, description: pc.localDescription });
          // ICE candidates that arrived while the offer was being applied
          for (const c of pc.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (msg.candidate && this.rtc) {
          if (!this.rtc.remoteDescription) this.rtc.pendingCandidates.push(msg.candidate);
          else await this.rtc.addIceCandidate(msg.candidate).catch(() => {});
        }
      } catch (err) {
        console.warn('[Dashboard] live video negotiation failed:', err.message);
        this.setLiveMode('Live video unavailable — showing snapshots');
      }
    },

    stopWatch() {
      if (this.watchSessionId) this.sendWs({ type: 'WATCH_STOP', sessionId: this.watchSessionId });
      if (this.rtc) {
        try { this.rtc.close(); } catch (_) {}
        this.rtc = null;
      }
      const video = document.getElementById('live-video');
      if (video) {
        video.srcObject = null;
        video.classList.add('hidden');
      }
      this.rtcLive = false;
      this.watchSessionId = null;
      this.setLiveMode('');
    },

    async inspectSession(sessionId) {
      this.activeSessionId = sessionId;
      const modal = document.getElementById('inspector-modal');
      if (!modal) return;
      modal.classList.remove('hidden');

      // Pre-fill header from local cache if present
      const cached = this.allSessions.find(s => s.id === sessionId);
      if (cached) {
        document.getElementById('drawer-candidate-name').textContent = cached.candidateName || 'Candidate';
        document.getElementById('drawer-student-id').textContent = cached.studentId;
        document.getElementById('drawer-session-id').textContent = cached.id;
        document.getElementById('drawer-email').textContent = cached.candidateEmail || '—';
      }

      // Fetch comprehensive audit report from backend
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/audit/session/${sessionId}/report`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const report = await res.json();
        this.renderDrawerDetails(report);
        if (report.session && report.session.status === 'IN_PROGRESS') this.startWatch(sessionId);
        else this.stopWatch();
      } catch (err) {
        console.error('Failed to load session report:', err);
      }
    },

    renderDrawerDetails(report) {
      const session = report.session || report;
      const candidate = report.candidate || {};
      const integrity = report.integrityScore || {};
      const violations = report.violations || [];
      const sites = report.browsingActivity || [];
      const timeline = (report.timeline || []).filter(ev => ev.type !== 'ANSWER_SAVED');
      const questions = report.questionResults || [];
      const insights = report.insights || [];
      const timings = new Map((report.questionTimings || []).map(t => [t.questionId, t]));
      const assistLog = report.assistLog || [];
      const time = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '—';
      const label = (t) => String(t || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
      const $ = (id) => document.getElementById(id);

      $('drawer-candidate-name').textContent = candidate.name || session.studentId;
      $('drawer-student-id').textContent = session.studentId;
      $('drawer-session-id').textContent = session.id;
      $('drawer-email').textContent = candidate.email || '—';
      $('drawer-time-started').textContent = `Started ${time(session.startedAt)}`;

      const statusPill = $('drawer-status-pill');
      const isDq = session.status && session.status.includes('DISQUALIFIED');
      const isLive = session.status === 'IN_PROGRESS';
      $('btn-drawer-resume').classList.toggle('hidden', !isDq);
      $('btn-drawer-disqualify').classList.toggle('hidden', !isLive);
      $('btn-drawer-warn').classList.toggle('hidden', !isLive);
      statusPill.textContent = session.status === 'IN_PROGRESS' ? 'Live' : isDq ? 'Terminated' : label(session.status);
      statusPill.className = `badge ${session.status === 'IN_PROGRESS' ? 'badge-emerald' : isDq ? 'badge-crimson' : 'badge-slate'}`;

      const riskPill = $('drawer-risk-pill');
      riskPill.textContent = label(integrity.rating || 'LOW_RISK');
      riskPill.className = `badge ${integrity.rating === 'HIGH_RISK' ? 'badge-crimson' : integrity.rating === 'MEDIUM_RISK' ? 'badge-amber' : 'badge-emerald'}`;

      const photo = candidate.baselinePhoto || candidate.photoBase64;
      $('drawer-baseline-photo').innerHTML = photo
        ? `<img src="${photo}" alt="Reference photo taken at sign-in">`
        : '<span class="photo-placeholder">No reference photo</span>';

      $('drawer-live-proctor-panel').classList.toggle('ended', session.status !== 'IN_PROGRESS');
      const streamImg = $('live-stream-viewport');
      const placeholder = $('live-stream-placeholder');
      if (this.rtcLive) {
        // live video already showing
      } else if (session.lastSnapshot && session.status === 'IN_PROGRESS') {
        streamImg.src = session.lastSnapshot;
        streamImg.classList.remove('hidden');
        placeholder.classList.add('hidden');
      } else {
        streamImg.classList.add('hidden');
        placeholder.classList.remove('hidden');
        const ph = placeholder.querySelector('.ph-text');
        if (ph) ph.textContent = session.status === 'IN_PROGRESS' ? 'Waiting for the next camera frame…' : 'Session has ended — no live feed.';
      }
      this.updateLiveHudGaze(session.lastGaze || 'CENTER');
      this.updateLiveHudFaces(session.lastFaceCount !== undefined ? session.lastFaceCount : 1);

      // Integrity breakdown mirrors proctorService.getAuditReport scoring.
      const inputSummary = report.inputSummary || {};
      const tabSummary = report.tabActivitySummary || {};
      $('drawer-gauge-val').textContent = integrity.score !== undefined ? integrity.score : 100;
      $('deduction-violations').querySelector('.deduction-val').textContent = `−${violations.length * 15}`;
      $('deduction-ai').querySelector('.deduction-val').textContent = `−${(tabSummary.aiToolVisits || 0) * 25}`;
      $('deduction-tabs').querySelector('.deduction-val').textContent = `−${Math.min(20, (tabSummary.totalTabSwitches || 0) * 3)}`;
      $('deduction-clipboard').querySelector('.deduction-val').textContent = `−${(inputSummary.copyPasteAttempts || 0) * 10}`;

      // Insights: answers lined up against lookups, camera flags and pace
      $('drawer-insights-header').textContent = insights.length ? `Insights (${insights.length})` : 'Insights';
      $('drawer-insights').innerHTML = insights.length === 0
        ? '<div class="empty-state">Nothing unusual found.</div>'
        : `<ul class="insight-list">${insights.map(i => `
            <li class="insight insight-${i.severity}"><span class="insight-dot"></span><span>${this.escapeHtml(i.text)}</span><span class="mono text-muted">${time(i.timestamp)}</span></li>`).join('')}</ul>`;

      // Full guided-help transcript, including refused requests
      $('drawer-assist-header').textContent = assistLog.length ? `Guided help transcript (${assistLog.length})` : 'Guided help transcript';
      $('drawer-assist').innerHTML = assistLog.length === 0
        ? '<div class="empty-state">Guided help was not used.</div>'
        : assistLog.map(e => `
            <div class="assist-entry">
              <div class="assist-entry-head"><span class="mono">Q${e.questionNumber} · ${time(e.at)}</span>${e.outcome === 'ANSWERED' ? `<span class="badge badge-slate">${e.source === 'model' ? 'AI tutor' : 'Proctor notes'}${e.removedSentences ? ` · ${e.removedSentences} removed` : ''}</span>` : `<span class="badge badge-amber">${e.outcome === 'REFUSED_ANSWER_REQUEST' ? 'Asked for the answer' : 'Off-topic'}</span>`}</div>
              <p class="assist-q">${this.escapeHtml(e.message)}</p>
              <p class="assist-a">${this.escapeHtml(e.reply)}</p>
            </div>`).join('');

      // Violations with the frame captured at the moment of each one
      $('drawer-violations-header').textContent = `Violations (${violations.length})`;
      $('drawer-violations-gallery').innerHTML = violations.length === 0
        ? '<div class="empty-state">No violations recorded.</div>'
        : violations.map(v => `
            <figure class="snapshot-card">
              ${v.snapshot ? `<img src="${v.snapshot}" class="snapshot-thumb" alt="">` : '<div class="snapshot-thumb snapshot-none">No frame</div>'}
              <figcaption>
                <span class="snapshot-type">${this.escapeHtml(label(v.type))}</span>
                <span class="snapshot-time mono">${time(v.timestamp)}</span>
              </figcaption>
            </figure>`).join('');

      // Sites visited and what was typed on each — "opened ChatGPT, then asked …"
      const aiCount = sites.filter(s => s.isAiTool).length;
      $('drawer-searches-header').textContent = `Sites and searches (${sites.length}${aiCount ? `, ${aiCount} AI` : ''})`;
      $('drawer-searches-table-container').innerHTML = sites.length === 0
        ? '<div class="empty-state">The candidate did not open any other site.</div>'
        : sites.map(site => `
            <div class="site${site.isAiTool ? ' site-ai' : ''}">
              <div class="site-head">
                <span class="site-name">${this.escapeHtml(site.service || site.domain)}</span>
                ${site.isAiTool ? '<span class="badge badge-crimson">AI assistant</span>' : ''}
                <span class="site-meta mono">${time(site.firstSeen)}${site.lastSeen - site.firstSeen >= 60000 ? `–${time(site.lastSeen)}` : ''}</span>
              </div>
              ${site.queries.length ? `<ol class="query-list">${site.queries.map(q => `
                <li><span class="mono">${time(q.timestamp)}</span><span>${this.escapeHtml(q.query)}${q.blocked ? ` <span class="badge badge-amber">blocked${q.blockReason ? `: ${this.escapeHtml(q.blockReason.replace(/_/g, ' ').toLowerCase())}` : ''}</span>` : ''}</span></li>`).join('')}</ol>`
                : '<p class="site-none">Opened; no search or prompt captured.</p>'}
            </div>`).join('');

      $('drawer-timeline-container').innerHTML = timeline.length === 0
        ? '<div class="empty-state">No events recorded.</div>'
        : timeline.map(ev => {
            const tone = ev.type === 'VIOLATION_RECORDED' ? ' violation'
              : (ev.type === 'AI_TOOL_INTERACTION' || ev.type === 'AI_SEARCH_QUERY') ? ' ai' : '';
            return `
              <div class="timeline-item${tone}">
                <span class="timeline-time mono">${time(ev.timestamp)}</span>
                <span class="timeline-desc"><strong>${this.escapeHtml(ev.title || label(ev.type))}</strong>${ev.description ? ` — ${this.escapeHtml(ev.description)}` : ''}</span>
              </div>`;
          }).join('');

      const graded = questions.some(q => q.isCorrect !== undefined);
      $('drawer-questions-table-container').innerHTML = questions.length === 0
        ? '<div class="empty-state">No questions on record.</div>'
        : `
          <table class="dashboard-table">
            <thead><tr><th>#</th><th>Question</th><th>Answer</th><th>Time spent</th><th>${graded ? 'Result' : 'Status'}</th></tr></thead>
            <tbody>
              ${questions.map((q, idx) => {
                const t = timings.get(q.questionId);
                const chosen = (q.options || []).find(o => o.id === q.selectedOptionId);
                const result = !q.isAttempted ? '<span class="text-muted">Not answered</span>'
                  : !graded ? '<span class="text-muted">Answered</span>'
                  : q.isCorrect ? '<span class="text-success">Correct</span>' : '<span class="text-danger">Incorrect</span>';
                return `
                  <tr>
                    <td class="mono">${idx + 1}</td>
                    <td class="cell-clip">${this.escapeHtml(q.prompt || q.text)}</td>
                    <td>${chosen ? this.escapeHtml(chosen.text) : '—'}</td>
                    <td class="mono">${timings.get(q.questionId) && timings.get(q.questionId).dwellMs ? `${Math.round(timings.get(q.questionId).dwellMs / 1000)}s${timings.get(q.questionId).answerChanges ? ` · ${timings.get(q.questionId).answerChanges} change${timings.get(q.questionId).answerChanges > 1 ? 's' : ''}` : ''}` : '—'}</td>
                    <td>${result}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>`;
    },

    openResumeModal(sessionId) {
      if (!sessionId) return;
      this.resumeTargetId = sessionId;
      document.getElementById('resume-reason').value = '';
      document.getElementById('resume-extra').value = '0';
      document.getElementById('resume-reset').checked = true;
      document.getElementById('resume-status').textContent = '';
      document.getElementById('resume-modal').classList.remove('hidden');
      document.getElementById('resume-reason').focus();
    },

    async resumeSession() {
      const sessionId = this.resumeTargetId;
      const btn = document.getElementById('btn-confirm-resume');
      const status = document.getElementById('resume-status');
      btn.disabled = true;
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/audit/session/${sessionId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'RESUME',
            reason: document.getElementById('resume-reason').value.trim(),
            resetWarnings: document.getElementById('resume-reset').checked,
            extraMinutes: Number(document.getElementById('resume-extra').value) || 0
          })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
        document.getElementById('resume-modal').classList.add('hidden');
        this.showToast('Attempt resumed', 'online');
        this.refreshAll(true);
        if (this.activeSessionId === sessionId) this.inspectSession(sessionId);
      } catch (err) {
        status.textContent = `Could not resume: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    },

    closeInspector() {
      this.stopWatch();
      document.getElementById('inspector-modal')?.classList.add('hidden');
      this.activeSessionId = null;
    },

    showInterventionModal(sessionId) {
      const modal = document.getElementById('action-confirm-modal');
      if (modal) modal.classList.remove('hidden');
    },

    openCreateExamModal() {
      const modal = document.getElementById('create-exam-modal');
      document.getElementById('create-exam-status-msg').textContent = '';
      document.getElementById('exam-created').classList.add('hidden');
      document.getElementById('btn-submit-create-exam').closest('.dialog-actions').classList.remove('hidden');
      ['input-new-exam-title', 'input-new-exam-code', 'input-new-exam-desc', 'input-new-exam-start', 'input-new-exam-end'].forEach(id => { document.getElementById(id).value = ''; });
      const builder = document.getElementById('question-builder');
      builder.innerHTML = '';
      this.addQuestionEditor();
      if (!this._builderBound) {
        this._builderBound = true;
        document.getElementById('btn-add-question').addEventListener('click', () => this.addQuestionEditor());
        document.getElementById('input-import-questions').addEventListener('change', (e) => this.importQuestions(e.target));
        document.getElementById('btn-done-create').addEventListener('click', () => modal.classList.add('hidden'));
        document.getElementById('btn-copy-exam-code').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(document.getElementById('exam-created-code').textContent); this.showToast('Code copied', 'online'); } catch (_) {}
        });
      }
      modal.classList.remove('hidden');
      document.getElementById('input-new-exam-title').focus();
    },

    addQuestionEditor(data = {}) {
      const builder = document.getElementById('question-builder');
      const n = builder.children.length + 1;
      const name = `correct_${Date.now()}_${n}`;
      const options = (data.options && data.options.length ? data.options : ['', '', '', '']).map(o => (typeof o === 'string' ? o : o.text || ''));
      const correct = Number.isInteger(data.correctIndex) ? data.correctIndex : 0;
      const el = document.createElement('div');
      el.className = 'q-editor';
      el.innerHTML = `
        <div class="q-editor-head">
          <span class="q-num">Q${n}</span>
          <input class="input q-category" placeholder="Topic (optional)" value="${this.escapeHtml(data.category || '')}">
          <button type="button" class="icon-btn q-remove" aria-label="Remove question">&times;</button>
        </div>
        <textarea class="input q-text" rows="2" placeholder="Question text">${this.escapeHtml(data.text || '')}</textarea>
        <div class="q-options">
          ${options.map((o, i) => `
            <label class="q-option">
              <input type="radio" name="${name}" value="${i}" ${i === correct ? 'checked' : ''} title="Correct answer">
              <input class="input q-option-text" placeholder="Option ${String.fromCharCode(65 + i)}" value="${this.escapeHtml(o)}">
            </label>`).join('')}
        </div>
        <div class="q-extra">
          <input class="input q-hint" placeholder="Hint for Guided help (concept only, optional)" value="${this.escapeHtml(data.hint || '')}">
          <input class="input q-explanation" placeholder="Explanation shown after submission (optional)" value="${this.escapeHtml(data.explanation || '')}">
        </div>`;
      el.querySelector('.q-remove').addEventListener('click', () => {
        el.remove();
        this.renumberQuestions();
      });
      builder.appendChild(el);
      this.renumberQuestions();
      if (!data.text) el.querySelector('.q-text').focus();
    },

    renumberQuestions() {
      const items = document.querySelectorAll('#question-builder .q-editor');
      items.forEach((el, i) => { el.querySelector('.q-num').textContent = `Q${i + 1}`; });
      document.getElementById('builder-count').textContent = items.length ? `(${items.length})` : '';
    },

    collectQuestions() {
      return Array.from(document.querySelectorAll('#question-builder .q-editor')).map(el => {
        const checked = el.querySelector('input[type="radio"]:checked');
        const optionInputs = Array.from(el.querySelectorAll('.q-option-text'));
        // Drop empty option rows but keep the correct index pointing at the same option.
        const filled = optionInputs.map((inp, i) => ({ text: inp.value.trim(), i })).filter(o => o.text);
        return {
          text: el.querySelector('.q-text').value.trim(),
          category: el.querySelector('.q-category').value.trim(),
          options: filled.map(o => o.text),
          correctIndex: checked ? filled.findIndex(o => o.i === Number(checked.value)) : -1,
          hint: el.querySelector('.q-hint').value.trim(),
          explanation: el.querySelector('.q-explanation').value.trim()
        };
      }).filter(q => q.text || q.options.length);
    },

    importQuestions(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          const list = Array.isArray(parsed) ? parsed : parsed.questions;
          if (!Array.isArray(list) || list.length === 0) throw new Error('Expected an array of questions');
          const builder = document.getElementById('question-builder');
          if (builder.children.length === 1 && !builder.querySelector('.q-text').value.trim()) builder.innerHTML = '';
          list.forEach(q => {
            let correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : -1;
            if (correctIndex < 0 && q.correctOptionId && Array.isArray(q.options)) correctIndex = q.options.findIndex(o => o && o.id === q.correctOptionId);
            if (correctIndex < 0 && typeof q.answer === 'string' && Array.isArray(q.options)) correctIndex = q.options.findIndex(o => (typeof o === 'string' ? o : o.text) === q.answer);
            this.addQuestionEditor({ ...q, text: q.text || q.prompt || q.question, correctIndex: Math.max(0, correctIndex) });
          });
          this.showToast(`Imported ${list.length} questions — check the marked answers`, 'online');
        } catch (err) {
          this.showToast(`Import failed: ${err.message}`, 'warning');
        } finally {
          input.value = '';
        }
      };
      reader.readAsText(file);
    },

    async submitCreateExam() {
      const statusMsg = document.getElementById('create-exam-status-msg');
      const btn = document.getElementById('btn-submit-create-exam');
      const fail = (msg) => { statusMsg.textContent = msg; statusMsg.style.color = '#c62828'; };
      const title = document.getElementById('input-new-exam-title').value.trim();
      if (!title) return fail('Give the exam a title.');

      const questions = this.collectQuestions();
      if (questions.length === 0) return fail('Add at least one question.');
      const bad = questions.findIndex(q => !q.text || q.options.length < 2 || q.correctIndex < 0);
      if (bad >= 0) return fail(`Question ${bad + 1} needs text, at least two options and a marked answer.`);

      const when = (id) => {
        const v = document.getElementById(id).value;
        return v ? new Date(v).getTime() : undefined;
      };
      const startsAt = when('input-new-exam-start');
      const endsAt = when('input-new-exam-end');
      if (startsAt && endsAt && endsAt <= startsAt) return fail('The exam must close after it opens.');
      if (endsAt && endsAt <= Date.now()) return fail('The closing time is already in the past.');

      const payload = {
        title,
        startsAt,
        endsAt,
        id: document.getElementById('input-new-exam-code').value.trim() || undefined,
        durationMinutes: parseInt(document.getElementById('input-new-exam-duration').value, 10) || 30,
        description: document.getElementById('input-new-exam-desc').value.trim(),
        questions,
        rules: {
          enableVisionProctoring: document.getElementById('toggle-new-rule-vision').checked,
          enableMultiTab: document.getElementById('toggle-new-rule-multitab').checked,
          enableAiGuard: document.getElementById('toggle-new-rule-aiguard').checked,
          enableClipboardProtection: document.getElementById('toggle-new-rule-clipboard').checked,
          enableGuidedAssistant: document.getElementById('toggle-new-rule-assist').checked,
          enableVoiceMonitoring: document.getElementById('toggle-new-rule-voice').checked,
          strictness: document.getElementById('select-new-rule-strictness').value,
          maxStrikes: parseInt(document.getElementById('select-new-rule-strikes').value, 10) || 3
        }
      };

      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/assessment/exams`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        const created = await res.json();
        if (!res.ok) throw new Error(created.message || `HTTP ${res.status}`);
        statusMsg.textContent = '';
        document.getElementById('exam-created-code').textContent = this.formatCode(created.code);
        document.getElementById('exam-created').classList.remove('hidden');
        btn.closest('.dialog-actions').classList.add('hidden');
        await this.fetchExamsList();
        this.setActiveExam(created.id);
      } catch (err) {
        fail(`Could not create the exam: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create exam';
      }
    },

    updateLiveFrameView(msg) {
      const streamImg = document.getElementById('live-stream-viewport');
      const placeholder = document.getElementById('live-stream-placeholder');
      if (msg.snapshot && streamImg && !this.rtcLive) {
        streamImg.src = msg.snapshot;
        streamImg.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
      }

      this.updateLiveHudGaze(msg.gaze || 'CENTER');
      this.updateLiveHudFaces(msg.faceCount !== undefined ? msg.faceCount : 1);

      const poseBadge = document.getElementById('live-hud-pose');
      if (poseBadge && msg.headPose) {
        const yaw = Math.round(msg.headPose.yaw || 0);
        const pitch = Math.round(msg.headPose.pitch || 0);
        poseBadge.textContent = `Yaw ${yaw > 0 ? '+' : ''}${yaw}° · Pitch ${pitch > 0 ? '+' : ''}${pitch}`;
      }

      const qBadge = document.getElementById('live-hud-q');
      if (qBadge && msg.questionIdx) {
        qBadge.textContent = `Question ${msg.questionIdx}${msg.questionTotal ? ` of ${msg.questionTotal}` : ''}`;
      }
    },

    updateLiveHudGaze(gaze = 'CENTER') {
      const gazeBadge = document.getElementById('live-hud-gaze');
      if (!gazeBadge) return;
      gazeBadge.textContent = this.gazeLabel(gaze);
      if (gaze === 'CENTER') {
        gazeBadge.className = 'badge badge-emerald';
      } else if (gaze === 'LOOKING_AWAY' || gaze === 'OFF_SCREEN') {
        gazeBadge.className = 'badge badge-crimson';
      } else {
        gazeBadge.className = 'badge badge-amber';
      }
    },

    updateLiveHudFaces(count = 1) {
      const faceBadge = document.getElementById('live-hud-faces');
      if (!faceBadge) return;
      faceBadge.textContent = count === 1 ? '1 face' : (count === 0 ? 'No face' : `${count} faces`);
      if (count === 1) {
        faceBadge.className = 'badge badge-emerald';
      } else {
        faceBadge.className = 'badge badge-crimson';
      }
    },

    sendProctorCustomMessage() {
      if (!this.activeSessionId) return;
      const input = document.getElementById('input-proctor-custom-msg');
      const msg = input?.value.trim();
      if (!msg) return;

      if (this.proctorWs && this.proctorWs.readyState === WebSocket.OPEN) {
        this.proctorWs.send(JSON.stringify({
          type: 'SEND_MESSAGE',
          sessionId: this.activeSessionId,
          message: msg
        }));
        this.showToast(`Transmitted proctor alert to ${this.activeSessionId}`, 'online');
        if (input) input.value = '';
      } else {
        alert('WebSocket is currently disconnected.');
      }
    },

    async openExamRulesModal() {
      const modal = document.getElementById('exam-rules-modal');
      const statusMsg = document.getElementById('rules-status-msg');
      if (statusMsg) statusMsg.textContent = '';
      if (!this.activeExamId || this.activeExamId === 'ALL') {
        this.showToast('Choose an exam in the top bar first', 'warning');
        return;
      }
      if (modal) modal.classList.remove('hidden');

      try {
        const res = await this.authFetch(`${this.baseUrl}/api/assessment/exams/${this.activeExamId}`);
        if (!res.ok) return;
        const exam = await res.json();
        const rules = exam.rules || {};

        document.getElementById('rules-exam-title').textContent = exam.title || 'Technical Assessment';
        document.getElementById('toggle-rule-vision').checked = rules.enableVisionProctoring !== false;
        document.getElementById('toggle-rule-multitab').checked = rules.enableMultiTab !== false;
        document.getElementById('toggle-rule-aiguard').checked = rules.enableAiGuard !== false;
        document.getElementById('toggle-rule-clipboard').checked = rules.enableClipboardProtection !== false;
        document.getElementById('toggle-rule-assist').checked = rules.enableGuidedAssistant !== false;
        document.getElementById('toggle-rule-voice').checked = rules.enableVoiceMonitoring !== false;
        document.getElementById('select-rule-strictness').value = rules.strictness || 'standard';
        document.getElementById('select-rule-strikes').value = String(rules.maxStrikes || 3);
      } catch (err) {
        console.warn('Failed to load exam rules:', err);
      }
    },

    async saveExamRules() {
      const btn = document.getElementById('btn-save-exam-rules');
      const statusMsg = document.getElementById('rules-status-msg');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
      }

      const rules = {
        enableVisionProctoring: document.getElementById('toggle-rule-vision')?.checked ?? true,
        enableMultiTab: document.getElementById('toggle-rule-multitab')?.checked ?? true,
        enableAiGuard: document.getElementById('toggle-rule-aiguard')?.checked ?? true,
        enableClipboardProtection: document.getElementById('toggle-rule-clipboard')?.checked ?? true,
        enableGuidedAssistant: document.getElementById('toggle-rule-assist')?.checked ?? true,
        enableVoiceMonitoring: document.getElementById('toggle-rule-voice')?.checked ?? true,
        strictness: document.getElementById('select-rule-strictness')?.value || 'standard',
        maxStrikes: parseInt(document.getElementById('select-rule-strikes')?.value, 10) || 3
      };

      try {
        const res = await this.authFetch(`${this.baseUrl}/api/assessment/exams/${this.activeExamId}/rules`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rules)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (statusMsg) {
          statusMsg.textContent = 'Saved.';
          statusMsg.style.color = '';
        }
        this.showToast('Exam rules saved', 'online');
        setTimeout(() => {
          document.getElementById('exam-rules-modal')?.classList.add('hidden');
        }, 1200);
      } catch (err) {
        if (statusMsg) {
          statusMsg.textContent = `Failed: ${err.message}`;
          statusMsg.style.color = '#dc2626';
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Save rules';
        }
      }
    },

    async issueProctorWarning(sessionId, message) {
      // 1. Send instant warning via WebSocket
      if (this.proctorWs && this.proctorWs.readyState === WebSocket.OPEN) {
        this.proctorWs.send(JSON.stringify({
          type: 'WARN_CANDIDATE',
          sessionId,
          message
        }));
      }

      // 2. Persist warning in backend
      try {
        await this.authFetch(`${this.baseUrl}/api/audit/session/${sessionId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'WARN', message })
        });
        this.showToast('Warning sent to the candidate', 'warning');
        await this.refreshAll(true);
        if (this.activeSessionId === sessionId) {
          await this.inspectSession(sessionId);
        }
      } catch (err) {
        console.warn('Failed to issue warning:', err);
      }
    },

    async executeDisqualification(sessionId, reason) {
      // 1. Send instant lock command via WebSocket for immediate response
      if (this.proctorWs && this.proctorWs.readyState === WebSocket.OPEN) {
        this.proctorWs.send(JSON.stringify({
          type: 'TERMINATE_SESSION',
          sessionId,
          reason
        }));
      }

      // 2. Call backend REST action
      try {
        const res = await this.authFetch(`${this.baseUrl}/api/audit/session/${sessionId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'DISQUALIFY', reason })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        document.getElementById('action-confirm-modal')?.classList.add('hidden');
        this.showToast('Session terminated', 'warning');
        await this.refreshAll();
        if (this.activeSessionId === sessionId) {
          await this.inspectSession(sessionId);
        }
      } catch (err) {
        alert(`Failed to disqualify candidate: ${err.message}`);
      }
    },

    escapeHtml(str) {
      if (!str || typeof str !== 'string') return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    AdminDashboard.init();
  });

  window.AdminDashboard = AdminDashboard;
})();
