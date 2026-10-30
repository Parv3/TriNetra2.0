/**
 * Integrity Monitor
 * Main-process anti-cheat checks that a web page cannot perform on its own:
 *  - extra / mirrored displays (HDMI, Miracast, projector)
 *  - remote-desktop, screen-sharing and screen-recording software
 *  - virtual machine guests
 *  - the exam window losing OS focus (Alt+Tab, Win key, other apps)
 *  - DevTools / view-source / print shortcuts
 * and turns on OS-level capture protection so screen-share tools see a black window.
 *
 * Findings are posted to the backend as violations (strike-bearing) or input
 * activity (logged only), and pushed to the renderer for an on-screen warning.
 */

const { execFile } = require('node:child_process');
const os = require('node:os');

// Process image names (lower-case, without extension) grouped by what they imply.
const WATCHLIST = {
  REMOTE_ACCESS: [
    'anydesk', 'teamviewer', 'teamviewer_service', 'rustdesk', 'parsecd', 'chrome_remote_desktop_host',
    'remoting_host', 'mstsc', 'vncviewer', 'vncserver', 'winvnc', 'tvnserver', 'ultraviewer',
    'supremo', 'splashtopstreamer', 'logmein', 'ammyy_admin', 'zohoassist', 'getscreen'
  ],
  SCREEN_CAPTURE: [
    'obs64', 'obs32', 'obs', 'streamlabs obs', 'xsplit.core', 'bandicam', 'camtasia', 'sharex',
    'screenrec', 'loom', 'snagit32', 'snagiteditor', 'fraps'
  ],
  VIRTUAL_MACHINE: [
    'vmtoolsd', 'vmwaretray', 'vmwareuser', 'vboxservice', 'vboxtray', 'prl_tools', 'qemu-ga', 'xenservice'
  ]
};

const PROCESS_SCAN_INTERVAL_MS = 20000;
const BLUR_GRACE_MS = 1500;

class IntegrityMonitor {
  constructor({ backendPort, backendUrl, fetchFn, screen, platform = process.platform, exec = execFile } = {}) {
    this.backendUrl = backendUrl || `http://127.0.0.1:${backendPort}`;
    this.fetchFn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    this.screen = screen || null;
    this.platform = platform;
    this.exec = exec;

    this.mainWindow = null;
    this.sessionId = null;
    this.active = false;
    this.scanTimer = null;
    this.blurTimer = null;
    this.blurStartedAt = 0;
    this.reported = new Set(); // one strike per distinct finding per session
    this.displayListeners = [];
  }

  attachWindow(win) {
    this.mainWindow = win;
    if (!win || typeof win.on !== 'function') return;

    win.on('blur', () => this.onWindowBlur());
    win.on('focus', () => this.onWindowFocus());
    win.on('leave-full-screen', () => {
      if (this.active) this.report('FULLSCREEN_EXITED', { message: 'Exam window left full-screen mode' }, { strike: false });
    });
  }

