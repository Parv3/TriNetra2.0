/**
 * Lookup — reference search inside the exam page.
 * Works in a normal browser, where the exam page cannot see other tabs: queries go to the
 * exam server, which applies the search policy, searches Wikipedia, hides the correct
 * option's text and logs the activity for the proctor.
 */
(function () {
  'use strict';

  const esc = (v) => window.escapeHtml(v);

  const Lookup = {
    question: null,
    bound: false,
    busy: false,
    lastResults: null,
    count: 0,

    init() {
      if (this.bound) return;
      this.bound = true;
      const toggle = document.getElementById('lookup-toggle');
      toggle?.addEventListener('click', () => this.setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
      document.getElementById('lookup-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        this.search(document.getElementById('lookup-input').value);
      });
    },

    setOpen(open) {
      document.getElementById('lookup-toggle')?.setAttribute('aria-expanded', String(open));
      document.getElementById('lookup-body')?.classList.toggle('hidden', !open);
      if (open) document.getElementById('lookup-input')?.focus();
    },

    setQuestion(q) {
      this.init();
      if (this.question && this.question.id === q.id) return;
      this.question = q;
      this.lastResults = null;
      const results = document.getElementById('lookup-results');
      if (results) results.innerHTML = '';
    },

    params(extra) {
      const state = window.AppState;
      return new URLSearchParams({ sessionId: state.sessionId, questionId: this.question.id, ...extra }).toString();
    },

    async search(text) {
      const q = String(text || '').trim();
      const box = document.getElementById('lookup-results');
      if (!q || !this.question || this.busy) return;
      this.busy = true;
      box.innerHTML = '<p class="assist-empty">Searching…</p>';
      try {
        const res = await window.api.get(`/api/reference/search?${this.params({ q })}`);
        this.count++;
        document.getElementById('lookup-count').textContent = `${this.count} search${this.count === 1 ? '' : 'es'}`;
        if (res.blocked) {
          box.innerHTML = `<div class="assist-msg bot refused">${esc(res.detail || 'That search is not allowed.')}</div>`;
          return;
        }
        this.lastResults = res.results;
        this.renderResults();
      } catch (err) {
        box.innerHTML = `<div class="assist-msg bot refused">${esc(err.message || 'Reference search is unavailable.')}</div>`;
      } finally {
        this.busy = false;
      }
    },

    renderResults() {
      const box = document.getElementById('lookup-results');
      const results = this.lastResults || [];
      if (results.length === 0) {
        box.innerHTML = '<p class="assist-empty">No articles found. Try different words.</p>';
        return;
      }
      box.innerHTML = `<ul class="lookup-list">${results.map((r, i) => `
        <li><button class="lookup-hit" data-i="${i}"><strong>${esc(r.title)}</strong><span>${esc(r.snippet)}…</span></button></li>`).join('')}</ul>`;
      box.querySelectorAll('.lookup-hit').forEach(btn => btn.addEventListener('click', () => this.open(results[Number(btn.dataset.i)].title)));
    },

    async open(title) {
      const box = document.getElementById('lookup-results');
      if (this.busy) return;
      this.busy = true;
      box.innerHTML = '<p class="assist-empty">Opening…</p>';
      try {
        const a = await window.api.get(`/api/reference/article?${this.params({ title })}`);
        const paragraphs = a.text.split(/\n+/).filter(Boolean).map(p => `<p>${esc(p).replace(/\[hidden\]/g, '<mark class="hidden-answer" title="Hidden during the exam">hidden</mark>')}</p>`).join('');
        box.innerHTML = `
          <div class="lookup-article">
            <div class="lookup-article-head">
              <button class="btn btn-quiet btn-sm" id="lookup-back">Back to results</button>
              <span class="assist-count">Wikipedia${a.hidden ? ` · ${a.hidden} answer mention${a.hidden === 1 ? '' : 's'} hidden` : ''}</span>
            </div>
            <h3>${esc(a.title)}</h3>
            ${paragraphs}
            ${a.truncated ? '<p class="assist-empty">Article shortened.</p>' : ''}
          </div>`;
        document.getElementById('lookup-back').addEventListener('click', () => this.renderResults());
      } catch (err) {
        box.innerHTML = `<div class="assist-msg bot refused">${esc(err.message || 'Could not open the article.')}</div>`;
      } finally {
        this.busy = false;
      }
    }
  };

  window.Lookup = Lookup;
})();
