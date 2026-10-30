/**
 * ExamView — MCQ workspace
 * Question display, option selection, navigation, palette, auto-save, submission.
 */
(function () {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const esc = (v) => window.escapeHtml(v);

  // Question banks use `backticks` for inline code; render those after escaping.
  const formatText = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

  const QUEUE_KEY = 'trinetra.pendingAnswers';

  const ExamView = {
    bound: false,
    lastShownId: null,

    init() {
      this.lastShownId = null;
      this.renderQuestion();
      this.renderPalette();
      if (!this.bound) {
        this.bindEvents();
        window.addEventListener('online', () => this.flushQueue());
        window.addEventListener('offline', () => this.updateSyncStatus());
        setInterval(() => this.flushQueue(), 8000);
        this.bound = true;
      }
      this.flushQueue();
    },

    /** Runs once each time a different question comes on screen. */
    onQuestionShown(q) {
      if (q.id === this.lastShownId) return;
      this.lastShownId = q.id;
      const state = window.AppState;
      // Time-per-question analytics for the proctor's report
      window.InputTracker && window.InputTracker.send('QUESTION_VIEW', { questionId: q.id, index: state.currentQuestionIdx + 1 });
      // The desktop shell judges search relevance against the question on screen
      window.proctorAPI?.setExamContext?.({
        questionText: q.text || q.prompt,
        options: (q.options || []).map(o => o.text),
        category: q.category || '',
        rules: state.rules || {}
      }).catch?.(() => {});
      window.GuidedHelp && window.GuidedHelp.setQuestion(q);
      window.Lookup && window.Lookup.setQuestion(q);
    },

    // ── Offline answer queue: answers are kept on this device until the server confirms them ──
    loadQueue() {
      try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}'); } catch (_) { return {}; }
    },
    saveQueue(queue) {
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (_) {}
      this.updateSyncStatus();
    },
    async flushQueue() {
      const queue = this.loadQueue();
      const pending = Object.values(queue).filter(item => item.sessionId === window.AppState.sessionId);
      for (const item of pending) {
        try {
          await window.api.post('/api/assessment/answer', item);
          delete queue[item.questionId];
        } catch (err) {
          if (err && err.status && err.status < 500) delete queue[item.questionId]; // rejected, not offline
          else break;
        }
      }
      this.saveQueue(queue);
      return Object.keys(queue).length;
    },
    updateSyncStatus() {
      const el = document.getElementById('sync-status');
      if (!el) return;
      const count = Object.keys(this.loadQueue()).length;
      if (count === 0 && navigator.onLine) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden', 'ok');
      el.textContent = navigator.onLine
        ? `Syncing ${count} answer${count === 1 ? '' : 's'}…`
        : `Offline — ${count} answer${count === 1 ? '' : 's'} saved on this device`;
    },

    bindEvents() {
      const $ = (id) => document.getElementById(id);
      $('btn-prev-q')?.addEventListener('click', () => this.goToQuestion(window.AppState.currentQuestionIdx - 1));
      $('btn-next-q')?.addEventListener('click', () => this.goToQuestion(window.AppState.currentQuestionIdx + 1));
      $('btn-flag-question')?.addEventListener('click', () => this.toggleFlag());
      $('btn-submit-exam')?.addEventListener('click', () => this.confirmSubmit());
      $('btn-view-audit')?.addEventListener('click', () => {
        window.AuditView && window.AuditView.load();
        window.switchView('audit');
      });
      $('btn-back-results')?.addEventListener('click', () => {
        window.switchView(window.AppState.disqualified ? 'disqualified' : 'results');
      });

      document.addEventListener('keydown', (e) => {
        const state = window.AppState;
        if (state.currentView !== 'exam' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (!document.getElementById('modal-overlay').classList.contains('hidden')) return;

        if (e.key === 'ArrowLeft') { e.preventDefault(); this.goToQuestion(state.currentQuestionIdx - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.goToQuestion(state.currentQuestionIdx + 1); }
        else if (e.key === 'f' || e.key === 'F') this.toggleFlag();
        else if (/^[1-6]$/.test(e.key)) {
          const q = state.questions[state.currentQuestionIdx];
          const opt = q && q.options && q.options[Number(e.key) - 1];
          if (opt) this.selectOption(opt.id);
        }
      });
    },

    renderQuestion() {
      const state = window.AppState;
      const q = state.questions[state.currentQuestionIdx];
      if (!q) return;
      const total = state.questions.length;

      document.getElementById('exam-question-counter').textContent = `Question ${state.currentQuestionIdx + 1} of ${total}`;

      const meta = [q.category, q.difficulty].filter(Boolean).map(esc).join(' · ');
      document.getElementById('question-text').innerHTML = `
        ${meta ? `<p class="question-meta">${meta}</p>` : ''}
        <p class="question-body">${formatText(q.text || q.prompt)}</p>
      `;

      const selectedId = state.answers[q.id];
      const optList = document.getElementById('options-list');
      optList.innerHTML = q.options.map((opt, i) => `
        <div class="option${selectedId === opt.id ? ' selected' : ''}" data-option-id="${esc(opt.id)}"
             role="radio" tabindex="0" aria-checked="${selectedId === opt.id}">
          <span class="option-key">${LETTERS[i] || i + 1}</span>
          <span class="option-text">${formatText(opt.text)}</span>
        </div>
      `).join('');

      optList.querySelectorAll('.option').forEach(card => {
        card.addEventListener('click', () => this.selectOption(card.dataset.optionId));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.selectOption(card.dataset.optionId);
          }
        });
      });

      const flagBtn = document.getElementById('btn-flag-question');
      const isFlagged = state.flagged.has(q.id);
      flagBtn.classList.toggle('active', isFlagged);
      flagBtn.querySelector('span').textContent = isFlagged ? 'Marked for review' : 'Mark for review';

      this.onQuestionShown(q);

      document.getElementById('btn-prev-q').disabled = state.currentQuestionIdx === 0;
      const nextBtn = document.getElementById('btn-next-q');
      nextBtn.disabled = state.currentQuestionIdx === total - 1;
    },

    async selectOption(optionId) {
      const state = window.AppState;
      const q = state.questions[state.currentQuestionIdx];
      if (!q || state.submitted || state.disqualified) return;

      state.answers[q.id] = optionId;
      this.renderQuestion();
      this.renderPalette();

      const payload = {
        sessionId: state.sessionId,
        questionId: q.id,
        selectedOptionId: optionId,
        isFlagged: state.flagged.has(q.id)
      };
      try {
        await window.api.post('/api/assessment/answer', payload);
      } catch (err) {
        if (!err || !err.status || err.status >= 500) {
          // Network or server outage: keep the answer locally and retry in the background.
          const queue = this.loadQueue();
          queue[q.id] = payload;
          this.saveQueue(queue);
        } else {
          console.warn('Answer rejected:', err.message);
        }
      }
    },

    goToQuestion(idx) {
      const state = window.AppState;
      if (idx < 0 || idx >= state.questions.length || idx === state.currentQuestionIdx) return;
      state.currentQuestionIdx = idx;
      this.renderQuestion();
      this.renderPalette();
      document.querySelector('#view-exam')?.scrollTo({ top: 0 });
    },

    toggleFlag() {
      const state = window.AppState;
      const q = state.questions[state.currentQuestionIdx];
      if (!q) return;
      if (state.flagged.has(q.id)) state.flagged.delete(q.id);
      else state.flagged.add(q.id);
      this.renderQuestion();
      this.renderPalette();
    },

    renderPalette() {
      const state = window.AppState;
      const grid = document.getElementById('palette-grid');
      if (!grid) return;

      grid.innerHTML = state.questions.map((q, i) => {
        let cls = 'palette-cell';
        if (i === state.currentQuestionIdx) cls += ' current';
        if (state.answers[q.id]) cls += ' answered';
        if (state.flagged.has(q.id)) cls += ' flagged';
        return `<button class="${cls}" data-idx="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`;
      }).join('');
      grid.querySelectorAll('.palette-cell').forEach(cell => {
        cell.addEventListener('click', () => this.goToQuestion(Number(cell.dataset.idx)));
      });

      const answered = state.questions.filter(q => state.answers[q.id]).length;
      const progress = document.getElementById('palette-progress');
      if (progress) progress.textContent = `${answered} of ${state.questions.length} answered`;
    },

    confirmSubmit() {
      const state = window.AppState;
      const answered = state.questions.filter(q => state.answers[q.id]).length;
      const unanswered = state.questions.length - answered;
      const summary = `
        <div class="summary-grid">
          <div><strong>${answered}</strong><span>Answered</span></div>
          <div><strong>${state.flagged.size}</strong><span>Marked</span></div>
          <div><strong>${unanswered}</strong><span>Unanswered</span></div>
        </div>`;
      window.showModal(
        'Submit exam?',
        unanswered > 0
          ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} still unanswered. You cannot change answers after submitting.`
          : 'You cannot change your answers after submitting.',
        summary,
        () => this.submitExam(),
        'Submit exam'
      );
    },

    async submitExam() {
      const state = window.AppState;
      if (state.submitted) return;
      if (await this.flushQueue() > 0) {
        window.showWarning('You are offline. Your answers are saved on this device — submit again once the connection is back.', state.strikes, state.maxStrikes, { informational: true });
        return;
      }
      state.submitted = true;
      clearInterval(state.timerInterval);
      try {
        const res = await window.api.post('/api/assessment/submit', { sessionId: state.sessionId });
        this.showResults(res);
      } catch (err) {
        console.error('Submit failed:', err);
        state.submitted = false;
        window.showWarning('Could not reach the exam server. Your answers are saved — try submitting again.', state.strikes, state.maxStrikes, { informational: true });
      }
    },

    async autoSubmit() {
      const state = window.AppState;
      if (state.submitted) return;
      state.submitted = true;
      clearInterval(state.timerInterval);
      try {
        const res = await window.api.post('/api/assessment/submit', { sessionId: state.sessionId });
        this.showResults(res, 'Time is up. Your answers were submitted automatically.');
      } catch (_) {
        this.showResults({}, 'Time is up. The server finalises your attempt automatically.');
      }
    },

    showResults(res, note) {
      const state = window.AppState;
      const score = res.score ?? res.summary?.score ?? 0;
      const total = res.total ?? res.summary?.maxScore ?? state.questions.length;
      const pct = Math.round((score / (total || 1)) * 100);

      document.getElementById('results-score').innerHTML = `
        <span class="big">${score}<span class="sub"> / ${total}</span></span>
        <span class="sub">${pct}%${note ? ` · ${esc(note)}` : ''}</span>`;

      const results = res.results || [];
      document.getElementById('results-breakdown').innerHTML = results.length ? `
        <ol class="result-list">
          ${results.map((r, i) => {
            const cls = r.isCorrect ? 'correct' : r.isAttempted ? 'incorrect' : 'skipped';
            const label = r.isCorrect ? 'Correct' : r.isAttempted ? 'Incorrect' : 'Not answered';
            return `<li><span class="q">${i + 1}</span><span class="t">${esc(r.text || r.prompt || '')}</span><span class="r ${cls}">${label}</span></li>`;
          }).join('')}
        </ol>` : '';

      window.switchView('results');
      window.proctorAPI?.setExamContext?.(null).catch?.(() => {});
      window.ProctorClient && window.ProctorClient.stop();
      window.InputTracker && window.InputTracker.stop();
      window.endLockdown && window.endLockdown();
    }
  };

  window.ExamView = ExamView;
})();
