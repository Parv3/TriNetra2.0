/**
 * App.js — application shell
 * Shared state, backend client, view switching, warnings, timer, lockdown lifecycle.
 */
(function () {
  'use strict';

  const isHttpHost = typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http');
  const initialBaseUrl = isHttpHost ? window.location.origin : 'http://127.0.0.1:4100';

  const state = {
    backendPort: 4100,
    baseUrl: initialBaseUrl,
    deviceId: getDeviceId(),
    selectedExamId: 'exam_ai_proctor_v1',
    examTitle: '',
    token: null,
    studentId: null,
    studentName: null,
    sessionId: null,
    currentView: 'auth',
    questions: [],
    currentQuestionIdx: 0,
    answers: {},
    flagged: new Set(),
    timerInterval: null,
    expiresAt: null,
    strikes: 0,
    maxStrikes: 3,
    disqualified: false,
    submitted: false
  };
  window.AppState = state;

  // A stable per-install id lets the backend tell "same machine resuming" apart
  // from "second device logging in with the same roll number".
  function getDeviceId() {
    try {
      let id = localStorage.getItem('trinetra.deviceId');
      if (!id) {
        id = 'dev_' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
        localStorage.setItem('trinetra.deviceId', id);
      }
      return id;
    } catch (_) {
      return 'dev_ephemeral_' + Math.random().toString(36).slice(2);
    }
  }

  // ── Backend client ──
  const api = {
    async request(method, path, body = null) {
      const headers = { 'Content-Type': 'application/json' };
      if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
      const opts = { method, headers };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${state.baseUrl}${path}`, opts);
      let data = {};
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) throw { status: res.status, ...data };
      return data;
    },
    get: (path) => api.request('GET', path),
    post: (path, body) => api.request('POST', path, body)
  };
  window.api = api;

  window.escapeHtml = function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── Views ──
  const EXAM_CHROME_VIEWS = ['exam', 'guest-browser', 'native-tab'];

  function switchView(viewName) {
    const appContent = document.getElementById('app-content');
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.classList.add('hidden');
    });

    if (viewName === 'native-tab') {
      // A guest WebContentsView is drawn over the page; keep the DOM laid out but invisible.
      appContent && appContent.classList.add('native-tab-active');
    } else {
      appContent && appContent.classList.remove('native-tab-active');
      const target = document.getElementById(`view-${viewName}`);
      if (target) {
        target.classList.remove('hidden');
        target.classList.add('active');
      }
    }
    state.currentView = viewName;

    // The tab strip and address bar drive real tabs, which only the desktop app has.
    const inExam = EXAM_CHROME_VIEWS.includes(viewName) && Boolean(window.proctorAPI);
    document.getElementById('tab-strip-area')?.classList.toggle('hidden', !inExam);
    document.getElementById('omnibox-bar')?.classList.toggle('hidden', !inExam);
    // Students never get a shortcut to the proctor console once an attempt is underway.
  }
  window.switchView = switchView;

  // ── Warnings ──
  let warningTimeout = null;
  function showWarning(message, strikes, maxStrikes, options = {}) {
    const banner = document.getElementById('warning-banner');
    if (!banner) return;
    document.getElementById('warning-text').textContent = message;
    const counter = document.getElementById('strike-counter');
    counter.textContent = options.informational ? 'Logged' : `Warning ${strikes} of ${maxStrikes}`;
    banner.classList.toggle('informational', Boolean(options.informational));
    banner.classList.remove('hidden');
    requestAnimationFrame(() => banner.classList.add('show'));
    clearTimeout(warningTimeout);
    warningTimeout = setTimeout(() => {
      banner.classList.remove('show');
      setTimeout(() => banner.classList.add('hidden'), 200);
    }, options.informational ? 4000 : 6000);

    if (!options.informational) {
      updateStrikeTrack();
      playChime();
    }
  }
  window.showWarning = showWarning;

  function updateStrikeTrack() {
    const track = document.getElementById('strike-track');
    const label = document.getElementById('side-strikes');
    if (label) label.textContent = `${state.strikes} of ${state.maxStrikes}`;
    if (!track) return;
    track.style.setProperty('--strikes', state.maxStrikes);
    track.innerHTML = Array.from({ length: state.maxStrikes }, (_, i) =>
      `<span class="strike${i < state.strikes ? ' filled' : ''}"></span>`).join('');
  }
  window.updateStrikeTrack = updateStrikeTrack;

  function playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (_) {}
  }

  function terminate(reason) {
    if (state.disqualified) return;
    state.disqualified = true;
    clearInterval(state.timerInterval);
    window.ProctorClient && window.ProctorClient.stop();
    window.VoiceMonitor && window.VoiceMonitor.stop();
    window.InputTracker && window.InputTracker.stop();
    window.LiveStream && window.LiveStream.stopAll();
    endLockdown();
    const reasonEl = document.getElementById('disqualify-reason');
    if (reasonEl) reasonEl.textContent = reason || 'The warning limit was reached.';
    switchView('disqualified');
  }
  window.terminateAttempt = terminate;

  /** The proctor reopened a terminated attempt: restore the exam and restart monitoring. */
  function resumeAttempt(msg) {
    if (!state.sessionId || !state.disqualified) return;
    state.disqualified = false;
    state.submitted = false;
    state.strikes = typeof msg.strikeCount === 'number' ? msg.strikeCount : state.strikes;
    if (msg.expiresAt) state.expiresAt = msg.expiresAt;

    switchView('exam');
    updateStrikeTrack();
    window.ExamView && window.ExamView.init();
    window.InputTracker && window.InputTracker.init();
    beginLockdown(state.sessionId);
    if ((state.rules || {}).enableVisionProctoring !== false && window.ProctorClient) window.ProctorClient.init(null);
    if ((state.rules || {}).enableVoiceMonitoring !== false && window.VoiceMonitor && window.VoiceMonitor.enabled) window.VoiceMonitor.start({ strictness: (state.rules || {}).strictness || 'standard' });
    startTimer();
    showWarning(msg.message || 'Your proctor has resumed your exam.', state.strikes, state.maxStrikes, { informational: true });
  }
  window.resumeAttempt = resumeAttempt;

  // ── Lockdown (desktop shell only) ──
  async function beginLockdown(sessionId) {
    document.body.classList.add('locked');
    try { await window.proctorAPI?.startLockdown?.(sessionId); } catch (_) {}
  }
  async function endLockdown() {
    document.body.classList.remove('locked');
    try { await window.proctorAPI?.stopLockdown?.(); } catch (_) {}
  }
  window.beginLockdown = beginLockdown;
  window.endLockdown = endLockdown;

  // ── Timer ──
  function startTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }
  window.startTimer = startTimer;

  function updateTimer() {
    if (!state.expiresAt) return;
    const totalSec = Math.ceil(Math.max(0, state.expiresAt - Date.now()) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    const display = document.getElementById('timer-display');
    const badge = document.getElementById('exam-timer');
    if (display) display.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    if (badge) {
      badge.classList.toggle('danger', totalSec <= 60);
      badge.classList.toggle('warning', totalSec > 60 && totalSec <= 300);
    }
    if (totalSec <= 0) {
      clearInterval(state.timerInterval);
      if (!state.submitted && !state.disqualified) window.ExamView && window.ExamView.autoSubmit();
    }
  }

  // ── Title bar ──
  function initTitlebar() {
    const proctorAPI = window.proctorAPI;
    // Proctors on this computer: Ctrl+Shift+P opens the console in the normal browser (sign-in
    // still required). Never available once an exam attempt has started.
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') || state.sessionId) return;
      e.preventDefault();
      const adminUrl = `${state.baseUrl}/admin`;
      if (proctorAPI && proctorAPI.openConsole) proctorAPI.openConsole();
      else window.open(adminUrl, '_blank');
    });
    document.getElementById('btn-minimize')?.addEventListener('click', () => proctorAPI && proctorAPI.minimizeWindow());
    document.getElementById('btn-maximize')?.addEventListener('click', () => proctorAPI && proctorAPI.maximizeWindow());
    document.getElementById('btn-close')?.addEventListener('click', () => {
      if (state.sessionId && !state.submitted && !state.disqualified) {
        showModal('Leave the exam?', 'Closing the browser does not pause the timer. Your saved answers are kept and you can resume on this device until time runs out.', '', () => {
          proctorAPI ? proctorAPI.closeWindow() : window.close();
        }, 'Close anyway');
        return;
      }
      proctorAPI ? proctorAPI.closeWindow() : window.close();
    });
  }

  function setExamChrome() {
    const title = document.getElementById('titlebar-exam-title');
    if (title && state.examTitle) {
      title.textContent = state.examTitle;
      title.classList.remove('hidden');
    }
    const badge = document.getElementById('titlebar-session-badge');
    if (badge && state.studentId) {
      badge.textContent = state.studentName && state.studentName !== state.studentId
        ? `${state.studentName} · ${state.studentId}`
        : state.studentId;
      badge.classList.remove('hidden');
    }
  }
  window.setExamChrome = setExamChrome;

  // ── Events pushed from the desktop shell (integrity monitor) ──
  function initProctorEvents() {
    const proctorAPI = window.proctorAPI;
    if (!proctorAPI) return;

    proctorAPI.onProctorWarning?.((warning) => {
      if (!warning || state.submitted || state.disqualified) return;
      if (warning.informational) {
        showWarning(warning.message || 'Activity recorded', state.strikes, state.maxStrikes, { informational: true });
        return;
      }
      if (typeof warning.strikeCount === 'number') state.strikes = warning.strikeCount;
      showWarning(warning.message || 'Suspicious activity detected', state.strikes, state.maxStrikes);
    });

    proctorAPI.onDisqualify?.((reason) => terminate(reason));
  }

  // ── Dialog ──
  function showModal(title, body, summary, onConfirm, confirmLabel = 'Submit') {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    document.getElementById('modal-summary').innerHTML = summary || '';
    overlay.classList.remove('hidden');

    const confirmBtn = document.getElementById('modal-confirm');
    const fresh = confirmBtn.cloneNode(true);
    fresh.textContent = confirmLabel;
    confirmBtn.parentNode.replaceChild(fresh, confirmBtn);
    fresh.addEventListener('click', () => {
      overlay.classList.add('hidden');
      onConfirm && onConfirm();
    });
    document.getElementById('modal-cancel').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
    fresh.focus();
  }
  window.showModal = showModal;

  // ── Live channel to the proctor console ──
  function connectStudentWebSocket(sessionId) {
    if (!sessionId) return;
    try {
      const wsProtocol = state.baseUrl.startsWith('https') ? 'wss:' : 'ws:';
      const wsHost = state.baseUrl.replace(/^https?:\/\//, '');
      const tokenParam = state.token ? `&token=${encodeURIComponent(state.token)}` : '';
      const ws = new WebSocket(`${wsProtocol}//${wsHost}/ws/proctor?role=student&sessionId=${encodeURIComponent(sessionId)}${tokenParam}`);

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (['WATCH_REQUEST', 'WATCH_STOP', 'RTC_SIGNAL'].includes(msg.type)) {
          window.LiveStream && window.LiveStream.handle(msg);
        } else if (msg.type === 'RESUMED') {
          resumeAttempt(msg);
        } else if (msg.type === 'TERMINATED' || msg.action === 'LOCK_EXAM') {
          terminate(msg.reason || 'The proctor ended this session.');
        } else if (msg.type === 'PROCTOR_WARNING') {
          state.strikes = msg.strikeCount || (state.strikes + 1);
          showWarning(msg.message || 'Warning issued by the proctor', state.strikes, state.maxStrikes);
        } else if (msg.type === 'PROCTOR_MESSAGE') {
          showWarning(`Message from proctor: ${msg.message}`, state.strikes, state.maxStrikes, { informational: true });
        }
      };
      ws.onclose = () => {
        if (!state.submitted) setTimeout(() => connectStudentWebSocket(sessionId), 3000);
      };
      window.studentSocket = ws;
    } catch (_) {}
  }
  window.connectStudentWebSocket = connectStudentWebSocket;

  // ── Init ──
  async function init() {
    try {
      if (window.proctorAPI && window.proctorAPI.getServerUrl) {
        // Embedded backend, or the central exam server the desktop app is configured for
        state.baseUrl = (await window.proctorAPI.getServerUrl()) || state.baseUrl;
        state.localServerUrl = state.baseUrl;
        // Reconnect to the proctor's computer this app joined last time, if it's still there.
        let saved = null;
        try { saved = localStorage.getItem('trinetra.serverUrl'); } catch (_) {}
        if (saved && saved !== state.baseUrl && window.proctorAPI.setServerUrl) {
          try {
            const res = await fetch(`${saved}/api/health`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              state.baseUrl = saved;
              await window.proctorAPI.setServerUrl(saved);
            }
          } catch (_) {}
        }
      } else if (window.proctorAPI && window.proctorAPI.getBackendPort) {
        state.backendPort = await window.proctorAPI.getBackendPort();
        state.baseUrl = `http://127.0.0.1:${state.backendPort}`;
      }
    } catch (_) {}

    // In a normal browser there are no desktop tabs or window controls; searching happens in "Look it up".
    if (!window.proctorAPI) document.body.classList.add('web-mode');

    initTitlebar();
    initProctorEvents();
    switchView('auth');
    updateStrikeTrack();

    window.AuthView && window.AuthView.init();
    window.TabsUI && window.TabsUI.init();
    window.InputTracker && window.InputTracker.init();
    window.ProctorClient && typeof window.ProctorClient.preload === 'function' && window.ProctorClient.preload();

    document.getElementById('btn-dq-audit')?.addEventListener('click', () => {
      window.AuditView && window.AuditView.load();
      switchView('audit');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
