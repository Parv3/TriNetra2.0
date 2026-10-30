/**
 * ProctorClient — webcam proctoring
 *
 * Per frame (≈10 fps): face count, 68-point landmarks, head yaw/pitch, pupil position, eye openness.
 * Accuracy measures:
 *  - Readings are compared against the candidate's own reference pose captured at the
 *    camera check, not fixed absolute thresholds (laptop cameras sit at very different angles).
 *  - A condition must persist for a per-type duration before it counts; brief dropouts
 *    (blinks, a missed detection) under 700 ms do not reset the clock.
 *  - Each violation type has a cooldown, so one long look away is one warning, not five.
 *  - Every few seconds the face is matched against the reference descriptor to catch a
 *    different person sitting in.
 */
(function () {
  'use strict';

  // Per-exam strictness (exam rule `strictness`). A condition must last `sustain` ms and
  // show in `majority` of frames in that window; gaps over `dropout` ms reset it; the same
  // kind of warning can't repeat within `cooldown` ms, but a candidate who stays away keeps
  // collecting warnings after each cooldown.
  const PROFILES = {
    relaxed: {
      sustain: { NO_FACE: 4000, MULTIPLE_FACES: 2000, GAZE_DIVERSION: 6000, LOOKING_DOWN: 7000, PHONE_DETECTED: 2500 },
      cooldown: 30000, dropout: 1200, majority: 0.7,
      limits: { yaw: 30, pitch: 0.15, eyesH: 0.24, eyesV: 0.26 }
    },
    standard: {
      sustain: { NO_FACE: 3000, MULTIPLE_FACES: 1500, GAZE_DIVERSION: 3500, LOOKING_DOWN: 4500, PHONE_DETECTED: 2000 },
      cooldown: 15000, dropout: 900, majority: 0.65,
      limits: { yaw: 25, pitch: 0.13, eyesH: 0.2, eyesV: 0.22 }
    },
    strict: {
      sustain: { NO_FACE: 2000, MULTIPLE_FACES: 1000, GAZE_DIVERSION: 2500, LOOKING_DOWN: 3000, PHONE_DETECTED: 1500 },
      cooldown: 10000, dropout: 700, majority: 0.6,
      limits: { yaw: 22, pitch: 0.11, eyesH: 0.17, eyesV: 0.19 }
    }
  };
  const profile = () => PROFILES[(window.AppState && window.AppState.rules && window.AppState.rules.strictness) || 'standard'] || PROFILES.standard;
  const SMOOTHING = 0.35;         // EMA weight of the newest frame for pose/gaze readings
  const IDENTITY_INTERVAL_MS = 5000;
  const IDENTITY_THRESHOLD = 0.6;   // face-api euclidean distance; < 0.6 is the usual same-person cut-off
  const IDENTITY_STRIKES = 2;       // consecutive mismatches before reporting

  const DEFAULT_BASELINE = { yaw: 0, pitchRatio: 0.45, hgr: 0.5, vgr: 0.5 };

  const MESSAGES = {
    NO_FACE: 'Your face is not visible to the camera',
    MULTIPLE_FACES: 'More than one person is visible',
    GAZE_DIVERSION: 'You were looking away from the screen',
    LOOKING_DOWN: 'You were looking down, away from the screen',
    IDENTITY_MISMATCH: 'The person in front of the camera does not match the reference photo',
    PHONE_DETECTED: 'A phone is visible to the camera'
  };

  // Phone detection (COCO-SSD). Measured on webcam-sized frames, a phone held up to the camera
  // scores 0.9+, but one held normally in the hand scores 0.2–0.35, so the cut-off is low and
  // false alarms are controlled by persistence instead: the phone must appear in
  // PHONE_WINDOW_HITS of the last PHONE_WINDOW checks. This model often labels a phone in a
  // hand as "remote", so that class counts too at a higher score.
  //
  // The model looks at a 300 px square, where a phone held below the desk edge is only a few
  // dozen pixels. Each check therefore also runs on one zoomed crop, taking turns between the
  // lower middle of the frame (hands, lap) and the left and right sides; a phone found in a
  // crop is mapped back to full-frame coordinates.
  const PHONE_CHECK_MS = 800;
  const PHONE_CLASSES = { 'cell phone': 0.27, remote: 0.45 };
  const PHONE_WINDOW = 5;
  const PHONE_WINDOW_HITS = 2;
  const PHONE_CROPS = [
    [0.15, 0.4, 0.7, 0.6],   // lower middle: hands and lap
    [0, 0.15, 0.55, 0.85],   // left side
    [0.45, 0.15, 0.55, 0.85] // right side
  ];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.dataset.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(el);
    });
  }

  const detectorOptions = () => new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });

  const ProctorClient = {
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    FPS: 10,
    frameInterval: null,
    running: false,
    busy: false,
    tfLoaded: false,
    recognitionLoaded: false,
    loadingPromise: null,

    baseline: { ...DEFAULT_BASELINE },
    referenceDescriptor: null,
    calibrationSamples: [],

    pending: null,           // { type, since, lastSeen, reported }
    lastReportAt: {},
    lastIdentityCheck: 0,
    identityMisses: 0,

    calibInterval: null,
    calibVideo: null,
    calibCanvas: null,
    calibCtx: null,

    analysisCanvas: null,
    analysisCtx: null,

    getAnalysisContext(w, h) {
      if (!this.analysisCanvas) this.analysisCanvas = document.createElement('canvas');
      if (this.analysisCanvas.width !== w || this.analysisCanvas.height !== h) {
        this.analysisCanvas.width = w;
        this.analysisCanvas.height = h;
        this.analysisCtx = null;
      }
      if (!this.analysisCtx) this.analysisCtx = this.analysisCanvas.getContext('2d', { willReadFrequently: true });
      return this.analysisCtx;
    },

    // ── Model loading ────────────────────────────────────────────

    async preload() {
      if (this.tfLoaded) return true;
      if (this.loadingPromise) return this.loadingPromise;
      this.loadingPromise = (async () => {
        const faceapi = window.faceapi;
        if (!faceapi) return false;
        try {
          if (faceapi.tf) {
            try { await faceapi.tf.setBackend('webgl'); } catch (_) { await faceapi.tf.setBackend('cpu'); }
            await faceapi.tf.ready();
          }
          const base = `${(window.AppState && window.AppState.baseUrl) || 'http://127.0.0.1:4100'}/models`;
          await faceapi.nets.tinyFaceDetector.loadFromUri(base);
          await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
          this.tfLoaded = true;
          // The recognition net is ~6 MB; load it after detection is usable.
          faceapi.nets.faceRecognitionNet.loadFromUri(base)
            .then(() => { this.recognitionLoaded = true; })
            .catch(err => console.warn('[ProctorClient] Face recognition model unavailable:', err.message));
          return true;
        } catch (err) {
          console.warn('[ProctorClient] Model load failed:', err.message || err);
          return false;
        }
      })();
      return this.loadingPromise;
    },

    /** Loads TensorFlow.js + COCO-SSD on demand; prefers the vendored weights, falls back to Google's CDN. */
    async loadObjectDetector() {
      if (this.objectDetector) return this.objectDetector;
      if (this.objectDetectorPromise) return this.objectDetectorPromise;
      this.objectDetectorPromise = (async () => {
        try {
          // face-api.js already bundles TensorFlow.js; reuse it rather than loading a second
          // copy (two copies share one engine and re-register every kernel).
          if (!window.tf && window.faceapi && window.faceapi.tf) window.tf = window.faceapi.tf;
          if (!window.tf) await loadScript('vendor/tf.min.js');
          await loadScript('vendor/coco-ssd.min.js');
          await window.tf.ready();
          const base = (window.AppState && window.AppState.baseUrl) || '';
          try {
            this.objectDetector = await window.cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: `${base}/models/coco-ssd/model.json` });
          } catch (_) {
            this.objectDetector = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
          }
          return this.objectDetector;
        } catch (err) {
          console.warn('[ProctorClient] Phone detection unavailable:', err.message);
          return null;
        }
      })();
      return this.objectDetectorPromise;
    },

    async checkForPhone() {
      const v = this.video;
      // Never overlap with face detection: COCO-SSD briefly switches the shared TF backend.
      if (!this.running || this.phoneBusy || this.busy || !v || v.readyState < 2) return;
      this.phoneBusy = true;
      try {
        const model = await this.loadObjectDetector();
        if (!model || !this.running) return;
        const isPhone = (d) => PHONE_CLASSES[d.class] !== undefined && d.score >= PHONE_CLASSES[d.class];
        const candidates = (await model.detect(v, 10, 0.2)).filter(isPhone);

        // One zoomed crop per check, taking turns
        const vw = v.videoWidth || 640;
        const vh = v.videoHeight || 480;
        this.phoneCropIdx = ((this.phoneCropIdx || 0) + 1) % PHONE_CROPS.length;
        const [cx, cy, cw, ch] = PHONE_CROPS[this.phoneCropIdx];
        const sx = cx * vw, sy = cy * vh, sw = cw * vw, sh = ch * vh;
        const canvas = this.phoneCanvas || (this.phoneCanvas = document.createElement('canvas'));
        const scale = Math.min(2, 480 / Math.max(sw, sh));
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);
        canvas.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        if (this.running) {
          (await model.detect(canvas, 10, 0.2)).filter(isPhone).forEach(d => {
            const [x, y, w, h] = d.bbox;
            candidates.push({ ...d, bbox: [sx + x / scale, sy + y / scale, w / scale, h / scale], crop: this.phoneCropIdx });
          });
        }
        const found = candidates.sort((a, b) => b.score - a.score)[0];
        this.phoneHistory = [...(this.phoneHistory || []), Boolean(found)].slice(-PHONE_WINDOW);
        if (found) this.lastPhone = { box: found.bbox, score: found.score, at: Date.now() };

        const hits = this.phoneHistory.filter(Boolean).length;
        if (found && hits >= PHONE_WINDOW_HITS && this.canReport('PHONE_DETECTED', Date.now())) {
          this.phoneHistory = [];
          this.reportViolation({
            type: 'PHONE_DETECTED',
            snapshot: this.snapshot(320, 240, 0.75, this.lastPhone),
            details: { label: found.class, score: Math.round(found.score * 100) / 100, box: found.bbox.map(Math.round), zoomed: found.crop !== undefined }
          });
        }
      } catch (_) {
        // detection is best-effort; never break the exam
      } finally {
        this.phoneBusy = false;
      }
    },

    async detect(source, withDescriptor = false) {
      let task = window.faceapi.detectAllFaces(source, detectorOptions()).withFaceLandmarks(true);
      if (withDescriptor && this.recognitionLoaded) task = task.withFaceDescriptors();
      return task;
    },

    // ── Measurements ─────────────────────────────────────────────

    estimatePupil(ctx, eye) {
      const xs = eye.map(p => p.x);
      const ys = eye.map(p => p.y);
      const minX = Math.floor(Math.min(...xs));
      const minY = Math.floor(Math.min(...ys));
      const w = Math.max(2, Math.ceil(Math.max(...xs)) - minX);
      const h = Math.max(2, Math.ceil(Math.max(...ys)) - minY);
      const centre = { x: minX + w / 2, y: minY + h / 2, ratioH: 0.5, ratioV: 0.5 };
      try {
        const data = ctx.getImageData(minX, minY, w, h).data;
        let minLum = 255;
        for (let i = 0; i < data.length; i += 4) {
          const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          if (lum < minLum) minLum = lum;
        }
        // Weighted centroid of the darkest pixels ≈ iris/pupil.
        const threshold = minLum + 28;
        let sx = 0, sy = 0, total = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            if (lum <= threshold) {
              const wt = threshold - lum + 1;
              sx += x * wt; sy += y * wt; total += wt;
            }
          }
        }
        if (!total) return centre;
        const px = minX + sx / total;
        const py = minY + sy / total;
        return {
          x: px, y: py,
          ratioH: Math.max(0.05, Math.min(0.95, (px - minX) / w)),
          ratioV: Math.max(0.05, Math.min(0.95, (py - minY) / h))
        };
      } catch (_) {
        return centre;
      }
    },

    faceBrightness(ctx, box) {
      try {
        const x = Math.max(0, Math.floor(box.x + box.width * 0.25));
        const y = Math.max(0, Math.floor(box.y + box.height * 0.25));
        const w = Math.max(1, Math.floor(box.width * 0.5));
        const h = Math.max(1, Math.floor(box.height * 0.5));
        const data = ctx.getImageData(x, y, w, h).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 16) sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        return Math.round(sum / (data.length / 16));
      } catch (_) {
        return 128;
      }
    },

    computeMetrics(detections, ctx, baseline = this.baseline) {
      const faceCount = detections.length;
      if (faceCount !== 1) {
        return {
          faceCount,
          instantViolation: faceCount === 0 ? 'NO_FACE' : 'MULTIPLE_FACES',
          gazeText: faceCount === 0 ? 'No face' : `${faceCount} faces`,
          yaw: 0, pitch: 0, hgr: 0.5, vgr: 0.5, ear: 0, brightness: 0,
          detection: faceCount > 1 ? detections[0] : null
        };
      }

      const detection = detections[0];
      const lm = detection.landmarks;
      const nose = lm.getNose();
      const leftEye = lm.getLeftEye();
      const rightEye = lm.getRightEye();
      const jaw = lm.getJawOutline();

      const lp = this.estimatePupil(ctx, leftEye);
      const rp = this.estimatePupil(ctx, rightEye);
      let hgr = (lp.ratioH + rp.ratioH) / 2;
      let vgr = (lp.ratioV + rp.ratioV) / 2;

      const earOf = (e) => ((Math.abs(e[1].y - e[5].y) + Math.abs(e[2].y - e[4].y)) / 2) / (Math.abs(e[0].x - e[3].x) || 1);
      const ear = (earOf(leftEye) + earOf(rightEye)) / 2;

      const eyeMidX = (leftEye[0].x + rightEye[3].x) / 2;
      const eyeMidY = (leftEye[0].y + rightEye[3].y) / 2;
      const interEye = Math.abs(rightEye[3].x - leftEye[0].x) || 1;
      const noseTip = nose[3] || nose[0];
      const chin = jaw[8] || jaw[Math.floor(jaw.length / 2)];
      const faceHeight = Math.abs(chin.y - eyeMidY) || 1;
      let yaw = ((noseTip.x - eyeMidX) / (interEye * 0.5)) * 45;
      let pitchRatio = (noseTip.y - eyeMidY) / faceHeight;
      const blinking = ear < 0.17;

      // During the exam, smooth frame-to-frame jitter (landmark noise, pupil estimate on dark frames).
      if (this.running) {
        const prev = this.ema;
        const mix = (key, value) => (prev && !blinking ? prev[key] + SMOOTHING * (value - prev[key]) : value);
        yaw = mix('yaw', yaw);
        pitchRatio = mix('pitchRatio', pitchRatio);
        hgr = mix('hgr', hgr);
        vgr = mix('vgr', vgr);
        this.ema = { yaw, pitchRatio, hgr, vgr };
      }

      const b = baseline;
      let instantViolation = null;
      let gazeText = 'On screen';

      if (Math.abs(yaw - b.yaw) > profile().limits.yaw) {
        instantViolation = 'GAZE_DIVERSION';
        gazeText = 'Head turned';
      } else if (pitchRatio - b.pitchRatio > profile().limits.pitch) {
        instantViolation = 'LOOKING_DOWN';
        gazeText = 'Looking down';
      } else if (!blinking && Math.abs(hgr - b.hgr) > profile().limits.eyesH) {
        instantViolation = 'GAZE_DIVERSION';
        gazeText = 'Eyes off screen';
      } else if (!blinking && vgr - b.vgr > profile().limits.eyesV) {
        instantViolation = 'LOOKING_DOWN';
        gazeText = 'Looking down';
      }

      return {
        faceCount: 1,
        instantViolation,
        gazeText,
        blinking,
        yaw: Math.round(yaw),
        pitch: Math.round((pitchRatio - b.pitchRatio) * 100),
        pitchRatio,
        hgr: Math.round(hgr * 100) / 100,
        vgr: Math.round(vgr * 100) / 100,
        ear: Math.round(ear * 100) / 100,
        brightness: this.faceBrightness(ctx, detection.detection.box),
        leftPupil: lp,
        rightPupil: rp,
        detection
      };
    },

    // ── Overlay ──────────────────────────────────────────────────

    drawOverlay(canvas, ctx, detections, metrics, w, h) {
      if (!canvas || !ctx) return;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      if (metrics.faceCount === 0 && !(this.lastPhone && Date.now() - this.lastPhone.at < 1500)) return;

      const tone = metrics.faceCount > 1 ? '#e0574b' : metrics.instantViolation ? '#e0a03a' : 'rgba(255,255,255,0.85)';
      detections.forEach(d => {
        const bx = d.detection.box;
        const c = Math.min(bx.width, bx.height) * 0.18;
        ctx.strokeStyle = tone;
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Corner brackets rather than a full rectangle — less visually noisy.
        [[bx.x, bx.y, 1, 1], [bx.x + bx.width, bx.y, -1, 1], [bx.x, bx.y + bx.height, 1, -1], [bx.x + bx.width, bx.y + bx.height, -1, -1]]
          .forEach(([x, y, dx, dy]) => { ctx.moveTo(x + c * dx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + c * dy); });
        ctx.stroke();
      });

      const phone = this.lastPhone;
      if (phone && Date.now() - phone.at < 1500) {
        const [x, y, bw, bh] = phone.box;
        ctx.strokeStyle = '#e0574b';
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, bw, bh);
      }

      if (metrics.faceCount === 1 && metrics.leftPupil) {
        ctx.fillStyle = tone;
        [metrics.leftPupil, metrics.rightPupil].forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    },

    // ── Camera check (sign-in) ───────────────────────────────────

    startCalibration(videoEl, canvasEl, onFrame) {
      this.stopCalibration();
      this.calibVideo = videoEl;
      this.calibCanvas = canvasEl;
      this.calibCtx = canvasEl ? canvasEl.getContext('2d') : null;
      this.calibrationSamples = [];
      this.preload();

      this.calibInterval = setInterval(async () => {
        const v = this.calibVideo;
        if (!v || v.paused || v.readyState < 2 || !this.tfLoaded || this.busy) return;
        this.busy = true;
        try {
          const w = v.videoWidth || 640;
          const h = v.videoHeight || 480;
          const aCtx = this.getAnalysisContext(w, h);
          aCtx.drawImage(v, 0, 0, w, h);
          const detections = await this.detect(v);
          // Judge against a neutral default pose while the candidate's own reference is being collected.
          const m = this.computeMetrics(detections, aCtx, DEFAULT_BASELINE);
          this.drawOverlay(this.calibCanvas, this.calibCtx, detections, m, w, h);
          if (m.faceCount === 1 && !m.blinking) {
            this.calibrationSamples.push({ yaw: m.yaw, pitchRatio: m.pitchRatio, hgr: m.hgr, vgr: m.vgr });
            if (this.calibrationSamples.length > 30) this.calibrationSamples.shift();
          }
          if (typeof onFrame === 'function') onFrame(m);
        } catch (_) {
        } finally {
          this.busy = false;
        }
      }, 150);
    },

    /**
     * Called when the candidate takes the reference photo. Validates the frame, stores the
     * neutral pose (median of recent samples) and the face descriptor for identity checks.
     */
    async captureReference(videoEl) {
      if (!this.tfLoaded) {
        await this.preload();
        if (!this.tfLoaded) return { ok: true, descriptor: null };  // models unavailable: don't block the exam
      }
      const w = videoEl.videoWidth || 640;
      const h = videoEl.videoHeight || 480;
      const aCtx = this.getAnalysisContext(w, h);
      aCtx.drawImage(videoEl, 0, 0, w, h);
      const detections = await this.detect(videoEl, true);
      if (detections.length === 0) return { ok: false, reason: 'No face found. Look at the camera and try again.' };
      if (detections.length > 1) return { ok: false, reason: 'More than one face is visible. Make sure you are alone.' };
      const brightness = this.faceBrightness(aCtx, detections[0].detection.box);
      if (brightness < 45) return { ok: false, reason: 'Your face is too dark to recognise. Add light in front of you and try again.' };

      if (this.calibrationSamples.length >= 5) {
        const median = (key) => {
          const vals = this.calibrationSamples.map(s => s[key]).sort((a, b) => a - b);
          return vals[Math.floor(vals.length / 2)];
        };
        const candidate = { yaw: median('yaw'), pitchRatio: median('pitchRatio'), hgr: median('hgr'), vgr: median('vgr') };
        // Ignore an implausible reference (e.g. candidate turned away while calibrating).
        if (Math.abs(candidate.yaw) < 30 && Math.abs(candidate.hgr - 0.5) < 0.2) this.baseline = candidate;
      }

      const d = detections[0].descriptor;
      this.referenceDescriptor = d ? Array.from(d) : null;
      return { ok: true, descriptor: this.referenceDescriptor, confidence: detections[0].detection.score };
    },

    stopCalibration() {
      clearInterval(this.calibInterval);
      this.calibInterval = null;
      this.calibVideo = null;
      this.calibCanvas = null;
      this.calibCtx = null;
    },

    // ── Exam-time monitoring ─────────────────────────────────────

    async init(existingStream = null) {
      this.video = document.getElementById('webcam-feed');
      this.canvas = document.getElementById('webcam-canvas');
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.stopCalibration();
      this.preload();
      this.loadObjectDetector(); // warm up now; the first load takes several seconds
      this.pending = null;
      this.ema = null;
      this.lastReportAt = {};
      this.identityMisses = 0;

      if (existingStream && existingStream.active) {
        this.stream = existingStream;
      } else {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        } catch (err) {
          console.warn('[ProctorClient] Camera unavailable:', err.message);
          this.reportViolation({ type: 'NO_FACE', details: { reason: 'camera-unavailable' } });
          return;
        }
      }
      // If the camera is unplugged or disabled mid-exam the track ends.
      this.stream.getVideoTracks().forEach(track => {
        track.onended = () => {
          if (this.running) this.reportViolation({ type: 'CAMERA_DISCONNECTED', details: { label: track.label } }, 'The camera was disconnected');
        };
      });

      this.video.srcObject = this.stream;
      this.video.play().catch(() => {});
      document.getElementById('webcam-overlay')?.classList.remove('hidden');
      this.running = true;
      clearInterval(this.frameInterval);
      this.frameInterval = setInterval(() => this.processFrame(), 1000 / this.FPS);
      clearInterval(this.thumbInterval);
      this.thumbInterval = setInterval(() => this.streamToProctor(), 1000);
      clearInterval(this.phoneInterval);
      this.phoneHistory = [];
      this.phoneInterval = setInterval(() => this.checkForPhone(), PHONE_CHECK_MS);
    },

    async processFrame() {
      const v = this.video;
      if (!this.running || this.busy || this.phoneBusy || !v || v.paused || v.readyState < 2) return;
      this.busy = true;
      const now = Date.now();
      try {
        const w = v.videoWidth || 640;
        const h = v.videoHeight || 480;
        const aCtx = this.getAnalysisContext(w, h);
        aCtx.drawImage(v, 0, 0, w, h);

        let metrics;
        let detections = [];
        if (this.tfLoaded) {
          const wantId = this.referenceDescriptor && this.recognitionLoaded && now - this.lastIdentityCheck >= IDENTITY_INTERVAL_MS;
          detections = await this.detect(v, wantId);
          metrics = this.computeMetrics(detections, aCtx);
          if (wantId && detections.length === 1 && detections[0].descriptor) {
            this.lastIdentityCheck = now;
            this.checkIdentity(detections[0].descriptor, aCtx);
          }
        } else {
          // Models still loading: only a coarse "camera covered / dark" check.
          const data = aCtx.getImageData(0, 0, w, h).data;
          let sum = 0;
          for (let i = 0; i < data.length; i += 64) sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const covered = sum / (data.length / 64) < 15;
          metrics = { faceCount: covered ? 0 : 1, instantViolation: covered ? 'NO_FACE' : null, gazeText: covered ? 'No face' : 'On screen', yaw: 0, pitch: 0 };
        }

        this.drawOverlay(this.canvas, this.ctx, detections, metrics, w, h);
        this.updateHud(metrics);

        const sustained = this.updateHysteresis(metrics.instantViolation, now);
        if (sustained) {
          this.reportViolation({
            type: sustained,
            snapshot: this.snapshot(320, 240, 0.7),
            details: { faceCount: metrics.faceCount, yaw: metrics.yaw, pitch: metrics.pitch, hgr: metrics.hgr, gaze: metrics.gazeText, sustainedMs: profile().sustain[sustained] }
          });
        }

        this.lastMetrics = metrics;
      } catch (_) {
        // keep the loop alive
      } finally {
        this.busy = false;
      }
    },

    checkIdentity(descriptor) {
      const ref = this.referenceDescriptor;
      let sum = 0;
      for (let i = 0; i < ref.length; i++) sum += (ref[i] - descriptor[i]) ** 2;
      const distance = Math.sqrt(sum);
      if (distance <= IDENTITY_THRESHOLD) {
        this.identityMisses = 0;
        return;
      }
      this.identityMisses++;
      if (this.identityMisses >= IDENTITY_STRIKES && this.canReport('IDENTITY_MISMATCH', Date.now())) {
        this.identityMisses = 0;
        this.reportViolation({
          type: 'IDENTITY_MISMATCH',
          snapshot: this.snapshot(320, 240, 0.7),
          details: { distance: Math.round(distance * 100) / 100, threshold: IDENTITY_THRESHOLD }
        });
      }
    },

    /**
     * Returns a violation type once it has persisted long enough; null otherwise.
     * Thresholds come from the exam's strictness profile (see PROFILES).
     */
    updateHysteresis(violation, now) {
      const cfg = profile();
      const p = this.pending;
      if (p) p.frames++;
      if (!violation) {
        if (p && now - p.lastSeen > cfg.dropout) this.pending = null;
        return null;
      }
      // Head-turn and eyes-off readings are the same behaviour; switching between them continues the clock.
      if (!p || (p.type !== violation && !(isGaze(p.type) && isGaze(violation)))) {
        this.pending = { type: violation, since: now, lastSeen: now, hits: 1, frames: 1, reported: false };
        return null;
      }
      p.type = violation;
      p.lastSeen = now;
      p.hits++;
      // Still away after the cooldown: start a fresh window so it can warn again.
      if (p.reported && now - p.reportedAt >= cfg.cooldown) {
        Object.assign(p, { since: now, hits: 1, frames: 1, reported: false });
      }
      const longEnough = now - p.since >= (cfg.sustain[violation] || 4000);
      if (!p.reported && longEnough && p.hits / p.frames >= cfg.majority && this.canReport(violation, now)) {
        p.reported = true;
        p.reportedAt = now;
        return violation;
      }
      return null;
    },

    canReport(type, now) {
      const key = isGaze(type) ? 'GAZE' : type;
      if (now - (this.lastReportAt[key] || 0) < profile().cooldown) return false;
      this.lastReportAt[key] = now;
      return true;
    },

    snapshot(w, h, quality, mark) {
      try {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.drawImage(this.video, 0, 0, w, h);
        if (mark && mark.box) {
          const sx = w / (this.video.videoWidth || w);
          const sy = h / (this.video.videoHeight || h);
          g.strokeStyle = '#e0574b';
          g.lineWidth = 3;
          g.strokeRect(mark.box[0] * sx, mark.box[1] * sy, mark.box[2] * sx, mark.box[3] * sy);
        }
        return c.toDataURL('image/jpeg', quality);
      } catch (_) {
        return null;
      }
    },

    /**
     * Grid thumbnail for the proctor console, once a second on its own timer (not tied to
     * face detection speed). Skipped while the socket still has unsent data, so a slow link
     * shows the latest frame instead of an ever-growing backlog. Live video for the
     * inspected candidate goes over WebRTC (LiveStream).
     */
    streamToProctor() {
      const ws = window.studentSocket;
      const metrics = this.lastMetrics || { faceCount: 1, gazeText: 'On screen', yaw: 0, pitch: 0 };
      if (!this.running || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 32 * 1024) return;
      const now = Date.now();
      try {
        ws.send(JSON.stringify({
          type: 'WEBCAM_FRAME',
          sessionId: window.AppState?.sessionId,
          snapshot: this.snapshot(192, 144, 0.5),
          faceCount: metrics.faceCount,
          gaze: metrics.instantViolation ? metrics.gazeText : 'CENTER',
          headPose: { yaw: metrics.yaw, pitch: metrics.pitch },
          questionIdx: (window.AppState?.currentQuestionIdx || 0) + 1,
          questionTotal: window.AppState?.questions?.length || 0,
          timestamp: now
        }));
      } catch (_) {}
    },

    updateHud(m) {
      const facePill = document.getElementById('hud-face-status');
      const gazePill = document.getElementById('hud-gaze-status');
      const status = document.getElementById('ai-proctor-live-status');
      const statusText = document.getElementById('proctor-live-text');
      const ring = document.getElementById('webcam-status-ring');

      const phoneVisible = this.lastPhone && Date.now() - this.lastPhone.at < 2000;
      const faceTone = m.faceCount === 1 && !phoneVisible ? '' : 'danger';
      const gazeTone = m.faceCount !== 1 ? 'danger' : m.instantViolation ? 'warn' : '';
      if (facePill) {
        facePill.textContent = phoneVisible ? 'Phone in view' : m.faceCount === 1 ? '1 face' : m.faceCount === 0 ? 'No face' : `${m.faceCount} faces`;
        facePill.className = `readout ${faceTone}`;
      }
      if (gazePill) {
        gazePill.textContent = m.faceCount === 1 ? m.gazeText : '—';
        gazePill.className = `readout ${gazeTone}`;
      }

      const tone = faceTone || gazeTone;
      if (ring) ring.className = `camera-ring ${tone}`;
      if (status && statusText) {
        status.className = `proctor-status ${tone}`;
        statusText.textContent = phoneVisible ? 'Phone detected — put it away'
          : m.faceCount === 0 ? 'Face not visible'
          : m.faceCount > 1 ? 'More than one person in view'
          : m.instantViolation ? `${m.gazeText} — look back at the screen`
          : 'Monitoring active';
      }
    },

    async reportViolation(violation, messageOverride) {
      const state = window.AppState;
      if (!state.sessionId || state.submitted || state.disqualified) return;
      const type = violation.type || 'SUSPICIOUS_BEHAVIOR';
      const message = messageOverride || MESSAGES[type] || type.replace(/_/g, ' ').toLowerCase();

      try {
        const res = await window.api.post('/api/proctor/violation', {
          sessionId: state.sessionId,
          type,
          message,
          snapshot: violation.snapshot || null,
          details: violation.details || {}
        });
        state.strikes = res.strikeCount || state.strikes + 1;
        if (res.action === 'DISQUALIFY') {
          window.terminateAttempt(res.reason || 'The warning limit was reached.');
        } else {
          window.showWarning(message, state.strikes, state.maxStrikes);
        }
      } catch (err) {
        console.warn('Failed to record violation:', err);
      }
    },

    stop() {
      this.running = false;
      this.stopCalibration();
      clearInterval(this.frameInterval);
      clearInterval(this.thumbInterval);
      clearInterval(this.phoneInterval);
      this.frameInterval = null;
      this.thumbInterval = null;
      this.phoneInterval = null;
      window.LiveStream && window.LiveStream.stopAll();
      if (this.stream) {
        this.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
        this.stream = null;
      }
      document.getElementById('webcam-overlay')?.classList.add('hidden');
    }
  };

  function isGaze(type) {
    return type === 'GAZE_DIVERSION' || type === 'LOOKING_DOWN';
  }

  window.ProctorClient = ProctorClient;
})();
