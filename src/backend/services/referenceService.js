/**
 * Reference search — looking things up from inside the exam page.
 *
 * A web page cannot see or control a student's other browser tabs, so candidates who take
 * the exam in a normal browser search here instead. Queries go through the same policy as
 * the desktop app's tabs (must relate to the question on screen; the question or an option
 * pasted in is refused), results come from Wikipedia, and the correct option's text is
 * hidden wherever it appears. Every query and article opened is logged on the attempt.
 */

const datastore = require('../db/datastore');
const proctorService = require('./proctorService');
const { SearchPolicy } = require('../../main/searchPolicy');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'TrinetraExamBrowser/1.0 (proctored exam reference search)';
const MAX_ARTICLE_CHARS = 9000;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, error: code });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class ReferenceService {
  constructor(fetchFn) {
    this.fetch = fetchFn || ((...args) => fetch(...args));
  }

  context(sessionId, questionId) {
    const session = sessionId ? datastore.getSession(sessionId) : null;
    if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'IN_PROGRESS') throw fail(400, 'SESSION_ENDED', 'The exam has ended.');
    if (session.rules && session.rules.enableMultiTab === false) throw fail(403, 'LOOKUP_DISABLED', 'Looking things up is turned off for this exam.');
    if (!(session.questionIds || []).includes(questionId)) throw fail(400, 'QUESTION_NOT_IN_SESSION', 'That question is not part of your exam.');
    return { session, question: datastore.getQuestionById(questionId) };
  }

  /** Replaces the correct option's text so a lookup explains the concept but never states the answer. */
  redact(text, question) {
    const correct = (question.options || []).find(o => o.id === question.correctOptionId);
    const answer = correct ? String(correct.text).trim() : '';
    // Skip one- or two-letter answers and plain numbers, which would black out ordinary text.
    if (answer.length < 3 || /^\d+$/.test(answer)) return { text, hidden: 0 };
    let hidden = 0;
    const out = text.replace(new RegExp(escapeRegExp(answer), 'gi'), () => { hidden++; return '[hidden]'; });
    return { text: out, hidden };
  }

  async wiki(params) {
    const url = `${WIKI_API}?${new URLSearchParams({ format: 'json', utf8: '1', origin: '*', ...params })}`;
    let res;
    try {
      res = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (_) {
      throw fail(503, 'LOOKUP_OFFLINE', 'Reference search needs an internet connection on the exam server.');
    }
    if (!res.ok) throw fail(502, 'LOOKUP_FAILED', 'Reference search is unavailable right now.');
    return res.json();
  }

  async search({ sessionId, questionId, query }) {
    const { session, question } = this.context(sessionId, questionId);
    const q = String(query || '').trim().slice(0, 200);
    if (!q) throw fail(400, 'EMPTY_QUERY', 'Type something to look up.');

    const policy = new SearchPolicy();
    policy.setContext({
      questionText: question.text || question.prompt,
      options: (question.options || []).map(o => o.text),
      category: question.category || '',
      rules: session.rules || {}
    });
    const verdict = policy.checkQuery(q);
    const url = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;

    if (verdict) {
      await proctorService.recordSearchEvent(sessionId, { service: 'Reference search', query: q, url, blocked: true, blockReason: verdict.reason });
      return { blocked: true, reason: verdict.reason, detail: verdict.detail, results: [] };
    }

    const data = await this.wiki({ action: 'query', list: 'search', srsearch: q, srlimit: '6', srprop: 'snippet' });
    let hidden = 0;
    const results = ((data.query && data.query.search) || []).map(r => {
      const snippet = this.redact(String(r.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'"), question);
      hidden += snippet.hidden;
      return { title: r.title, snippet: snippet.text };
    });
    await proctorService.recordSearchEvent(sessionId, { service: 'Reference search', query: q, url });
    return { blocked: false, results, hidden };
  }

  async article({ sessionId, questionId, title }) {
    const { question } = this.context(sessionId, questionId);
    const name = String(title || '').trim().slice(0, 200);
    if (!name) throw fail(400, 'EMPTY_TITLE', 'No article selected.');

    const data = await this.wiki({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain', redirects: '1', titles: name });
    const page = Object.values((data.query && data.query.pages) || {})[0];
    if (!page || page.missing !== undefined) throw fail(404, 'ARTICLE_NOT_FOUND', 'That article could not be found.');

    let text = String(page.extract || '');
    // Drop reference/appendix sections; they add length but no explanation.
    text = text.split(/\n(?:See also|References|External links|Further reading|Notes)\n/)[0].trim();
    const truncated = text.length > MAX_ARTICLE_CHARS;
    if (truncated) text = `${text.slice(0, MAX_ARTICLE_CHARS).replace(/\s+\S*$/, '')}…`;
    const redacted = this.redact(text, question);
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`;

    await proctorService.recordTabActivity(sessionId, { eventType: 'TAB_NAVIGATE', url, title: page.title, domain: 'en.wikipedia.org' });
    return { title: page.title, text: redacted.text, hidden: redacted.hidden, truncated, url };
  }
}

module.exports = new ReferenceService();
module.exports.ReferenceService = ReferenceService;
