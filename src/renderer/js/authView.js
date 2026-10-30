/**
 * AuthView — candidate sign-in
 * Consent → join (exam code, name, roll number) → create profile (first time only)
 * → one-time code → camera check & reference capture → exam.
 */
(function () {
  'use strict';

  let cameraStream = null;
  // Stepper position for each step (profile and code share "Verify identity").
  const STEP_INDEX = { consent: 0, id: 1, profile: 2, otp: 2, camera: 3 };
  const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatCode = (v) => { const c = cleanCode(v); return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3, 9)}` : c; };

  const AuthView = {
    exam: null,
    pendingProfile: null,

    init() {
      const $ = (id) => document.getElementById(id);

      $('btn-continue-to-auth')?.addEventListener('click', () => {
        if (!$('check-consent')?.checked) {
          this.showError($('auth-error-consent'), 'Please confirm that you have read the rules to continue.');
          return;
        }
        this.goToStep('id');
        $('input-exam-code')?.focus();
      });
      $('btn-back-to-consent')?.addEventListener('click', () => this.goToStep('consent'));

      const codeInput = $('input-exam-code');
      let lookupTimer = null;
      codeInput?.addEventListener('input', () => {
        const pos = codeInput.selectionStart;
        const before = codeInput.value.length;
        codeInput.value = formatCode(codeInput.value);
        codeInput.setSelectionRange(pos + (codeInput.value.length - before), pos + (codeInput.value.length - before));
        clearTimeout(lookupTimer);
        this.exam = null;
        $('selected-exam-meta').classList.add('hidden');
        if (cleanCode(codeInput.value).length >= 6) lookupTimer = setTimeout(() => this.lookupExam(true), 250);
      });

      $('btn-request-otp')?.addEventListener('click', () => this.join());
      ['input-exam-code', 'input-student-name', 'input-student-id'].forEach(id => {
        $(id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
      });

      $('btn-create-profile')?.addEventListener('click', () => this.createProfile());
      $('btn-back-from-profile')?.addEventListener('click', () => this.goToStep('id'));

      $('btn-verify-otp')?.addEventListener('click', () => this.verifyOtp());
      $('btn-back-to-id')?.addEventListener('click', () => this.goToStep('id'));
      this.bindOtpInputs();

      $('btn-capture-face')?.addEventListener('click', () => this.captureFace());
    },

    bindOtpInputs() {
      const all = Array.from(document.querySelectorAll('.otp-digit'));
      all.forEach((input, idx) => {
        input.addEventListener('input', (e) => {
          const val = e.target.value.replace(/\D/g, '');
          e.target.value = val.slice(0, 1);
          if (val && idx < all.length - 1) all[idx + 1].focus();
          if (all.every(d => d.value)) this.verifyOtp();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && idx > 0) all[idx - 1].focus();
          if (e.key === 'Enter') this.verifyOtp();
        });
        input.addEventListener('paste', (e) => {
          e.preventDefault();
          const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
          all.forEach((inp, i) => { inp.value = digits[i] || ''; });
          all[Math.min(digits.length, all.length) - 1]?.focus();
          if (digits.length >= all.length) this.verifyOtp();
        });
      });
    },

    goToStep(step) {
      const onConsent = step === 'consent';
      document.getElementById('auth-step-consent')?.classList.toggle('hidden', !onConsent);
      document.getElementById('auth-credentials-card')?.classList.toggle('hidden', onConsent);
      ['id', 'profile', 'otp', 'camera'].forEach(s => {
        document.getElementById(`auth-step-${s}`)?.classList.toggle('hidden', s !== step);
      });
      const current = STEP_INDEX[step];
      document.querySelectorAll('#auth-stepper li').forEach((li, i) => {
        li.classList.toggle('current', i === current);
        li.classList.toggle('done', i < current);
      });
      document.querySelectorAll('.field-error').forEach(e => e.classList.add('hidden'));
    },

    setBusy(btn, busy, label) {
      if (!btn) return;
      if (busy) {
        btn.dataset.label = btn.dataset.label || btn.textContent;
        btn.textContent = label;
      } else {
        btn.textContent = btn.dataset.label || btn.textContent;
      }
      btn.disabled = busy;
    },

    /** Looks the code up and shows what the candidate is joining. */
    async lookupExam(quiet = false) {
      const code = cleanCode(document.getElementById('input-exam-code').value);
      const meta = document.getElementById('selected-exam-meta');
      if (code.length < 6) {
        if (!quiet) this.showError(document.getElementById('auth-error-id'), 'Enter the exam code from your proctor.');
        return null;
      }
      try {
        const exam = await window.api.get(`/api/assessment/exams/join/${code}`);
        this.exam = exam;
        const rules = exam.rules || {};
        const parts = [`${exam.questionCount} questions`, `${exam.durationMinutes} minutes`, `${rules.maxStrikes || 3} warnings allowed`];
        meta.innerHTML = `<strong>${window.escapeHtml(exam.title)}</strong><span>${parts.join(' · ')}</span>`;
        meta.classList.remove('hidden');
        return exam;
      } catch (err) {
        meta.classList.add('hidden');
        if (!quiet || err.status === 403) this.showError(document.getElementById('auth-error-id'), err.message || 'No exam matches that code.');
        return null;
      }
    },

    async join() {
      const errorEl = document.getElementById('auth-error-id');
      const btn = document.getElementById('btn-request-otp');
      if (btn.disabled) return;
      const name = document.getElementById('input-student-name').value.trim().replace(/\s+/g, ' ');
      const rollNo = document.getElementById('input-student-id').value.trim().toUpperCase();

      this.setBusy(btn, true, 'Checking…');
      try {
        const exam = this.exam || await this.lookupExam();
        if (!exam) return;
        if (!name) return this.showError(errorEl, 'Enter your full name.');
        if (!rollNo) return this.showError(errorEl, 'Enter your roll number.');

        window.AppState.selectedExamId = exam.id;
        window.AppState.examTitle = exam.title;

        let hasProfile = true;
        try {
          await window.api.get(`/api/auth/profile/${encodeURIComponent(rollNo)}`);
        } catch (err) {
          if (err.status !== 404) throw err;
          hasProfile = false;
        }

        if (!hasProfile) {
          this.pendingProfile = { name, rollNo };
          document.getElementById('profile-roll').textContent = rollNo;
          document.getElementById('profile-roll-2').textContent = rollNo;
          document.getElementById('profile-name').textContent = name;
          this.goToStep('profile');
          document.getElementById('input-profile-email').focus();
          return;
        }

        // Existing profile: the server refuses if the name doesn't match the roll number.
        const res = await window.api.post('/api/auth/profile', { rollNo, name });
        await this.requestCode(res.studentId, res.name);
      } catch (err) {
        this.showError(errorEl, err.message || 'Could not continue. Check your details and try again.');
      } finally {
        this.setBusy(btn, false);
      }
    },

    async createProfile() {
      const errorEl = document.getElementById('auth-error-profile');
      const btn = document.getElementById('btn-create-profile');
      if (btn.disabled || !this.pendingProfile) return;
      const email = document.getElementById('input-profile-email').value.trim();
      const institution = document.getElementById('input-profile-institution').value.trim();
      if (!email) return this.showError(errorEl, 'Enter your email address.');

      this.setBusy(btn, true, 'Creating…');
      try {
        const res = await window.api.post('/api/auth/profile', { ...this.pendingProfile, email, institution });
        await this.requestCode(res.studentId, res.name);
      } catch (err) {
        this.showError(errorEl, err.message || 'Could not create your profile.');
      } finally {
        this.setBusy(btn, false);
      }
    },

    async requestCode(studentId, name) {
      const res = await window.api.post('/api/auth/otp/request', { studentId });
      window.AppState.studentId = res.studentId || studentId;
      window.AppState.studentName = name;
      document.getElementById('otp-target').textContent = window.AppState.studentId;

      const devNote = document.getElementById('auth-dev-otp');
      const code = res.devOtp || res.otp;
      if (devNote && code) {
        // Development build: no delivery channel, so the code is shown here.
        devNote.innerHTML = `Development mode: your code is <code>${window.escapeHtml(code)}</code>`;
        devNote.classList.remove('hidden');
      } else if (devNote && res.delivery === 'proctor') {
        devNote.textContent = 'Your invigilator has your code. Show them your ID card and they will read it out to you.';
        devNote.classList.remove('hidden');
      }
      document.querySelectorAll('.otp-digit').forEach(d => { d.value = ''; });
      this.goToStep('otp');
      document.querySelector('.otp-digit')?.focus();
    },

    async verifyOtp() {
      const otp = Array.from(document.querySelectorAll('.otp-digit')).map(d => d.value).join('');
      const errorEl = document.getElementById('auth-error-otp');
      const btn = document.getElementById('btn-verify-otp');
      if (btn.disabled) return;
      if (otp.length < 6) return this.showError(errorEl, 'Enter all six digits.');

      this.setBusy(btn, true, 'Checking…');
      try {
        const res = await window.api.post('/api/auth/otp/verify', { studentId: window.AppState.studentId, otp });
        window.AppState.token = res.token;
        if (res.candidate && res.candidate.name) window.AppState.studentName = res.candidate.name;
        window.setExamChrome && window.setExamChrome();
        this.goToStep('camera');
        this.startCamera();
      } catch (err) {
        this.showError(errorEl, err.message || 'That code is not valid.');
        document.querySelectorAll('.otp-digit').forEach(d => { d.value = ''; });
        document.querySelector('.otp-digit')?.focus();
      } finally {
        this.setBusy(btn, false);
      }
    },

    setCheck(name, ok) {
      const li = document.querySelector(`#camera-checklist [data-check="${name}"]`);
      if (!li) return;
      li.classList.toggle('ok', ok === true);
      li.classList.toggle('bad', ok === false);
    },

    setStatus(text, tone) {
      const status = document.getElementById('camera-status');
      if (!status) return;
      status.querySelector('.status-text').textContent = text;
      status.querySelector('.status-dot').className = `status-dot ${tone || ''}`;
    },

    async startCamera() {
      try {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        } catch (_) {
          cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        const video = document.getElementById('camera-preview');
        video.srcObject = cameraStream;
        await video.play().catch(() => {});
        document.getElementById('camera-help').classList.add('hidden');
        document.getElementById('btn-capture-face').disabled = false;
        this.setCheck('camera', true);
        this.refreshEarpieceCheck();
        this.setStatus('Loading face detection…', 'warn');
        window.ProctorClient?.startCalibration(video, document.getElementById('camera-auth-canvas'), (m) => this.onCalibrationFrame(m));
      } catch (err) {
        this.setCheck('camera', false);
        document.getElementById('btn-capture-face').disabled = true;
        await this.explainCameraError(err);
      }
    },

    /** Tells the candidate exactly why the camera didn't start and what to do about it. */
    async explainCameraError(err) {
      const help = document.getElementById('camera-help');
      const name = err && err.name;
      let title;
      let body;

      if (!window.isSecureContext || !navigator.mediaDevices) {
        // Browsers only expose the camera on HTTPS or localhost.
        let secureUrl = null;
        try {
          const net = await window.api.get('/api/system/network');
          if (net.httpsPort) secureUrl = `https://${location.hostname}:${net.httpsPort}${location.pathname}`;
        } catch (_) {}
        title = 'This page needs a secure connection to use your camera';
        body = secureUrl
          ? `Open the secure address below. Your browser will warn that the certificate is not trusted, because it comes from the exam laptop rather than a public authority. Choose <b>Advanced</b>, then <b>Proceed</b>. You only need to do this once.
             <a class="camera-help-link" href="${window.escapeHtml(secureUrl)}">${window.escapeHtml(secureUrl)}</a>`
          : 'Ask your proctor for the https:// address of the exam, or use the Trinetra desktop app.';
      } else if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        title = 'Camera access was blocked';
        body = `Click the camera icon at the right of the address bar, choose <b>Allow</b>, then press Try again.
                On Windows, also check <b>Settings → Privacy &amp; security → Camera</b> and turn on camera access for apps and desktop apps.`;
      } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        title = 'Your camera is being used by another app';
        body = 'Close Zoom, Teams, Google Meet, the Camera app or any other tab using the camera, then press Try again.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        title = 'No camera found';
        body = 'Connect a webcam (or check that the laptop camera is not disabled by a privacy switch or function key), then press Try again.';
      } else {
        title = 'The camera could not be started';
        body = `${window.escapeHtml((err && err.message) || 'Unknown error')}. Try again, or restart the browser.`;
      }

      this.setStatus(title, 'error');
      help.innerHTML = `<strong>${title}</strong><p>${body}</p><button type="button" class="btn btn-secondary btn-sm" id="btn-camera-retry">Try again</button>`;
      help.classList.remove('hidden');
      document.getElementById('btn-camera-retry').addEventListener('click', () => this.startCamera());
    },

    /** Earphones must be disconnected before the exam can start. */
    async refreshEarpieceCheck() {
      if (!window.InputTracker || !document.getElementById('auth-step-camera') || document.getElementById('auth-step-camera').classList.contains('hidden')) return [];
      const found = await window.InputTracker.currentEarpieces().catch(() => []);
      this.earpieces = found;
      this.setCheck('audio', found.length === 0);
      const li = document.querySelector('#camera-checklist [data-check="audio"]');
      if (li) li.textContent = found.length ? `Disconnect: ${found.join(', ')}` : 'No earphones or headset connected';
      return found;
    },

    onCalibrationFrame(m) {
      this.setCheck('face', m.faceCount === 1);
      this.setCheck('gaze', m.faceCount === 1 ? !m.instantViolation : null);
      this.setCheck('light', m.faceCount === 1 ? m.brightness >= 60 : null);

      if (m.faceCount === 0) this.setStatus('No face found. Move into the frame.', 'warn');
      else if (m.faceCount > 1) this.setStatus(`${m.faceCount} faces in view. Make sure you are alone.`, 'error');
      else if (m.brightness < 60) this.setStatus('Your face is too dark. Add light in front of you.', 'warn');
      else if (m.instantViolation) this.setStatus('Look straight at the screen.', 'warn');
      else this.setStatus('Ready. Hold still and take the photo.', 'live');
    },

    async captureFace() {
      const errorEl = document.getElementById('auth-error-camera');
      const btn = document.getElementById('btn-capture-face');
      const video = document.getElementById('camera-preview');
      if (btn.disabled || !video || !video.srcObject) return;

      this.setBusy(btn, true, 'Checking…');
      try {
        const earpieces = await this.refreshEarpieceCheck();
        if (earpieces.length) {
          this.showError(errorEl, `Disconnect your earphones or headset before starting: ${earpieces.join(', ')}.`);
          return;
        }
        const reference = window.ProctorClient ? await window.ProctorClient.captureReference(video) : { ok: true };
        if (!reference.ok) {
          this.showError(errorEl, reference.reason);
          return;
        }
        const canvas = document.getElementById('camera-canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvas.getContext('2d').drawImage(video, 0, 0);
        await window.api.post('/api/auth/face/verify', {
          studentId: window.AppState.studentId,
          imageBase64: canvas.toDataURL('image/jpeg', 0.85),
          descriptor: reference.descriptor || undefined,
          confidence: reference.confidence || 0.9,
          landmarksDetected: Boolean(reference.descriptor)
        }).catch(() => {});

        this.showError(errorEl, 'Reference photo saved. Starting the exam…', false);
        await this.proceedToExam();
      } finally {
        this.setBusy(btn, false);
      }
    },

    async proceedToExam() {
      const state = window.AppState;
      const errorEl = document.getElementById('auth-error-camera');
      let res;
      try {
        res = await window.api.post('/api/assessment/session/start', {
          examId: state.selectedExamId,
          studentId: state.studentId,
          deviceId: state.deviceId
        });
      } catch (err) {
        this.showError(errorEl, err.code === 'CONCURRENT_SESSION' || err.status === 409
          ? 'This roll number already has an exam in progress on another device. The attempt has been reported to the proctor.'
          : (err.message || 'Could not start the exam. Try again.'));
        return;
      }

      // Hand the open camera stream to the exam-time monitor rather than reopening the device.
      const stream = cameraStream;
      cameraStream = null;

      state.sessionId = res.sessionId;
      state.questions = res.questions || [];
      state.expiresAt = res.expiresAt;
      state.currentQuestionIdx = 0;
      state.answers = res.answers || {};
      state.strikes = res.strikeCount || 0;
      if (res.examTitle) state.examTitle = res.examTitle;
      const rules = res.rules || (res.session && res.session.rules) || {};
      state.rules = rules;
      state.maxStrikes = rules.maxStrikes || res.maxStrikes || 3;
      if (res.resumed) {
        window.showWarning('Resumed your attempt on this device. Saved answers were restored.', state.strikes, state.maxStrikes, { informational: true });
      }

      window.connectStudentWebSocket && window.connectStudentWebSocket(res.sessionId);
      try { await window.proctorAPI?.setSessionId?.(res.sessionId); } catch (_) {}
      window.beginLockdown && window.beginLockdown(res.sessionId);
      window.TabsUI?.loadInitialTabs?.();

      const newTabBtn = document.getElementById('btn-new-tab');
      if (newTabBtn) newTabBtn.style.display = rules.enableMultiTab === false ? 'none' : '';
      document.getElementById('assist-panel')?.classList.toggle('hidden', rules.enableGuidedAssistant === false);
      document.getElementById('lookup-panel')?.classList.toggle('hidden', rules.enableMultiTab === false);

      window.setExamChrome && window.setExamChrome();
      window.switchView('exam');
      window.updateStrikeTrack && window.updateStrikeTrack();
      window.ExamView && window.ExamView.init();

      if (rules.enableVisionProctoring !== false && window.ProctorClient) {
        window.ProctorClient.init(stream);
      } else if (stream) {
        stream.getTracks().forEach(t => t.stop());
        window.ProctorClient?.stopCalibration();
      }
      window.startTimer();
    },

    showError(el, msg, isError = true) {
      if (!el) return;
      el.textContent = msg;
      el.classList.toggle('ok', !isError);
      el.classList.remove('hidden');
    }
  };

  window.AuthView = AuthView;
})();
