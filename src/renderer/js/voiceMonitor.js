/**
 * Microphone side of proctoring: the voice sample at the camera check, then listening during
 * the exam. Audio is analysed on this laptop about 20 times a second (voiceAnalysis.js) and
 * never recorded or uploaded; only the measurements go into a warning.
 *
 * Lip movement comes from the camera (ProctorClient.lipState). The voice sample also measures
 * how much this student's lips move when they talk, so "lips still" is judged against them.
 */
(function () {
  'use strict';

  const TICK_MS = 50;

  const VoiceMonitor = {
    // Master switch. Off for now: too many false alarms in noisy rooms (e.g. a hackathon
    // hall). When false the microphone is never opened, the voice sample step and the
    // console's "Listen for other voices" setting are hidden. Set to true to bring it back.
    enabled: false,

    stream: null,
    audioCtx: null,
    analyser: null,
    buffer: null,
    timer: null,
    detector: null,
    baseline: null,
    lipThreshold: null,
    lastSpeechAt: 0,
    running: false,

    /** Opens the microphone (once). Returns true when it's available. */
    async open() {
      if (this.stream && this.stream.active && this.analyser) {
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
        return true;
      }
      try {
        // Echo cancellation stops the laptop hearing its own speakers; noise suppression stays
        // off so quiet speech and whispering are still audible.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
        });
      } catch (err) {
        console.warn('[VoiceMonitor] Microphone unavailable:', err.message);
        return false;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
      return true;
    },

    readFrame() {
      this.analyser.getFloatTimeDomainData(this.buffer);
      return window.VoiceAnalysis.analyzeFrame(this.buffer, this.audioCtx.sampleRate);
    },

    lipState() {
      return window.ProctorClient && typeof window.ProctorClient.lipState === 'function'
        ? window.ProctorClient.lipState()
        : { faceCount: null, range: null };
    },

    /**
     * Records the voice sample: the student reads a sentence aloud for `seconds`.
     * onLevel(0..1, progress 0..1) drives the meter. Resolves to the baseline ({ ok, reason }).
     */
    async enroll(seconds = 5, onLevel) {
      if (!(await this.open())) {
        return { ok: false, reason: "The microphone isn't available. Allow microphone access for Trinetra and check that one is connected." };
      }
      const frames = [];
      const started = performance.now();
      await new Promise((resolve) => {
        const tick = setInterval(() => {
          const feat = this.readFrame();
          frames.push({ ...feat, lipRange: this.lipState().range });
          const progress = Math.min(1, (performance.now() - started) / (seconds * 1000));
          if (typeof onLevel === 'function') onLevel(Math.max(0, Math.min(1, (feat.db + 60) / 50)), progress);
          if (progress >= 1) {
            clearInterval(tick);
            resolve();
          }
        }, TICK_MS);
      });
      const baseline = window.VoiceAnalysis.buildBaseline(frames);
      if (baseline.ok) {
        this.baseline = baseline;
        // Lips count as "moving" above 40% of how much they moved while reading the sentence.
        // If the camera couldn't follow the lips during the sample, only pitch is used.
        this.lipThreshold = baseline.talkingLipRange && baseline.talkingLipRange > 0.04
          ? Math.min(0.08, Math.max(0.025, baseline.talkingLipRange * 0.4))
          : null;
      }
      return baseline;
    },

    /** Starts listening for the exam. */
    async start({ strictness = 'standard' } = {}) {
      this.stop(false);
      if (!(await this.open())) {
        this.logActivity('MICROPHONE_UNAVAILABLE', { message: 'The microphone could not be opened; voices are not being monitored' });
        return false;
      }
      this.detector = new window.VoiceAnalysis.VoiceDetector({ strictness, baseline: this.baseline });
      this.running = true;
      this.stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          if (!this.running) return;
          window.ProctorClient && window.ProctorClient.reportViolation({ type: 'MICROPHONE_DISCONNECTED', details: { label: track.label } }, 'The microphone was disconnected');
        };
      });
      this.timer = setInterval(() => this.tick(), TICK_MS);
      return true;
    },

    tick() {
      if (!this.running || !this.analyser) return;
      const now = performance.now();
      const feat = this.readFrame();
      const lips = this.lipState();
      const lipsMoving = lips.range === null || this.lipThreshold === null ? null : lips.range >= this.lipThreshold;
      if (feat.pitch && feat.db > (this.detector.noiseDb ?? -75) + 12) this.lastSpeechAt = Date.now();

      const event = this.detector.push(feat, { t: now, faceCount: lips.faceCount, lipsMoving });
      if (!event) return;
      const pc = window.ProctorClient;
      if (!pc || !pc.canReport(event.type, Date.now())) return;
      pc.reportViolation({
        type: event.type,
        // The camera frame at that moment shows whether the student's lips were moving
        snapshot: typeof pc.snapshot === 'function' ? pc.snapshot(320, 240, 0.7) : null,
        details: { ...event.details, lipCheck: this.lipThreshold !== null }
      });
    },

    /** Mic state for the status bar: 'off' | 'listening' | 'speech'. */
    state() {
      if (!this.running || !this.stream || !this.stream.active) return 'off';
      return Date.now() - this.lastSpeechAt < 1500 ? 'speech' : 'listening';
    },

    logActivity(type, details) {
      const state = window.AppState || {};
      if (!state.sessionId || !window.api) return;
      window.api.post('/api/proctor/input-activity', { sessionId: state.sessionId, type, data: details }).catch(() => {});
    },

    /** Stops listening; `release` also closes the microphone. */
    stop(release = true) {
      this.running = false;
      clearInterval(this.timer);
      this.timer = null;
      if (release && this.stream) {
        this.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
        this.stream = null;
        this.analyser = null;
        if (this.audioCtx) this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
    }
  };

  window.VoiceMonitor = VoiceMonitor;
})();
