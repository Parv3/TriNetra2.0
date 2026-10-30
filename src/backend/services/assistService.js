/**
 * Guided Assistant — the only AI help a candidate can reach during an exam.
 *
 * Instead of letting candidates paste questions into ChatGPT, the browser blocks AI sites
 * and routes them here. The assistant explains concepts behind the *current* question
 * and is sanitised on both sides:
 *  - input:  off-topic requests and "just tell me the answer" requests are refused;
 *  - output: any sentence that names, hints at or evaluates an option is removed before
 *            it reaches the candidate (the server knows the answer key; the model doesn't).
 * Every exchange is logged on the session so the proctor can read the full transcript.
 *
 * Uses Claude when credentials are configured (ANTHROPIC_API_KEY or an `ant auth login`
 * profile); otherwise falls back to the proctor's per-question notes.
 */

const datastore = require('../db/datastore');

const MODEL = process.env.TRINETRA_ASSIST_MODEL || 'claude-opus-5-5';
const MAX_PER_QUESTION = 6;
const MAX_PER_SESSION = 40;

const STOPWORDS = new Set(('a an and are as at be by can do does for from has have how i if in into is it its me my of on or ' +
  'so that the their them then there these this to was what when where which who why will with you your about ' +
  'explain mean means meaning tell show give help please question option options answer answers correct right ' +
  'wrong true false between difference work works used use using one two').split(' '));

const ANSWER_SEEKING = [
  /\b(which|what)(?:'s| is)?\s+(?:the\s+)?(?:correct|right|best|true)\s+(?:option|answer|choice)\b/i,
  /\b(?:give|tell|show)\s+me\s+(?:the\s+)?(?:answer|solution|correct)/i,
  /\bjust\s+(?:the\s+)?answer\b/i,
  /\b(?:is|was)\s+(?:it\s+)?(?:option\s+)?\(?[a-f]\)?\s*(?:\?|$|correct|right)/i,
  /\bwhich\s+(?:one|option)\b/i,
  /\banswer\s+(?:is|to)\b/i,
  /\bsolve\s+(?:this|it|the question)\b/i
];

const META_HELP = /\b(explain|what does (?:this|it|the question) (?:mean|ask)|understand|concept|hint|clarify|rephrase|background)\b/i;

function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g)?.filter(t => !STOPWORDS.has(t) && t.length > 2) || [];
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

class AssistService {
  constructor() {
    this.client = null;
    this.clientChecked = false;
  }

