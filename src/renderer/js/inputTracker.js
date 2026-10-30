/**
 * InputTracker — keyboard, mouse, clipboard and device telemetry
 * Suspicious events are sent immediately; routine activity is summarised every few
 * seconds so the audit log shows typing/mouse patterns without flooding the backend.
 */
(function () {
  'use strict';

  const SUMMARY_INTERVAL_MS = 10000;

  // Audio devices whose names identify earphones or headsets (Bluetooth or wired).
  // Webcams can't reliably see earbuds, but the operating system lists them by name.
  const EARPIECE_PATTERN = /(airpods|buds\b|earbud|ear ?phone|headphone|headset|hands-?free|\bhfp\b|bluetooth|jabra|bose|beats|\bjbl\b|\bboat\b|skullcandy|sennheiser|sony wh|sony wf|nothing ear|oneplus nord buds|realme buds|noise buds)/i;

  const InputTracker = {
    active: false,
    bound: false,
    summaryTimer: null,
    keys: 0,
    mouse: { moves: 0, distance: 0, clicks: 0, lastX: null, lastY: null },
    knownDevices: null,

    init() {
      this.active = true;
      if (this.bound) return;
      this.bound = true;
      this.bindKeyboard();
      this.bindMouse();
      this.bindClipboard();
      this.bindVisibility();
      this.bindDevices();
      this.summaryTimer = setInterval(() => this.flushSummary(), SUMMARY_INTERVAL_MS);
    },

    inExam() {
      const s = window.AppState;
      return this.active && s && s.sessionId && !s.submitted && !s.disqualified;
    },

    bindKeyboard() {
      document.addEventListener('keydown', (e) => {
        if (!this.inExam()) return;
        this.keys++;
        const k = e.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;
        const suspicious =
          (ctrl && ['c', 'v', 'x', 'a', 'p', 's', 'u'].includes(k)) ||
          (e.altKey && k === 'tab') ||
          k === 'f12' || k === 'printscreen' ||
          (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k));
        if (!suspicious) return;

        if (k === 'f12' || (ctrl && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (ctrl && ['u', 'p', 's'].includes(k))) {
          e.preventDefault();
        }
        this.send('KEYSTROKE', { combo: this.formatCombo(e), suspicious: true });
      }, true);
    },

    bindMouse() {
      document.addEventListener('mousemove', (e) => {
        if (!this.inExam()) return;
        const m = this.mouse;
        if (m.lastX !== null) m.distance += Math.hypot(e.clientX - m.lastX, e.clientY - m.lastY);
        m.lastX = e.clientX;
        m.lastY = e.clientY;
        m.moves++;
      }, { passive: true });
      document.addEventListener('mousedown', () => { if (this.inExam()) this.mouse.clicks++; }, { passive: true });
      document.documentElement.addEventListener('mouseleave', () => {
        if (this.inExam() && window.AppState.currentView === 'exam') this.send('MOUSE_LEAVE_WINDOW', {});
      });
    },

    bindClipboard() {
      ['copy', 'cut', 'paste'].forEach(action => {
        document.addEventListener(action, (e) => {
          if (!this.inExam()) return;
          const rules = window.AppState.rules || {};
          let textLength = 0;
          try { textLength = (e.clipboardData && e.clipboardData.getData('text').length) || String(window.getSelection() || '').length; } catch (_) {}
          if (rules.enableClipboardProtection !== false && window.AppState.currentView === 'exam') {
            e.preventDefault();
          }
          this.send('CLIPBOARD', { action, textLength, blocked: rules.enableClipboardProtection !== false });
        });
      });
    },

    bindVisibility() {
      const GRACE_MS = 3000;
      document.addEventListener('visibilitychange', () => {
        if (!this.inExam()) return;
        const hidden = document.visibilityState === 'hidden';
        this.send('VISIBILITY', { state: document.visibilityState, awayMs: hidden ? 0 : Date.now() - (this.hiddenAt || Date.now()) });

        // In a normal browser, other tabs are invisible to us, so leaving the exam tab is the
        // violation (the desktop app instead records what is done in its own tabs).
        if (window.proctorAPI) return;
        clearTimeout(this.hiddenTimer);
        if (hidden) {
          this.hiddenAt = Date.now();
          this.hiddenTimer = setTimeout(() => {
            if (!this.inExam() || document.visibilityState !== 'hidden') return;
            window.ProctorClient && window.ProctorClient.reportViolation(
              { type: 'LEFT_EXAM_TAB', details: { graceMs: GRACE_MS } },
              'You left the exam tab. Use "Look it up" to search instead of other tabs.'
            );
          }, GRACE_MS);
        } else {
          this.hiddenAt = null;
        }
      });
    },

    // A camera, microphone or audio device appearing mid-exam (phone as webcam, Bluetooth earpiece…)
    /** Labels of connected earphones/headsets. Needs device labels, which a mic permission unlocks. */
    async currentEarpieces() {
      const md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return [];
      let list = await md.enumerateDevices();
      const audio = list.filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput');
      if (audio.length && audio.every(d => !d.label)) {
        // Browsers hide device names until a capture permission covers audio.
        try {
          const probe = await md.getUserMedia({ audio: true });
          probe.getTracks().forEach(t => t.stop());
          list = await md.enumerateDevices();
        } catch (_) {
          return [];
        }
      }
      return this.findEarpieces(list);
    },

    findEarpieces(list) {
      const names = list
        .filter(d => (d.kind === 'audioinput' || d.kind === 'audiooutput') && EARPIECE_PATTERN.test(d.label || ''))
        .map(d => d.label.replace(/^(Default|Communications)\s*-\s*/i, '').trim());
      return [...new Set(names)];
    },

    bindDevices() {
      const md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return;
      const snapshot = async () => {
        const list = await md.enumerateDevices();
        return new Map(list.map(d => [d.deviceId + d.kind, `${d.kind}${d.label ? `: ${d.label}` : ''}`]));
      };
      snapshot().then(map => { this.knownDevices = map; }).catch(() => {});
      md.addEventListener('devicechange', async () => {
        let current;
        try { current = await snapshot(); } catch (_) { return; }
        const before = this.knownDevices || new Map();
        const added = [...current.entries()].filter(([id]) => !before.has(id)).map(([, l]) => l);
        const removed = [...before.entries()].filter(([id]) => !current.has(id)).map(([, l]) => l);
        this.knownDevices = current;
        window.AuthView && window.AuthView.refreshEarpieceCheck && window.AuthView.refreshEarpieceCheck();
        if (!this.inExam() || (added.length === 0 && removed.length === 0)) return;
        this.send('DEVICE_CHANGE', { added, removed, suspicious: added.length > 0 });

        const earpieces = added.filter(label => EARPIECE_PATTERN.test(label)).map(l => l.replace(/^[a-z]+:\s*/, ''));
        if (earpieces.length && window.ProctorClient) {
          window.ProctorClient.reportViolation(
            { type: 'EARPIECE_DETECTED', details: { devices: [...new Set(earpieces)] } },
            `Earphones or a headset were connected: ${[...new Set(earpieces)].join(', ')}`
          );
          return;
        }
        if (added.length) {
          window.showWarning(`New device connected: ${added.join(', ')}. This has been recorded.`,
            window.AppState.strikes, window.AppState.maxStrikes, { informational: true });
        }
      });
    },

    flushSummary() {
      if (!this.inExam()) return;
      const m = this.mouse;
      if (this.keys > 0) {
        this.send('KEY_SUMMARY', { keyCount: this.keys, perMinute: Math.round(this.keys * 60000 / SUMMARY_INTERVAL_MS) });
      }
      if (m.moves > 0 || m.clicks > 0) {
        this.send('MOUSE_BURST', { count: m.moves, distancePx: Math.round(m.distance), clicks: m.clicks, windowMs: SUMMARY_INTERVAL_MS });
      }
      this.keys = 0;
      m.moves = 0; m.distance = 0; m.clicks = 0;
    },

    send(type, data) {
      const state = window.AppState;
      if (!state || !state.sessionId) return;
      const payload = { ...data, view: state.currentView, timestamp: Date.now() };

      const ws = window.studentSocket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'INPUT_EVENT', sessionId: state.sessionId, eventType: type, data: payload, studentName: state.studentName || state.studentId, timestamp: payload.timestamp }));
        } catch (_) {}
      }
      // Always persist through the backend; the desktop IPC bridge does not store telemetry.
      window.api.post('/api/proctor/input-activity', { sessionId: state.sessionId, type, data: payload }).catch(() => {});
    },

    formatCombo(e) {
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.metaKey) parts.push('Meta');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      return parts.join('+');
    },

    stop() {
      this.flushSummary();
      this.active = false;
    }
  };

  window.InputTracker = InputTracker;
})();
