/**
 * AuditView — session record shown to the candidate after the attempt.
 * Sites and searches (grouped per site), violations, timeline, tab history.
 */
(function () {
  'use strict';

  const esc = (v) => window.escapeHtml(v);
  const time = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const label = (type) => String(type || 'Unknown').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
  const empty = (text) => `<p class="empty">${text}</p>`;

  const AuditView = {
    async load() {
      const state = window.AppState;
      if (!state.sessionId) return;
      try {
        const report = await window.api.get(`/api/audit/session/${state.sessionId}/report`);
        this.render(report);
      } catch (err) {
        console.error('Failed to load session record:', err);
        ['audit-stats', 'audit-timeline', 'audit-violations', 'audit-searches', 'audit-tabs'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = empty('Could not load the session record.');
        });
      }
    },

    render(report) {
      this.renderStats(report);
      this.renderSites(report);
      this.renderViolations(report);
      this.renderTimeline(report);
      this.renderTabs(report);
    },

    renderStats(report) {
      const session = report.session || {};
      const violations = report.violations || [];
      const sites = report.browsingActivity || [];
      const aiSites = sites.filter(s => s.isAiTool).length;
      const integrity = report.integrityScore || {};
      const stat = (value, text, tone = '') => `<div class="stat ${tone}"><div class="stat-value">${esc(value)}</div><div class="stat-label">${text}</div></div>`;

      document.getElementById('audit-stats').innerHTML = [
        stat(session.score != null ? `${session.score}/${session.maxScore}` : '—', 'Score'),
        stat(violations.length, 'Violations', violations.length ? 'danger' : ''),
        stat(aiSites, 'AI sites opened', aiSites ? 'warn' : ''),
        stat(sites.length, 'Sites visited'),
        stat(integrity.score != null ? integrity.score : '—', 'Integrity score', integrity.rating === 'HIGH_RISK' ? 'danger' : integrity.rating === 'MEDIUM_RISK' ? 'warn' : '')
      ].join('');
    },

    renderSites(report) {
      const el = document.getElementById('audit-searches');
      const sites = report.browsingActivity || [];
      if (sites.length === 0) {
        el.innerHTML = empty('No other sites were opened.');
        return;
      }
      el.innerHTML = sites.map(site => `
        <div class="site${site.isAiTool ? ' ai' : ''}">
          <div class="site-head">
            <span class="site-name">${esc(site.service || site.domain)}${site.isAiTool ? ' <span class="tag tag-danger">AI assistant</span>' : ''}</span>
            <span class="site-meta">opened ${time(site.firstSeen)}${site.visits > 1 ? ` · ${site.visits} page loads` : ''}</span>
          </div>
          ${site.queries.length ? `
            <ul class="query-list">
              ${site.queries.map(q => `<li><span class="when">${time(q.timestamp)}</span><span class="what">${esc(q.query)}</span></li>`).join('')}
            </ul>` : ''}
        </div>`).join('');
    },

    renderViolations(report) {
      const el = document.getElementById('audit-violations');
      const violations = report.violations || [];
      if (violations.length === 0) {
        el.innerHTML = empty('No violations were recorded.');
        return;
      }
      el.innerHTML = `
        <table class="table">
          <thead><tr><th>Time</th><th>What happened</th></tr></thead>
          <tbody>
            ${violations.map(v => `
              <tr>
                <td class="mono">${time(v.timestamp)}</td>
                <td><span class="tag tag-danger">${esc(label(v.type))}</span><br><span class="tag-muted">${esc(v.message || '')}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    },

    renderTimeline(report) {
      const el = document.getElementById('audit-timeline');
      const events = (report.timeline || []).filter(e => e.type !== 'ANSWER_SAVED');
      if (events.length === 0) {
        el.innerHTML = `<li>${empty('No events recorded.')}</li>`;
        return;
      }
      el.innerHTML = events.map(e => {
        const tone = e.type === 'VIOLATION_RECORDED' ? 'violation'
          : (e.type === 'AI_TOOL_INTERACTION' || e.type === 'AI_SEARCH_QUERY') ? 'ai' : '';
        return `<li class="timeline-row ${tone}"><span class="when">${time(e.timestamp)}</span><span class="what">${esc(e.title)}${e.description ? ` — ${esc(e.description)}` : ''}</span></li>`;
      }).join('');
    },

    renderTabs(report) {
      const el = document.getElementById('audit-tabs');
      const tabs = (report.tabEvents || []).filter(t => t.url && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(t.url));
      if (tabs.length === 0) {
        el.innerHTML = empty('No tab activity recorded.');
        return;
      }
      el.innerHTML = `
        <table class="table">
          <thead><tr><th>Time</th><th>Event</th><th>Address</th></tr></thead>
          <tbody>
            ${tabs.map(t => `
              <tr>
                <td class="mono">${time(t.timestamp)}</td>
                <td>${esc(label(t.type || t.eventType))}${t.isFlaggedAiTool ? ' <span class="tag tag-danger">AI</span>' : ''}</td>
                <td class="clip mono" title="${esc(t.url)}">${esc(t.url)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  };

  window.AuditView = AuditView;
})();
