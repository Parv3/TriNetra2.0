/**
 * Search Policy
 * Decides, for every navigation in a guest tab, whether it may load:
 *  - AI chat sites are blocked (the in-app guided assistant replaces them);
 *  - search queries must relate to the question on screen, and must not be the
 *    question (or an option) pasted into the search box;
 *  - Google searches are forced into "Web" results (udm=14), which drops the AI Overview
 *    and featured-snippet boxes that state answers outright.
 * Pure functions plus a little state (the current question), so it is easy to test.
 */

const { SearchTracker } = require('./searchTracker');

const AI_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'perplexity.ai', 'deepseek.com', 'chat.deepseek.com', 'poe.com', 'you.com',
  'character.ai', 'huggingface.co/chat', 'chat.mistral.ai', 'meta.ai', 'grok.com', 'x.ai', 'phind.com',
  'quillbot.com', 'chegg.com', 'brainly.com', 'coursehero.com', 'studocu.com'
];

const STOPWORDS = new Set(('a an and are as at be by can do does for from has have how i if in into is it its of on or ' +
  'that the their then there these this to was what when where which who why will with you your vs versus ' +
  'example examples meaning define definition tutorial guide explained').split(' '));

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) || []).filter(w => w.length > 1);
}

function keyWords(text) {
  return words(text).filter(w => !STOPWORDS.has(w) && w.length > 2);
}

function hostMatches(url, list) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const full = `${host}${u.pathname}`.toLowerCase();
  return list.find(entry => host === entry || host.endsWith(`.${entry}`) || full.startsWith(entry)) || null;
}

class SearchPolicy {
  constructor() {
    this.context = null; // { questionText, options[], category, rules }
  }

  setContext(context) {
    this.context = context && context.questionText ? context : null;
  }

  /**
   * @returns {{ action: 'allow' } | { action: 'block', reason, detail, query?, service? } | { action: 'rewrite', url }}
   */
  evaluate(url) {
    if (!this.context) return { action: 'allow' }; // not in an exam (sign-in, results)
    const rules = this.context.rules || {};

    const aiHost = hostMatches(url, AI_HOSTS);
    if (aiHost && rules.enableAiGuard !== false) {
      return { action: 'block', reason: 'AI_SITE', service: aiHost, detail: `${aiHost} is not available during the exam.` };
    }

    const extracted = SearchTracker.extractSearchQuery(url);
    if (!extracted || !extracted.query || extracted.isFlaggedAiTool) {
      return this.forceWebResults(url);
    }

    const query = extracted.query.trim();
    const verdict = this.checkQuery(query);
    if (verdict) return { ...verdict, action: 'block', query, service: extracted.service };
    return this.forceWebResults(url);
  }

  /** Returns a block verdict for a query, or null if it may run. */
  checkQuery(query) {
    const ctx = this.context;
    const qWords = keyWords(query);
    if (qWords.length === 0) return null;

    // 1. The question itself pasted (or retyped) into the search box
    const questionWords = new Set(keyWords(ctx.questionText));
    const overlap = qWords.filter(w => questionWords.has(w)).length;
    const lowerQuery = query.toLowerCase();
    const questionStart = ctx.questionText.toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if ((qWords.length >= 5 && overlap / qWords.length >= 0.7 && overlap >= Math.min(6, questionWords.size * 0.5)) ||
        (questionStart.length >= 25 && lowerQuery.includes(questionStart))) {
      return { reason: 'QUESTION_COPY', detail: 'That search is the exam question itself. Search for the underlying concept instead.' };
    }

    // 2. An answer option searched verbatim, usually to check "is X the right answer"
    const optionHit = (ctx.options || []).find(opt => {
      const optWords = keyWords(opt);
      if (optWords.length < 2) return false;
      return optWords.every(w => qWords.includes(w));
    });
    if (optionHit) {
      return { reason: 'OPTION_LOOKUP', detail: 'Searching for an answer option word-for-word isn\'t allowed. Search for the concept it relies on.' };
    }

    // 3. Must be about this question's topic
    const topic = new Set([...questionWords, ...keyWords(ctx.category), ...(ctx.options || []).flatMap(keyWords)]);
    const related = qWords.some(w => topic.has(w) || [...topic].some(t => t.length > 4 && w.length > 4 && (t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5)))));
    if (!related) {
      return { reason: 'OFF_TOPIC', detail: 'Searches must relate to the question you are on.' };
    }
    return null;
  }

  /** Google: switch to plain web results so no AI Overview or answer box is rendered. */
  forceWebResults(url) {
    let u;
    try { u = new URL(url); } catch (_) { return { action: 'allow' }; }
    const isGoogleSearch = /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/search' && u.searchParams.get('q');
    if (isGoogleSearch && u.searchParams.get('udm') !== '14') {
      u.searchParams.set('udm', '14');
      return { action: 'rewrite', url: u.toString() };
    }
    return { action: 'allow' };
  }
}

module.exports = { SearchPolicy, AI_HOSTS, keyWords };