  getClient() {
    if (this.clientChecked) return this.client;
    this.clientChecked = true;
    // Only build a client when some credential source is present; the SDK resolves the rest.
    const hasCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE;
    if (!hasCreds || process.env.NODE_ENV === 'test') return null;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const Client = Anthropic.default || Anthropic;
      this.client = new Client({ timeout: 30000, maxRetries: 1 });
    } catch (err) {
      console.warn('[Assist] Anthropic SDK unavailable, using proctor notes only:', err.message);
    }
    return this.client;
  }

  /** Is the message about the current question at all? */
  isRelevant(message, question) {
    if (META_HELP.test(message)) return true;
    const context = new Set(tokens([question.text, question.category, question.hint, ...(question.options || []).map(o => o.text)].join(' ')));
    return tokens(message).some(t => context.has(t) || [...context].some(c => c.length > 4 && (c.startsWith(t) || t.startsWith(c))));
  }

  isAnswerSeeking(message) {
    return ANSWER_SEEKING.some(re => re.test(message));
  }

  /**
   * Removes any sentence that could give the answer away: one that contains the correct
   * option's text, names an option letter/position, or pairs an option with a verdict.
   */
  sanitizeReply(reply, question) {
    const options = (question.options || []).map(o => normalize(o.text)).filter(t => t.length >= 3);
    const correct = (question.options || []).find(o => o.id === question.correctOptionId);
    const correctNorm = correct ? normalize(correct.text) : '';
    const verdict = /\b(correct|right|answer|choose|pick|select|best|true|wrong|incorrect|false)\b/i;
    const letterRef = /\b(?:option|choice|answer)\s*\(?[a-f1-6]\)?(?![a-z])|\(\s*[a-f]\s*\)|\b[a-f]\)\s/i;

    const sentences = String(reply || '').split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim());
    let removed = 0;
    const kept = sentences.filter(sentence => {
      const norm = normalize(sentence);
      const mentionsCorrect = correctNorm.length >= 3 && norm.includes(correctNorm);
      const mentionsOption = options.some(o => norm.includes(o));
      const drop = mentionsCorrect || letterRef.test(sentence) || (mentionsOption && verdict.test(sentence));
      if (drop) removed++;
      return !drop;
    });

    let text = kept.join(' ').trim();
    if (removed > 0) {
      text += (text ? '\n\n' : '') + `(${removed === 1 ? 'One sentence was' : `${removed} sentences were`} removed because ${removed === 1 ? 'it' : 'they'} pointed at an option.)`;
    }
    return { text: text || 'I can only explain the idea behind this question, not which option to pick. Try asking about a specific term in the question.', removed };
  }

  /** Offline fallback: the proctor's note for this question plus terms worth revisiting. */
  notesReply(question) {
    const keyTerms = [...new Set(tokens(question.text))].sort((a, b) => b.length - a.length).slice(0, 3);
    const parts = [];
    if (question.hint) parts.push(`Note from your proctor: ${question.hint}`);
    if (keyTerms.length) parts.push(`Start by recalling what ${keyTerms.map(t => `"${t}"`).join(', ')} mean${keyTerms.length === 1 ? 's' : ''} and how they relate to each other.`);
    parts.push('Then read each option and ask whether it is consistent with that definition — rule options out rather than looking for one that "sounds" right.');
    return parts.join('\n\n');
  }

  async askModel(question, history, message) {
    const client = this.getClient();
    if (!client) return null;

    const system = [
      'You are a tutor built into a proctored exam. A student is answering a multiple-choice question and may ask you about the concepts behind it.',
      'Your job is to help them understand the underlying ideas so they can reason it out themselves.',
      'Never say, hint at, rank or evaluate which option is correct. Do not refer to options by letter, number or position, do not repeat option text, and do not work through the question to its conclusion.',
      'Explain general principles, definitions and how to approach this kind of problem, using your own examples that differ from the question.',
      'If the student asks for the answer, briefly say you cannot give it and offer an explanation of the relevant concept instead.',
      'Keep replies under 150 words, in plain language, without headings.'
    ].join(' ');

    const context = `The question the student is working on (for context only — do not solve it):\n${question.text}\n\nThe options exist but are deliberately not shown to you.`;
    const messages = [{ role: 'user', content: context }, { role: 'assistant', content: 'Understood. I will explain concepts only and never point at an answer.' }];
    history.slice(-4).forEach(h => {
      messages.push({ role: 'user', content: h.message });
      messages.push({ role: 'assistant', content: h.reply });
    });
    messages.push({ role: 'user', content: message });

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages
    });

    if (response.stop_reason === 'refusal') return 'I can\'t help with that request. Ask me about a concept in the question instead.';
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  async ask({ sessionId, questionId, message }) {
    const fail = (status, code, msg) => Object.assign(new Error(msg), { status, statusCode: status, error: code });
    const session = sessionId ? datastore.getSession(sessionId) : null;
    if (!session) throw fail(404, 'SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'IN_PROGRESS') throw fail(400, 'SESSION_ENDED', 'The exam has ended.');
    if (session.rules && session.rules.enableGuidedAssistant === false) throw fail(403, 'ASSIST_DISABLED', 'The guided assistant is turned off for this exam.');
    if (!(session.questionIds || []).includes(questionId)) throw fail(400, 'QUESTION_NOT_IN_SESSION', 'That question is not part of your exam.');

    const text = String(message || '').trim().slice(0, 600);
    if (!text) throw fail(400, 'EMPTY_MESSAGE', 'Type a question first.');

    const log = session.assistLog || [];
    const forQuestion = log.filter(e => e.questionId === questionId);
    if (log.length >= MAX_PER_SESSION || forQuestion.length >= MAX_PER_QUESTION) {
      throw fail(429, 'ASSIST_LIMIT', 'You have used all guided help for this question.');
    }

    const question = datastore.getQuestionById(questionId);
    let reply;
    let outcome;
    let removed = 0;
    let source = 'policy';

    if (this.isAnswerSeeking(text)) {
      outcome = 'REFUSED_ANSWER_REQUEST';
      reply = 'I can\'t tell you which option is correct — that\'s the part you need to work out. I can explain any term or idea in the question, though. What part is unclear?';
    } else if (!this.isRelevant(text, question)) {
      outcome = 'REFUSED_OFF_TOPIC';
      reply = 'I can only help with the concepts in the question you\'re on. Ask about a term or idea that appears in it.';
    } else {
      outcome = 'ANSWERED';
      let raw = null;
      try {
        raw = await this.askModel(question, forQuestion.filter(e => e.outcome === 'ANSWERED'), text);
        source = raw ? 'model' : 'notes';
      } catch (err) {
        console.warn('[Assist] Model call failed, using proctor notes:', err.message);
        source = 'notes';
      }
      const clean = this.sanitizeReply(raw || this.notesReply(question), question);
      reply = clean.text;
      removed = clean.removed;
    }

    const entry = { questionId, message: text, reply, outcome, source, removedSentences: removed, at: Date.now() };
    datastore.updateSession(sessionId, { assistLog: [...log, entry] });

    try {
      require('./websocketService').broadcastToProctors({
        type: 'LIVE_LOG_EVENT',
        sessionId,
        studentName: session.candidateName || session.studentId,
        category: 'assist',
        summary: `Guided help (${outcome === 'ANSWERED' ? 'answered' : outcome === 'REFUSED_ANSWER_REQUEST' ? 'refused: asked for the answer' : 'refused: off-topic'}): "${text.slice(0, 90)}"`,
        timestamp: entry.at
      });
    } catch (_) {}

    return {
      reply,
      outcome,
      remainingForQuestion: MAX_PER_QUESTION - forQuestion.length - 1
    };
  }
}

module.exports = new AssistService();
module.exports.AssistService = AssistService;
