/**
 * GuidedHelp — the in-exam assistant panel.
 * Conversations are kept per question; replies come from /api/assist, which refuses
 * answer-seeking or off-topic requests and strips anything that points at an option.
 */
(function () {
  'use strict';

  const esc = (v) => window.escapeHtml(v);

  const GuidedHelp = {
    question: null,
    threads: {},      // questionId -> [{ role, text, tone }]
    remaining: {},    // questionId -> number
    busy: false,
    bound: false,

    init() {
      if (this.bound) return;
      this.bound = true;
      const toggle = document.getElementById('assist-toggle');
      toggle?.addEventListener('click', () => this.setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
      document.getElementById('assist-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        this.ask();
      });

      // When the desktop shell blocks an AI site, steer the candidate here instead.
      window.proctorAPI?.onPolicyBlocked?.((info) => {
        const state = window.AppState;
        const label = info.reason === 'AI_SITE' ? `${info.site || 'AI sites'} is blocked during the exam. Use Guided help instead.`
          : info.reason === 'OFF_TOPIC' ? 'Search blocked: it isn\'t related to the question on screen.'
          : 'Search blocked: search for the concept, not the question or its options.';
        window.showWarning(label, state.strikes, state.maxStrikes, { informational: true });
        if (info.reason === 'AI_SITE') this.setOpen(true);
      });
    },

    setOpen(open) {
      const toggle = document.getElementById('assist-toggle');
      toggle?.setAttribute('aria-expanded', String(open));
      document.getElementById('assist-body')?.classList.toggle('hidden', !open);
      if (open) document.getElementById('assist-input')?.focus();
    },

    setQuestion(q) {
      this.init();
      this.question = q;
      this.render();
    },

    render() {
      const thread = document.getElementById('assist-thread');
      const counter = document.getElementById('assist-remaining');
      if (!thread || !this.question) return;
      const items = this.threads[this.question.id] || [];
      thread.innerHTML = items.length === 0
        ? '<p class="assist-empty">Ask about a term or idea in this question — for example, "what does this term mean?"</p>'
        : items.map(m => `<div class="assist-msg ${m.role}${m.tone ? ` ${m.tone}` : ''}">${esc(m.text)}</div>`).join('');
      thread.scrollTop = thread.scrollHeight;
      const left = this.remaining[this.question.id];
      if (counter) counter.textContent = left === undefined ? '' : `${left} left for this question`;
    },

    async ask() {
      const input = document.getElementById('assist-input');
      const text = (input?.value || '').trim();
      const q = this.question;
      if (!text || !q || this.busy) return;
      const state = window.AppState;

      const thread = (this.threads[q.id] = this.threads[q.id] || []);
      thread.push({ role: 'me', text });
      thread.push({ role: 'bot', text: 'Thinking…', tone: 'pending' });
      input.value = '';
      this.busy = true;
      this.render();

      try {
        const res = await window.api.post('/api/assist', { sessionId: state.sessionId, questionId: q.id, message: text });
        thread[thread.length - 1] = { role: 'bot', text: res.reply, tone: res.outcome === 'ANSWERED' ? '' : 'refused' };
        this.remaining[q.id] = res.remainingForQuestion;
      } catch (err) {
        thread[thread.length - 1] = { role: 'bot', text: err.message || 'Guided help is unavailable right now.', tone: 'refused' };
        if (err.code === 'ASSIST_LIMIT') this.remaining[q.id] = 0;
      } finally {
        this.busy = false;
        this.render();
      }
    }
  };

  window.GuidedHelp = GuidedHelp;
})();