  /** Blocks DevTools / view-source / print in a webContents (host window and guest tabs). */
  guardWebContents(webContents) {
    if (!webContents || typeof webContents.on !== 'function') return;
    webContents.on('before-input-event', (event, input) => {
      if (!this.active || input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      const ctrl = input.control || input.meta;
      const blocked =
        key === 'f12' ||
        (ctrl && input.shift && ['i', 'j', 'c'].includes(key)) ||
        (ctrl && ['u', 'p', 's'].includes(key));
      if (blocked) {
        event.preventDefault();
        this.logActivity('KEYSTROKE', { combo: describeCombo(input), blocked: true, suspicious: true });
      }
    });
    webContents.on('devtools-opened', () => {
      if (!this.active) return;
      webContents.closeDevTools();
      this.report('DEVTOOLS_OPENED', { message: 'Developer tools were opened during the exam' });
    });
  }

  start(sessionId) {
    this.sessionId = sessionId;
    this.active = true;
    this.reported.clear();

    const win = this.mainWindow;
    if (win && !win.isDestroyed()) {
      if (typeof win.setContentProtection === 'function') win.setContentProtection(true);
      if (typeof win.setFullScreen === 'function') win.setFullScreen(true);
    }

    this.checkDisplays();
    this.bindDisplayEvents();
    this.scanEnvironment();
    this.scanTimer = setInterval(() => this.scanProcesses(), PROCESS_SCAN_INTERVAL_MS);
    if (this.scanTimer.unref) this.scanTimer.unref();
  }

  stop() {
    this.active = false;
    clearInterval(this.scanTimer);
    clearTimeout(this.blurTimer);
    this.scanTimer = null;
    this.unbindDisplayEvents();

    const win = this.mainWindow;
    if (win && !win.isDestroyed()) {
      if (typeof win.setContentProtection === 'function') win.setContentProtection(false);
      if (typeof win.isFullScreen === 'function' && win.isFullScreen()) win.setFullScreen(false);
    }
  }

  // ── Displays ──────────────────────────────────────────────────

  bindDisplayEvents() {
    if (!this.screen || typeof this.screen.on !== 'function') return;
    const onChange = () => this.checkDisplays();
    ['display-added', 'display-removed'].forEach(evt => {
      this.screen.on(evt, onChange);
      this.displayListeners.push([evt, onChange]);
    });
  }

  unbindDisplayEvents() {
    if (!this.screen) return;
    this.displayListeners.forEach(([evt, fn]) => this.screen.removeListener(evt, fn));
    this.displayListeners = [];
  }

  checkDisplays() {
    if (!this.active || !this.screen || typeof this.screen.getAllDisplays !== 'function') return;
    const displays = this.screen.getAllDisplays();
    if (displays.length > 1) {
      this.report('MULTIPLE_DISPLAYS', {
        message: `${displays.length} displays connected — external or mirrored screens are not allowed`,
        details: { count: displays.length, displays: displays.map(d => `${d.size.width}x${d.size.height}${d.internal ? ' (internal)' : ''}`) }
      }, { key: `MULTIPLE_DISPLAYS:${displays.length}` });
    }
  }

  // ── Processes & environment ───────────────────────────────────

  scanEnvironment() {
    const hints = [os.cpus()[0] && os.cpus()[0].model, os.hostname()].join(' ').toLowerCase();
    if (/virtualbox|vmware|qemu|hyper-v|kvm|parallels/.test(hints)) {
      this.report('VIRTUAL_MACHINE', { message: 'The exam appears to be running inside a virtual machine', details: { hints } });
    }
    this.scanProcesses();
  }

  scanProcesses() {
    if (!this.active) return;
    this.listProcesses().then(names => {
      if (!this.active) return;
      const running = new Set(names);
      for (const [category, list] of Object.entries(WATCHLIST)) {
        const hits = list.filter(name => running.has(name));
        if (hits.length === 0) continue;
        const type = category === 'VIRTUAL_MACHINE' ? 'VIRTUAL_MACHINE'
          : category === 'REMOTE_ACCESS' ? 'REMOTE_ACCESS_SOFTWARE' : 'SCREEN_CAPTURE_SOFTWARE';
        this.report(type, {
          message: `${labelFor(type)} running: ${hits.join(', ')}`,
          details: { processes: hits }
        }, { key: `${type}:${hits.sort().join(',')}` });
      }
    }).catch(() => {});
  }

  listProcesses() {
    return new Promise((resolve) => {
      const isWin = this.platform === 'win32';
      const cmd = isWin ? 'tasklist' : 'ps';
      const args = isWin ? ['/fo', 'csv', '/nh'] : ['-axco', 'comm'];
      this.exec(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const names = String(stdout).split(/\r?\n/).map(line => {
          const raw = isWin ? (line.split('","')[0] || '').replace(/^"/, '') : line.trim();
          return raw.toLowerCase().replace(/\.exe$/, '').trim();
        }).filter(Boolean);
        resolve(names);
      });
    });
  }

  // ── Focus ─────────────────────────────────────────────────────

  onWindowBlur() {
    if (!this.active) return;
    this.blurStartedAt = Date.now();
    clearTimeout(this.blurTimer);
    // Short blurs happen when native dialogs or the OS volume flyout appear; only
    // count focus that stays away for longer than the grace period.
    this.blurTimer = setTimeout(() => {
      if (!this.active) return;
      this.report('WINDOW_FOCUS_LOST', { message: 'Exam window lost focus — another application was brought to the front' },
        { key: `WINDOW_FOCUS_LOST:${this.blurStartedAt}` });
    }, BLUR_GRACE_MS);
  }

  onWindowFocus() {
    clearTimeout(this.blurTimer);
    if (!this.active || !this.blurStartedAt) return;
    const awayMs = Date.now() - this.blurStartedAt;
    this.blurStartedAt = 0;
    if (awayMs >= BLUR_GRACE_MS) {
      this.logActivity('FOCUS_RETURNED', { awayMs });
    }
  }

  // ── Reporting ─────────────────────────────────────────────────

  async report(type, { message, details = {} } = {}, { key = type, strike = true } = {}) {
    if (!this.active || !this.sessionId || this.reported.has(key)) return;
    this.reported.add(key);

    if (!strike) {
      this.logActivity(type, { message, ...details });
      this.notifyRenderer('proctor:warning', { type, message, strikeCount: null, informational: true });
      return;
    }

    let result = null;
    try {
      const res = await this.fetchFn(`${this.backendUrl}/api/proctor/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, type, message, details: { ...details, source: 'desktop-shell' } })
      });
      result = await res.json();
    } catch (_) {}

    if (result && result.action === 'DISQUALIFY') {
      this.notifyRenderer('proctor:disqualify', result.reason || message);
      this.stop();
    } else {
      this.notifyRenderer('proctor:warning', { type, message, strikeCount: result ? result.strikeCount : null });
    }
  }

  async logActivity(type, data) {
    if (!this.sessionId || !this.fetchFn) return;
    try {
      await this.fetchFn(`${this.backendUrl}/api/proctor/input-activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, type, data: { ...data, source: 'desktop-shell' } })
      });
    } catch (_) {}
  }

  notifyRenderer(channel, payload) {
    const win = this.mainWindow;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send(channel, payload);
    }
  }
}

function labelFor(type) {
  return {
    REMOTE_ACCESS_SOFTWARE: 'Remote-access software',
    SCREEN_CAPTURE_SOFTWARE: 'Screen-recording software',
    VIRTUAL_MACHINE: 'Virtual machine tooling'
  }[type] || type;
}

function describeCombo(input) {
  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.meta) parts.push('Meta');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  parts.push(input.key);
  return parts.join('+');
}

module.exports = { IntegrityMonitor, WATCHLIST };
