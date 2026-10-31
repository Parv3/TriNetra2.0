/**
 * Status strip in the title bar. The exam runs full-screen, which hides the taskbar, so the
 * clock, battery, network and camera state are shown here, with the time left and warnings
 * once an attempt is in progress.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  let battery = null;
  let lowBatteryWarned = false;

  const pad = (n) => String(n).padStart(2, '0');

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h ? `${h} h ${pad(m)} min` : `${m} min`;
  }

  function set(id, text, tone, title) {
    const el = $(id);
    if (!el) return;
    el.querySelector('.status-text').textContent = text;
    el.dataset.tone = tone || '';
    if (title !== undefined) el.title = title;
  }

  function renderClock() {
    const now = new Date();
    set('status-clock', `${pad(now.getHours())}:${pad(now.getMinutes())}`, '',
      now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }));
  }

  function renderBattery() {
    const el = $('status-battery');
    if (!el) return;
    if (!battery) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const pct = Math.round(battery.level * 100);
    const left = battery.charging ? formatDuration(battery.chargingTime) : formatDuration(battery.dischargingTime);
    const text = battery.charging ? `${pct}% · charging` : `${pct}%${left ? ` · ${left} left` : ''}`;
    const tone = battery.charging ? 'ok' : pct <= 15 ? 'bad' : pct <= 30 ? 'warn' : '';
    set('status-battery', text, tone, battery.charging
      ? (left ? `Charging — full in about ${left}` : 'Charging')
      : (left ? `On battery — about ${left} remaining` : 'On battery'));
    el.querySelector('.battery-fill')?.setAttribute('width', String(Math.max(1, Math.round(battery.level * 12))));

    // Plugging in matters most during an attempt: say so once, before the laptop dies mid-exam.
    const inExam = window.AppState && window.AppState.sessionId && !window.AppState.submitted;
    if (inExam && !battery.charging && pct <= 20 && !lowBatteryWarned && typeof window.showWarning === 'function') {
      lowBatteryWarned = true;
      window.showWarning(`Battery at ${pct}%. Plug in your charger — your answers are saved, but the exam timer keeps running if the laptop shuts down.`,
        window.AppState.strikes, window.AppState.maxStrikes, { informational: true });
    }
    if (battery.charging || pct > 25) lowBatteryWarned = false;
  }

  function renderNetwork() {
    const conn = navigator.connection;
    if (!navigator.onLine) return set('status-network', 'Offline', 'bad', 'No internet connection — answers are kept and sent when you reconnect');
    const type = conn && conn.effectiveType ? conn.effectiveType.toUpperCase() : '';
    const slow = conn && ['slow-2g', '2g'].includes(conn.effectiveType);
    set('status-network', slow ? 'Weak' : 'Online', slow ? 'warn' : 'ok',
      `Connected${type ? ` (${type}${conn.downlink ? `, ~${conn.downlink} Mbps` : ''})` : ''}`);
  }

  function renderExam() {
    const state = window.AppState || {};
    const inExam = Boolean(state.sessionId) && !state.submitted && !state.disqualified;
    ['status-camera', 'status-time', 'status-warnings'].forEach(id => $(id)?.classList.toggle('hidden', !inExam));
    const voiceOn = inExam && (state.rules || {}).enableVoiceMonitoring !== false && window.VoiceMonitor;
    $('status-mic')?.classList.toggle('hidden', !voiceOn);
    if (voiceOn) {
      const mic = window.VoiceMonitor.state();
      set('status-mic', mic === 'off' ? 'Mic off' : mic === 'speech' ? 'Voice heard' : 'Mic on',
        mic === 'off' ? 'bad' : mic === 'speech' ? 'warn' : 'ok',
        mic === 'off' ? 'The microphone is not working — check that it is connected and allowed'
          : 'The microphone listens for other voices. Sound stays on this laptop.');
    }
    if (!inExam) return;

    const stream = window.ProctorClient && window.ProctorClient.stream;
    const live = stream && stream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);
    set('status-camera', live ? 'Camera on' : 'Camera off', live ? 'ok' : 'bad',
      live ? 'Your camera is being monitored' : 'Camera is not sending video — check that it is connected');

    if (state.expiresAt) {
      const left = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000));
      const text = left >= 3600 ? `${Math.floor(left / 3600)}:${pad(Math.floor(left % 3600 / 60))}:${pad(left % 60)}` : `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
      set('status-time', `${text} left`, left <= 60 ? 'bad' : left <= 300 ? 'warn' : '', 'Time left in this attempt');
    }

    const max = state.maxStrikes || 3;
    const used = state.strikes || 0;
    set('status-warnings', `${used}/${max} warnings`, used === 0 ? '' : used >= max - 1 ? 'bad' : 'warn',
      `${max - used} more confirmed violation${max - used === 1 ? '' : 's'} ends the attempt`);
  }

  function tick() {
    renderClock();
    renderExam();
  }

  async function init() {
    if (!$('status-strip')) return;
    tick();
    renderNetwork();
    setInterval(tick, 1000);
    window.addEventListener('online', renderNetwork);
    window.addEventListener('offline', renderNetwork);
    if (navigator.connection) navigator.connection.addEventListener('change', renderNetwork);
    try {
      if (navigator.getBattery) {
        battery = await navigator.getBattery();
        ['levelchange', 'chargingchange', 'dischargingtimechange', 'chargingtimechange'].forEach(evt => battery.addEventListener(evt, renderBattery));
      }
    } catch (_) { battery = null; }
    renderBattery();
  }

  window.StatusBar = { init, refresh: tick };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
