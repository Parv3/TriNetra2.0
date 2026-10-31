const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const datastore = require('../db/datastore');
const assessmentService = require('./assessmentService');

const AI_DOMAINS = [
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'anthropic.com',
  'deepseek.com',
  'perplexity.ai',
  'gemini.google.com',
  'copilot.microsoft.com'
];

const AI_SERVICES = [
  'chatgpt',
  'claude',
  'copilot',
  'deepseek',
  'perplexity',
  'gemini',
  'openai'
];

class ProctorService {
  constructor(ds = datastore, as = assessmentService) {
    this.datastore = ds;
    this.assessmentService = as;
  }

  setDataStore(ds) {
    this.datastore = ds;
  }

  setAssessmentService(as) {
    this.assessmentService = as;
  }

  escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async recordViolation(sessionId, payload = {}) {
    if (!sessionId) {
      const err = new Error('Session ID is required');
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const session = this.datastore ? this.datastore.getSession(sessionId) : null;
    if (!session) {
      const err = new Error('Session not found');
      err.status = 404;
      err.statusCode = 404;
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Only submitted or timeout-submitted sessions reject violations
    if (['SUBMITTED', 'AUTO_SUBMITTED_TIMEOUT'].includes(session.status)) {
      const err = new Error(`Cannot record violation on terminated session (${session.status})`);
      err.status = 400;
      err.statusCode = 400;
      err.code = 'SESSION_TERMINATED';
      throw err;
    }

    const snapshotData = payload.snapshotBase64 || payload.snapshot || null;
    if (snapshotData && typeof snapshotData === 'string' && snapshotData.length > 5 * 1024 * 1024) {
      const err = new Error('Snapshot payload exceeds maximum allowed size (5MB)');
      err.status = 413;
      err.statusCode = 413;
      throw err;
    }

    const type = payload.type || 'UNUSUAL_BEHAVIOR';
    const maxStrikes = (typeof session.maxStrikes === 'number' && session.maxStrikes > 0)
      ? session.maxStrikes
      : (config.MAX_STRIKES || 3);

    session.strikeCount = (session.strikeCount || session.strikes || 0) + 1;
    session.strikes = session.strikeCount;

    const violation = {
      id: `viol_${uuidv4().slice(0, 8)}`,
      sessionId,
      candidateId: session.candidateId || session.studentId,
      type,
      severity: payload.severity || (session.strikeCount >= maxStrikes ? 'CRITICAL' : 'WARNING'),
      confidence: typeof payload.confidence === 'number' ? payload.confidence : 1.0,
      message: payload.message || `Proctoring violation: ${type}`,
      details: payload.details || {},
      snapshot: snapshotData,
      hasSnapshot: Boolean(snapshotData),
      strikeNumber: session.strikeCount,
      strikeIndex: session.strikeCount,
      timestamp: payload.timestamp || Date.now()
    };

    if (this.datastore && typeof this.datastore.addViolation === 'function') {
      this.datastore.addViolation(violation);
    }
    if (!session.violations) session.violations = [];
    session.violations.push(violation);

    let action = 'WARN';
    let disqualified = false;
    let reason = null;

    if (session.strikeCount >= maxStrikes || payload.immediateDisqualify || ['DISQUALIFIED', 'DISQUALIFIED_VIOLATIONS'].includes(session.status)) {
      action = 'DISQUALIFY';
      disqualified = true;
      reason = `Exceeded maximum allowed proctoring violations (${maxStrikes}). Assessment automatically terminated.`;

      const targetStatus = session.disqualificationStatus || config.DISQUALIFICATION_STATUS || 'DISQUALIFIED';
      session.status = targetStatus;
      session.submittedAt = session.submittedAt || Date.now();
      session.disqualifiedReason = reason;

      if (this.assessmentService && typeof this.assessmentService.gradeSession === 'function') {
        try {
          this.assessmentService.gradeSession(session);
        } catch (_) {}
      }

      if (this.datastore && typeof this.datastore.updateSession === 'function') {
        this.datastore.updateSession(sessionId, session);
      }
    } else {
      if (this.datastore && typeof this.datastore.updateSession === 'function') {
        this.datastore.updateSession(sessionId, {
          strikeCount: session.strikeCount,
          strikes: session.strikeCount
        });
      }
    }

    return {
      success: true,
      recorded: true,
      violationId: violation.id,
      strikeCount: session.strikeCount,
      totalWarnings: session.strikeCount,
      warningThreshold: maxStrikes,
      action,
      disqualified,
      reason,
      sessionStatus: session.status
    };
  }

  async recordTabActivity(sessionId, payload = {}) {
    if (!sessionId) {
      const err = new Error('Session ID is required');
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const session = this.datastore ? this.datastore.getSession(sessionId) : null;
    const url = payload.url || '';
    let domain = payload.domain || '';

    if (!domain && url) {
      try {
        domain = new URL(url).hostname;
      } catch (_) {
        domain = url;
      }
    }

    const isFlaggedAiTool = Boolean(
      payload.isFlaggedAiTool ||
      AI_DOMAINS.some(d => domain.toLowerCase().includes(d)) ||
      AI_DOMAINS.some(d => url.toLowerCase().includes(d))
    );

    const eventType = payload.eventType || payload.type || 'TAB_SWITCH';
    const tabActivity = {
      id: `tab_act_${uuidv4().slice(0, 8)}`,
      sessionId,
      candidateId: session ? (session.candidateId || session.studentId) : null,
      eventType,
      type: eventType,
      tabId: payload.tabId || 0,
      tabTitle: payload.tabTitle || payload.title || '',
      title: payload.tabTitle || payload.title || '',
      url,
      domain,
      duration: payload.duration || 0,
      queryText: payload.queryText || null,
      isFlaggedAiTool,
      timestamp: payload.timestamp || Date.now()
    };

    if (this.datastore && typeof this.datastore.addTabActivity === 'function') {
      this.datastore.addTabActivity(tabActivity);
    }
    if (session) {
      if (!session.tabEvents) session.tabEvents = [];
      session.tabEvents.push(tabActivity);
    }

    return {
      success: true,
      recorded: true,
      logged: true,
      activityId: tabActivity.id,
      eventId: tabActivity.id,
      isFlaggedAiTool,
      flagged: isFlaggedAiTool
    };
  }

  async recordSearchEvent(sessionId, payload = {}) {
    if (!sessionId || !payload.service) {
      const err = new Error('sessionId and service are required');
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const session = this.datastore ? this.datastore.getSession(sessionId) : null;
    const service = payload.service || 'WebSearch';
    const queryText = payload.query !== undefined ? String(payload.query) : (payload.queryText || '');
    const url = payload.url || '';

    const isFlaggedAiTool = Boolean(
      payload.isFlaggedAiTool ||
      AI_SERVICES.some(s => service.toLowerCase().includes(s)) ||
      AI_DOMAINS.some(d => url.toLowerCase().includes(d))
    );

    const searchEvent = {
      id: `search_${uuidv4().slice(0, 8)}`,
      sessionId,
      candidateId: session ? (session.candidateId || session.studentId) : null,
      eventType: 'AI_SEARCH_QUERY',
      service,
      query: queryText,
      queryText,
      url,
      isFlaggedAiTool,
      blocked: Boolean(payload.blocked),
      blockReason: payload.blockReason || null,
      severity: isFlaggedAiTool ? 'CRITICAL_INTEGRITY' : 'INFO',
      timestamp: payload.timestamp || Date.now()
    };

    if (session) {
      const searchEvents = [...(session.searchEvents || []), searchEvent];
      session.searchEvents = searchEvents;
      if (this.datastore && typeof this.datastore.updateSession === 'function') {
        this.datastore.updateSession(sessionId, { searchEvents });
      }
    }

    return {
      success: true,
      recorded: true,
      logged: true,
      flagged: isFlaggedAiTool,
      isFlaggedAiTool,
      eventId: searchEvent.id
    };
  }

  async recordInputActivity(sessionId, payload = {}) {
    if (!sessionId) {
      const err = new Error('Session ID is required');
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const session = this.datastore ? this.datastore.getSession(sessionId) : null;
    const eventType = payload.eventType || payload.type || 'KEYSTROKE';
    const details = payload.details || payload.data || {};

    const inputEvent = {
      id: `inp_${uuidv4().slice(0, 8)}`,
      sessionId,
      candidateId: session ? (session.candidateId || session.studentId) : null,
      eventType,
      type: eventType,
      details,
      data: details,
      timestamp: payload.timestamp || Date.now()
    };

    if (this.datastore && typeof this.datastore.addInputActivity === 'function') {
      this.datastore.addInputActivity(inputEvent);
    }
    if (session) {
      if (!session.inputEvents) session.inputEvents = [];
      session.inputEvents.push(inputEvent);
    }

    return {
      success: true,
      recorded: true,
      logged: true,
      eventId: inputEvent.id
    };
  }

  /**
   * Groups raw tab navigations and intercepted queries into per-site visits, so a
   * reviewer reads "opened ChatGPT at 10:42, then asked: ..." instead of two flat logs.
   */
  buildBrowsingActivity(tabActivities, searchEvents) {
    const hostOf = (url) => {
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
    };
    const sites = new Map();
    const siteFor = (domain, service, isAi, timestamp) => {
      const key = domain || service || 'unknown';
      if (!sites.has(key)) {
        sites.set(key, {
          domain: key,
          service: service || key,
          isAiTool: false,
          firstSeen: timestamp,
          lastSeen: timestamp,
          visits: 0,
          pages: [],
          queries: []
        });
      }
      const site = sites.get(key);
      site.isAiTool = site.isAiTool || Boolean(isAi);
      site.firstSeen = Math.min(site.firstSeen, timestamp);
      site.lastSeen = Math.max(site.lastSeen, timestamp);
      if (service && site.service === key) site.service = service;
      return site;
    };

    tabActivities.forEach(t => {
      const domain = (t.domain || hostOf(t.url)).replace(/^www\./, '');
      if (!domain || domain === '127.0.0.1' || domain === 'localhost') return;
      const site = siteFor(domain, null, t.isFlaggedAiTool, t.timestamp);
      site.visits++;
      if (t.url && !site.pages.some(p => p.url === t.url)) {
        site.pages.push({ url: t.url, title: t.tabTitle || t.title || '', timestamp: t.timestamp });
      }
    });

    searchEvents.forEach(s => {
      const query = s.query || s.queryText;
      if (!query) return;
      const domain = hostOf(s.url);
      const site = siteFor(domain, s.service, s.isFlaggedAiTool, s.timestamp);
      if (!site.queries.some(q => q.query === query && Math.abs(q.timestamp - s.timestamp) < 2000)) {
        site.queries.push({ query, timestamp: s.timestamp, url: s.url || '', blocked: Boolean(s.blocked), blockReason: s.blockReason || null });
      }
    });

    return Array.from(sites.values())
      .map(site => ({ ...site, queries: site.queries.sort((a, b) => a.timestamp - b.timestamp) }))
      .sort((a, b) => (Number(b.isAiTool) - Number(a.isAiTool)) || (a.firstSeen - b.firstSeen));
  }

  /**
   * Evidence correlation: lines answers up against browsing, camera events, assistant use
   * and timing, so a reviewer sees "changed Q4 12s after searching 'avl rotation'" instead
   * of having to cross-reference four separate logs.
   */
  buildInsights(session, { tabActivities, searchEvents, violations, inputActivities, questionResults }) {
    const LOOKBACK_MS = 90 * 1000;
    const order = session.questionIds || [];
    const qNum = (id) => order.indexOf(id) + 1;
    const fmtSec = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;
    const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url || '') || !url;
    const resultById = new Map((questionResults || []).map(r => [r.questionId, r]));

    // External lookups the candidate made, newest last
    const lookups = [
      ...searchEvents.filter(e => e.query || e.queryText).map(e => {
        const q = String(e.query || e.queryText).slice(0, 60);
        let label = `${e.isFlaggedAiTool ? 'asking' : 'searching'} "${q}" on ${e.service}`;
        if (e.blocked && e.blockReason === 'AI_SITE') label = `trying to open an AI assistant (${q.replace(/^Tried to open /, '')}, blocked)`;
        else if (e.blocked) label = `a blocked search for "${q}"`;
        return { at: e.timestamp, ai: Boolean(e.isFlaggedAiTool), label };
      }),
      ...tabActivities.filter(t => !isLocal(t.url) && !t.queryText).map(t => ({
        at: t.timestamp, ai: Boolean(t.isFlaggedAiTool), label: `opening ${t.domain || t.url}`
      })),
      ...violations.filter(v => v.type === 'LEFT_EXAM_TAB').map(v => ({
        at: v.timestamp, ai: false, label: 'leaving the exam tab'
      }))
    ].sort((a, b) => a.at - b.at);

    const insights = [];
    const answerLog = session.answerLog || [];

    // 1. Answers given or changed shortly after an outside lookup
    answerLog.forEach(entry => {
      const prior = lookups.filter(l => l.at <= entry.at && entry.at - l.at <= LOOKBACK_MS).pop();
      if (!prior) return;
      const changed = Boolean(entry.previousOptionId);
      const res = resultById.get(entry.questionId);
      const verdict = res && res.isCorrect !== undefined && res.selectedOptionId === entry.selectedOptionId
        ? (res.isCorrect ? ' — final answer correct' : ' — final answer incorrect') : '';
      insights.push({
        severity: prior.ai || changed ? 'high' : 'medium',
        kind: changed ? 'ANSWER_CHANGED_AFTER_LOOKUP' : 'ANSWERED_AFTER_LOOKUP',
        questionId: entry.questionId,
        timestamp: entry.at,
        text: `${changed ? 'Changed' : 'Answered'} Q${qNum(entry.questionId)} ${fmtSec(entry.at - prior.at)} after ${prior.label}${verdict}`
      });
    });

    // 2. Answers recorded while the camera had just flagged something
    const cameraFlags = violations.filter(v => ['NO_FACE', 'MULTIPLE_FACES', 'IDENTITY_MISMATCH', 'PHONE_DETECTED', 'EARPIECE_DETECTED', 'OTHER_VOICE', 'MULTIPLE_VOICES'].includes(v.type));
    answerLog.forEach(entry => {
      const flag = cameraFlags.find(v => entry.at >= v.timestamp && entry.at - v.timestamp <= 15000);
      if (flag) {
        insights.push({
          severity: 'high',
          kind: 'ANSWERED_DURING_CAMERA_FLAG',
          questionId: entry.questionId,
          timestamp: entry.at,
          text: `Answered Q${qNum(entry.questionId)} ${fmtSec(entry.at - flag.timestamp)} after the camera flagged "${flag.type.replace(/_/g, ' ').toLowerCase()}"`
        });
      }
    });

    // 3. Time on each question, from QUESTION_VIEW events
    const views = inputActivities
      .filter(i => (i.eventType || i.type) === 'QUESTION_VIEW' && (i.details || i.data || {}).questionId)
      .map(i => ({ questionId: (i.details || i.data).questionId, at: i.timestamp }))
      .sort((a, b) => a.at - b.at);
    const endAt = session.submittedAt || Date.now();
    const timing = new Map();
    views.forEach((v, idx) => {
      const until = idx + 1 < views.length ? views[idx + 1].at : endAt;
      const t = timing.get(v.questionId) || { questionId: v.questionId, number: qNum(v.questionId), dwellMs: 0, views: 0, firstSeen: v.at };
      t.dwellMs += Math.max(0, until - v.at);
      t.views++;
      timing.set(v.questionId, t);
    });
    const questionTimings = order.map(id => {
      const t = timing.get(id) || { questionId: id, number: qNum(id), dwellMs: 0, views: 0, firstSeen: null };
      const changes = answerLog.filter(a => a.questionId === id).length;
      return { ...t, answerChanges: Math.max(0, changes - 1) };
    });

    // 4. Unusually fast answers relative to this candidate's own pace
    const answeredDwell = questionTimings.filter(t => t.dwellMs > 0 && answerLog.some(a => a.questionId === t.questionId)).map(t => t.dwellMs).sort((a, b) => a - b);
    const median = answeredDwell.length ? answeredDwell[Math.floor(answeredDwell.length / 2)] : 0;
    questionTimings.forEach(t => {
      const first = answerLog.find(a => a.questionId === t.questionId);
      if (!first || !t.firstSeen) return;
      const toAnswer = first.at - t.firstSeen;
      if (toAnswer > 0 && toAnswer < 6000 && median > 20000) {
        const res = resultById.get(t.questionId);
        insights.push({
          severity: 'medium',
          kind: 'FAST_ANSWER',
          questionId: t.questionId,
          timestamp: first.at,
          text: `Answered Q${t.number} ${fmtSec(toAnswer)} after first seeing it (typical pace ${fmtSec(median)})${res && res.isCorrect ? ' — correct' : ''}`
        });
      }
    });

    // 5. Repeated attempts to get the answer out of the guided assistant
    const refusals = (session.assistLog || []).filter(e => e.outcome === 'REFUSED_ANSWER_REQUEST');
    if (refusals.length >= 2) {
      insights.push({
        severity: 'medium',
        kind: 'ASSIST_ANSWER_REQUESTS',
        timestamp: refusals[refusals.length - 1].at,
        text: `Asked the guided assistant for the answer ${refusals.length} times`
      });
    }

    const rank = { high: 0, medium: 1, low: 2 };
    insights.sort((a, b) => rank[a.severity] - rank[b.severity] || a.timestamp - b.timestamp);
    return { insights, questionTimings };
  }

  async getAuditReport(sessionId, options = {}) {
    if (!sessionId) {
      const err = new Error('Session ID is required');
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const session = this.datastore ? this.datastore.getSession(sessionId) : null;
    if (!session) {
      const err = new Error('Session not found');
      err.status = 404;
      err.statusCode = 404;
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }

    const candidateId = session.candidateId || session.studentId || 'STU-001';
    let candidate = this.datastore && typeof this.datastore.getCandidateById === 'function'
      ? this.datastore.getCandidateById(candidateId)
      : null;

    if (!candidate) {
      candidate = {
        id: candidateId,
        name: 'Alex Rivera',
        email: 'alex.rivera@university.edu',
        rollNo: 'CS-2026-042',
        baselinePhoto: null
      };
    }

    const rawViolations = (this.datastore && typeof this.datastore.getViolationsBySession === 'function'
      ? this.datastore.getViolationsBySession(sessionId)
      : (session.violations || []));

    const rawTabActivities = (this.datastore && typeof this.datastore.getTabActivitiesBySession === 'function'
      ? this.datastore.getTabActivitiesBySession(sessionId)
      : (session.tabEvents || []));

    const rawInputActivities = (this.datastore && typeof this.datastore.getInputActivitiesBySession === 'function'
      ? this.datastore.getInputActivitiesBySession(sessionId)
      : (session.inputEvents || []));

    const allQuestions = (this.datastore && typeof this.datastore.getAllQuestions === 'function'
      ? this.datastore.getAllQuestions()
      : []);

    const since = options.since ? Number(options.since) : 0;
    const violations = rawViolations.filter(v => v.timestamp >= since);
    const tabActivities = rawTabActivities.filter(t => t.timestamp >= since);
    const inputActivities = rawInputActivities.filter(i => i.timestamp >= since);
    const searchEvents = (session.searchEvents || []).filter(s => s.timestamp >= since);

    // Breakdown violations
    const violationsByType = {};
    violations.forEach(v => {
      violationsByType[v.type] = (violationsByType[v.type] || 0) + 1;
    });

    // Breakdown tabs & search queries
    const aiQueries = [];
    let aiToolVisits = 0;
    let tabSwitches = 0;

    tabActivities.forEach(a => {
      const evType = a.eventType || a.type;
      if (['TAB_SWITCH', 'TAB_NAVIGATE'].includes(evType)) tabSwitches++;
      if (a.isFlaggedAiTool) aiToolVisits++;
      if (a.queryText || a.query || a.eventType === 'AI_SEARCH_QUERY') {
        aiQueries.push({
          service: a.service || a.domain || 'External AI',
          query: a.query || a.queryText || '',
          queryText: a.queryText || a.query || '',
          url: a.url || '',
          timestamp: a.timestamp
        });
      }
    });

    searchEvents.forEach(s => {
      if (s.isFlaggedAiTool) aiToolVisits++;
      aiQueries.push({
        service: s.service,
        query: s.query || s.queryText,
        queryText: s.queryText || s.query,
        url: s.url || '',
        timestamp: s.timestamp
      });
    });

    // Breakdown inputs
    let copyPasteAttempts = 0;
    let mouseLeaves = 0;
    let totalKeystrokes = 0;

    inputActivities.forEach(i => {
      const type = i.eventType || i.type;
      if (['CLIPBOARD', 'COPY_PASTE_ATTEMPT'].includes(type)) {
        copyPasteAttempts++;
      } else if (type === 'MOUSE_LEAVE_WINDOW') {
        mouseLeaves++;
      } else if (['KEYSTROKE', 'KEY_SUMMARY'].includes(type)) {
        const details = i.details || i.data || {};
        totalKeystrokes += details.keyCount ? details.keyCount : 1;
      }
    });

    // Unified Chronological Timeline
    const timeline = [];

    if (session.startedAt) {
      timeline.push({
        type: 'SESSION_START',
        timestamp: session.startedAt,
        title: 'Assessment Session Started',
        description: `Candidate authenticated and started exam (Duration: ${session.durationMinutes}m)`
      });
    }

    const answers = session.answers || {};
    Object.entries(answers).forEach(([qId, ans]) => {
      const selectedOptionId = typeof ans === 'object' ? ans.selectedOptionId : ans;
      const isFlagged = typeof ans === 'object' ? ans.isFlagged : false;
      const savedAt = typeof ans === 'object' ? (ans.savedAt || session.startedAt) : session.startedAt;
      timeline.push({
        type: 'ANSWER_SAVED',
        timestamp: savedAt,
        title: `Question ${qId} Answered`,
        description: `Selected option: ${selectedOptionId || 'none'}${isFlagged ? ' (Flagged for review)' : ''}`
      });
    });

    violations.forEach(v => {
      timeline.push({
        type: 'VIOLATION_RECORDED',
        timestamp: v.timestamp,
        title: `Violation: ${v.type}`,
        description: v.message || `Violation type: ${v.type}`,
        severity: v.severity,
        snapshot: v.snapshot
      });
    });

    tabActivities.forEach(t => {
      timeline.push({
        type: t.isFlaggedAiTool ? 'AI_TOOL_INTERACTION' : 'TAB_NAVIGATION',
        timestamp: t.timestamp,
        title: t.isFlaggedAiTool ? `AI Tool Detected: ${t.domain || t.service || 'External AI'}` : `Tab Event: ${t.eventType || t.type}`,
        description: t.queryText ? `Prompt query: "${t.queryText}"` : (t.url || t.tabTitle || t.title || 'External navigation')
      });
    });

    searchEvents.forEach(s => {
      timeline.push({
        type: 'AI_SEARCH_QUERY',
        timestamp: s.timestamp,
        title: `Search / AI Query: ${s.service}`,
        description: `Prompt query: "${s.query || s.queryText}"`
      });
    });

    inputActivities.forEach(i => {
      const type = i.eventType || i.type;
      const details = i.details || i.data || {};
      if (['CLIPBOARD', 'COPY_PASTE_ATTEMPT'].includes(type)) {
        timeline.push({
          type: 'CLIPBOARD_ACTIVITY',
          timestamp: i.timestamp,
          title: 'Copy/Paste Attempt',
          description: `Action: ${details.action || 'paste'} (${details.textLength || 0} chars)`
        });
      }
    });

    (session.proctorActions || []).forEach(a => {
      timeline.push({
        type: 'PROCTOR_ACTION',
        timestamp: a.at,
        title: a.action === 'RESUMED' ? 'Resumed by proctor' : 'Terminated by proctor',
        description: [a.reason, a.warningsReset ? 'warnings reset' : null, a.extraMinutes ? `+${a.extraMinutes} min` : null].filter(Boolean).join(' · ')
      });
    });

    if (session.submittedAt) {
      timeline.push({
        type: 'SESSION_TERMINATED',
        timestamp: session.submittedAt,
        title: ['DISQUALIFIED_VIOLATIONS', 'DISQUALIFIED'].includes(session.status)
          ? 'Disqualified for Infractions'
          : (session.status === 'AUTO_SUBMITTED_TIMEOUT' ? 'Auto-Submitted (Timeout)' : 'Assessment Submitted'),
        description: session.disqualifiedReason || `Session finalized with status ${session.status}`
      });
    }

    // Sort ascending by timestamp
    timeline.sort((a, b) => a.timestamp - b.timestamp);

    // Algorithmic Integrity Score
    let score = 100;
    const flags = [];

    const violationPenalty = violations.length * 15;
    score -= violationPenalty;
    if (violations.length > 0) {
      flags.push(`${violations.length} Proctoring violation(s) recorded`);
    }

    const aiPenalty = aiToolVisits * 25;
    score -= aiPenalty;
    if (aiToolVisits > 0) {
      flags.push(`Accessed unauthorized AI tools or prompt search ${aiToolVisits} time(s)`);
    }

    const copyPenalty = copyPasteAttempts * 10;
    score -= copyPenalty;
    if (copyPasteAttempts > 0) {
      flags.push(`${copyPasteAttempts} Clipboard copy/paste attempt(s) detected`);
    }

    const tabPenalty = Math.min(20, tabSwitches * 3);
    score -= tabPenalty;
    if (tabSwitches > 2) {
      flags.push(`High tab switching frequency (${tabSwitches} switches)`);
    }

    score = Math.max(0, Math.min(100, score));

    if (['DISQUALIFIED_VIOLATIONS', 'DISQUALIFIED'].includes(session.status)) {
      score = Math.min(30, score);
      flags.push('Auto-disqualified due to repeated infractions');
    }

    let rating = 'LOW_RISK';
    if (score < 60 || ['DISQUALIFIED_VIOLATIONS', 'DISQUALIFIED'].includes(session.status)) {
      rating = 'HIGH_RISK';
    } else if (score < 85) {
      rating = 'MEDIUM_RISK';
    }

    const isInProgress = session.status === 'IN_PROGRESS';

    // Question evaluations (sanitized during active assessment)
    const questionResults = (session.questionIds || allQuestions.map(q => q.id)).map(qId => {
      const q = allQuestions.find(item => item.id === qId) || { id: qId, prompt: 'Question ' + qId, text: 'Question ' + qId };
      const ans = answers[qId];
      const selectedOptionId = ans ? (typeof ans === 'object' ? ans.selectedOptionId : ans) : null;
      const isAttempted = Boolean(selectedOptionId);
      const isCorrect = isInProgress ? false : (isAttempted && selectedOptionId === q.correctOptionId);
      const marks = typeof q.marks === 'number' ? q.marks : 1;
      const negativeMarks = typeof q.negativeMarks === 'number' ? q.negativeMarks : 0;

      const item = {
        questionId: qId,
        prompt: q.prompt || q.text,
        text: q.text || q.prompt,
        options: (q.options || []).map(opt => ({
          id: opt.id,
          text: opt.text
        })),
        selectedOptionId,
        isAttempted
      };

      if (!isInProgress) {
        item.correctOptionId = q.correctOptionId;
        item.isCorrect = isCorrect;
        item.explanation = q.explanation || '';
        item.marksAwarded = isCorrect ? marks : (isAttempted ? -negativeMarks : 0);
      }

      return item;
    });

    const sessionSummary = {
      id: session.id || session.sessionId,
      sessionId: session.id || session.sessionId,
      studentId: candidate.id,
      candidateId: candidate.id,
      status: session.status,
      resumeCount: session.resumeCount || 0,
      proctorActions: session.proctorActions || [],
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      submittedAt: session.submittedAt || null,
      durationMinutes: session.durationMinutes,
      strikeCount: session.strikeCount || session.strikes || 0,
      score: isInProgress ? null : (session.score !== null ? session.score : 0),
      maxScore: session.maxScore || session.total || 20,
      total: session.maxScore || session.total || 20,
      accuracy: isInProgress ? null : (session.accuracy || 0),
      correctCount: isInProgress ? null : (session.correctCount || 0),
      incorrectCount: isInProgress ? null : (session.incorrectCount || 0),
      unattemptedCount: session.unattemptedCount || 0
    };

    return {
      candidate: {
        id: candidate.id,
        name: candidate.name,
        email: candidate.email,
        rollNo: candidate.rollNo,
        baselinePhoto: candidate.baselinePhoto || candidate.photoBase64 || null
      },
      browsingActivity: this.buildBrowsingActivity(tabActivities, searchEvents),
      ...this.buildInsights(session, { tabActivities, searchEvents, violations, inputActivities, questionResults }),
      assistLog: (session.assistLog || []).map(e => ({ ...e, questionNumber: (session.questionIds || []).indexOf(e.questionId) + 1 })),
      session: sessionSummary,
      summary: {
        totalViolations: violations.length,
        totalTabSwitches: tabSwitches,
        totalSearchQueries: searchEvents.length || aiQueries.length,
        totalInputBursts: inputActivities.length
      },
      violationSummary: {
        totalViolations: violations.length,
        byType: violationsByType,
        violations
      },
      tabActivitySummary: {
        totalTabSwitches: tabSwitches,
        totalUrlsVisited: tabActivities.length,
        aiToolVisits,
        aiQueries,
        activities: tabActivities
      },
      inputSummary: {
        copyPasteAttempts,
        mouseLeaves,
        totalKeystrokes,
        activities: inputActivities
      },
      integrityScore: {
        score,
        rating,
        flags
      },
      violations,
      tabEvents: tabActivities,
      searchEvents,
      inputEvents: inputActivities,
      questionResults,
      results: isInProgress ? questionResults : (session.results || questionResults),
      timeline
    };
  }

  generateHtmlReport(report) {
    const { candidate, session, violationSummary, tabActivitySummary, inputSummary, integrityScore, timeline, questionResults } = report;

    const riskBadgeColor = integrityScore.rating === 'LOW_RISK' ? '#16a34a' : (integrityScore.rating === 'MEDIUM_RISK' ? '#d97706' : '#dc2626');
    const statusBadgeColor = session.status === 'SUBMITTED' ? '#16a34a' : (session.status.includes('DISQUALIFIED') ? '#dc2626' : '#d97706');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Proctoring Audit Trail & Certificate — ${session.sessionId || session.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      line-height: 1.5;
      padding: 32px 20px;
    }
    .container { max-width: 1040px; margin: 0 auto; }
    .header-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 20px;
    }
    .stat-title { font-size: 13px; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #f8fafc; }
    .section-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .section-title { font-size: 18px; font-weight: 700; color: #f8fafc; margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    .snapshot-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .snapshot-card {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      overflow: hidden;
    }
    .snapshot-card img { width: 100%; height: 160px; object-fit: cover; display: block; background: #000; }
    .snapshot-meta { padding: 10px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #94a3b8; font-weight: 600; }
    .timeline-item {
      position: relative;
      padding-left: 28px;
      margin-bottom: 18px;
    }
    .timeline-item::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 6px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #38bdf8;
    }
    .timeline-item::after {
      content: '';
      position: absolute;
      left: 10px;
      top: 20px;
      width: 2px;
      bottom: -18px;
      background: #334155;
    }
    .timeline-item:last-child::after { display: none; }
    @media print {
      body { background: #fff !important; color: #000 !important; padding: 0 !important; }
      .header-card, .stat-card, .section-card, .snapshot-card { border: 1px solid #ccc !important; background: #fff !important; color: #000 !important; }
      th { background: #eee !important; color: #000 !important; }
      .stat-value, .stat-title, .section-title { color: #000 !important; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div>
        <h1>Proctoring Audit Trail</h1>
        <h2 style="font-size: 18px; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Smart Proctoring Audit Certificate</h2>
        <p style="color: #94a3b8; font-size: 14px;">Session ID: <code>${session.sessionId || session.id}</code> &bull; Candidate: <strong>${this.escapeHtml(candidate.name)}</strong> (${this.escapeHtml(candidate.id)})</p>
      </div>
      <div>
        <span class="badge" style="background: ${statusBadgeColor};">${session.status}</span>
        <span class="badge" style="background: ${riskBadgeColor};">${integrityScore.rating}</span>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">Integrity Rating</div>
        <div class="stat-value" style="color: ${riskBadgeColor};">${integrityScore.score} / 100</div>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Tier: ${integrityScore.rating}</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Assessment Score</div>
        <div class="stat-value">${session.score} / ${session.maxScore || session.total}</div>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Accuracy: ${session.accuracy}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">Proctor Warnings</div>
        <div class="stat-value" style="color: ${session.strikeCount > 0 ? '#f59e0b' : '#10b981'};">${session.strikeCount}</div>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Max Allowed: 5 Strikes</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">External Tab & AI Tool Visits</div>
        <div class="stat-value">${tabActivitySummary.totalTabSwitches}</div>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">AI Tools: ${tabActivitySummary.aiToolVisits} | Copy/Paste: ${inputSummary.copyPasteAttempts}</div>
      </div>
    </div>

    <!-- Candidate Profile -->
    <div class="section-card">
      <div class="section-title">Candidate & Verification Profile</div>
      <div style="display: flex; gap: 24px; align-items: center; flex-wrap: wrap;">
        ${candidate.baselinePhoto ? `<img src="${candidate.baselinePhoto}" alt="Baseline Photo" style="width: 110px; height: 110px; border-radius: 8px; object-fit: cover; border: 2px solid #38bdf8;" />` : `<div style="width: 110px; height: 110px; border-radius: 8px; background: #334155; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #94a3b8;">No Photo</div>`}
        <div style="flex: 1;">
          <p style="margin-bottom: 6px;"><strong>Name:</strong> ${this.escapeHtml(candidate.name)}</p>
          <p style="margin-bottom: 6px;"><strong>Roll Number:</strong> ${this.escapeHtml(candidate.rollNo)}</p>
          <p style="margin-bottom: 6px;"><strong>Email:</strong> ${this.escapeHtml(candidate.email)}</p>
          <p><strong>Session Started:</strong> ${new Date(session.startedAt).toLocaleString()}</p>
        </div>
      </div>
    </div>

    <!-- Violation Snapshots -->
    <div class="section-card">
      <div class="section-title">Violation Snapshots Gallery (${violationSummary.totalViolations})</div>
      ${violationSummary.violations.length === 0 ? `<p style="color: #94a3b8;">No suspicious behavior or proctoring infractions detected.</p>` : `
        <div class="snapshot-gallery">
          ${violationSummary.violations.map(v => `
            <div class="snapshot-card">
              ${v.snapshot ? `<img src="${v.snapshot}" alt="${this.escapeHtml(v.type)}" />` : `<div style="height: 160px; background: #1e293b; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #94a3b8;">No Snapshot Image</div>`}
              <div class="snapshot-meta">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <strong style="color: #ef4444;">${this.escapeHtml(v.type)}</strong>
                  <span>Strike #${v.strikeNumber || v.strikeIndex}</span>
                </div>
                <div style="color: #94a3b8; font-size: 11px;">${new Date(v.timestamp).toLocaleTimeString()} &bull; Conf: ${Math.round((v.confidence || 1) * 100)}%</div>
                <div style="margin-top: 4px;">${this.escapeHtml(v.message)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <!-- Search & AI Tool Intelligence -->
    <div class="section-card">
      <div class="section-title">Search & AI Query Intelligence (${tabActivitySummary.aiQueries.length})</div>
      ${tabActivitySummary.aiQueries.length === 0 ? `<p style="color: #94a3b8;">No search engine or AI tool queries extracted during the session.</p>` : `
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Service</th>
              <th>Extracted Prompt / Query</th>
              <th>Flagged</th>
            </tr>
          </thead>
          <tbody>
            ${tabActivitySummary.aiQueries.map(q => `
              <tr>
                <td>${new Date(q.timestamp).toLocaleTimeString()}</td>
                <td><strong>${this.escapeHtml(q.service)}</strong></td>
                <td><code>${this.escapeHtml(q.query || q.queryText)}</code></td>
                <td><span class="badge" style="background: #dc2626;">FLAGGED AI</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <!-- Chronological Audit Timeline -->
    <div class="section-card">
      <div class="section-title">Chronological Audit Timeline (${timeline.length} Events)</div>
      <div style="margin-top: 16px;">
        ${timeline.map(item => `
          <div class="timeline-item">
            <div style="font-size: 12px; color: #94a3b8;">${new Date(item.timestamp).toLocaleTimeString()}</div>
            <div style="font-weight: 600; color: #f8fafc;">${this.escapeHtml(item.title)}</div>
            <div style="font-size: 13px; color: #cbd5e1;">${this.escapeHtml(item.description)}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Question Response Breakdown -->
    <div class="section-card">
      <div class="section-title">Question Breakdown & Evaluation (${questionResults.length})</div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Question Prompt</th>
            <th>Candidate Choice</th>
            ${session.status === 'IN_PROGRESS' ? '<th>Status</th>' : '<th>Correct Key</th><th>Result</th><th>Marks</th>'}
          </tr>
        </thead>
        <tbody>
          ${questionResults.map((q, idx) => `
            <tr>
              <td><strong>${idx + 1}</strong></td>
              <td>${this.escapeHtml(q.prompt || q.text)}</td>
              <td>${this.escapeHtml(q.selectedOptionId || '<em style="color:#94a3b8">Unattempted</em>')}</td>
              ${session.status === 'IN_PROGRESS' 
                ? `<td>${q.isAttempted ? '<span style="color:#38bdf8; font-weight:600;">RECORDED</span>' : '<span style="color:#94a3b8;">PENDING</span>'}</td>`
                : `<td><strong>${this.escapeHtml(q.correctOptionId || '')}</strong></td>
                   <td>${q.isCorrect ? '<span style="color:#22c55e; font-weight:600;">CORRECT</span>' : (q.isAttempted ? '<span style="color:#ef4444; font-weight:600;">INCORRECT</span>' : '<span style="color:#94a3b8;">SKIPPED</span>')}</td>
                   <td>${q.marksAwarded !== undefined ? q.marksAwarded : '-'}</td>`
              }
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Admin / Proctor Dashboard: Get summary of all sessions with metrics
   */
  async getAllSessionsSummary(filters = {}) {
    if (!this.datastore) return [];

    const rawSessions = this.datastore.getAllSessions();
    const summaries = [];

    for (const session of rawSessions) {
      const studentId = session.studentId;
      const candidate = this.datastore.getCandidateById ? this.datastore.getCandidateById(studentId) : null;
      const violations = this.datastore.getViolationsBySession ? this.datastore.getViolationsBySession(session.id) : [];
      const tabActivities = this.datastore.getTabActivitiesBySession ? this.datastore.getTabActivitiesBySession(session.id) : [];
      const inputActivities = this.datastore.getInputActivitiesBySession ? this.datastore.getInputActivitiesBySession(session.id) : [];

      const aiQueries = tabActivities.filter(t => t.isFlaggedAiTool || (t.details && t.details.isFlaggedAiTool) || t.type === 'AI_SEARCH_INTERCEPT');
      const tabSwitches = tabActivities.filter(t => t.type === 'TAB_SWITCH');
      const copyPaste = inputActivities.filter(i => i.type === 'CLIPBOARD');

      // Compute Integrity Score
      let score = 100;
      score -= violations.length * 15;
      score -= aiQueries.length * 25;
      score -= copyPaste.length * 10;
      score -= Math.min(20, tabSwitches.length * 3);
      score = Math.max(0, Math.min(100, score));

      if (['DISQUALIFIED_VIOLATIONS', 'DISQUALIFIED'].includes(session.status)) {
        score = Math.min(30, score);
      }

      let rating = 'LOW_RISK';
      if (score < 45 || session.status.includes('DISQUALIFIED')) {
        rating = 'HIGH_RISK';
      } else if (score < 75) {
        rating = 'MEDIUM_RISK';
      }

      const answersCount = Object.keys(session.answers || {}).length;

      const summary = {
        id: session.id,
        sessionId: session.id,
        studentId: session.studentId,
        candidateName: candidate ? candidate.name : (session.studentName || session.studentId),
        candidateEmail: candidate ? candidate.email : '—',
        hasPhoto: !!(candidate && candidate.photoBase64),
        status: session.status || 'IN_PROGRESS',
        score: session.score ?? null,
        maxScore: session.maxScore || session.total || 10,
        percentage: (session.score !== undefined && session.score !== null && (session.maxScore || session.total))
          ? Math.round((session.score / (session.maxScore || session.total)) * 100)
          : null,
        answersCount,
        strikeCount: session.strikeCount || 0,
        maxStrikes: session.maxStrikes || config.MAX_STRIKES || 3,
        violationsCount: violations.length,
        aiQueriesCount: aiQueries.length,
        tabSwitchesCount: tabSwitches.length,
        copyPasteCount: copyPaste.length,
        integrityScore: score,
        integrityRating: rating,
        startedAt: session.startedAt || session.createdAt || null,
        expiresAt: session.expiresAt || null,
        submittedAt: session.submittedAt || null,
        lastActiveAt: session.lastActiveAt || session.updatedAt || session.startedAt || Date.now()
      };

      // Apply Filters
      if (filters.status && filters.status !== 'ALL') {
        if (filters.status === 'ACTIVE' && summary.status !== 'IN_PROGRESS') continue;
        if (filters.status === 'SUBMITTED' && !['SUBMITTED', 'COMPLETED', 'AUTO_SUBMITTED_TIMEOUT'].includes(summary.status)) continue;
        if (filters.status === 'DISQUALIFIED' && !summary.status.includes('DISQUALIFIED')) continue;
      }

      if (filters.examId && filters.examId !== 'ALL' && session.examId !== filters.examId) continue;

      if (filters.risk && filters.risk !== 'ALL') {
        if (summary.integrityRating !== filters.risk) continue;
      }

      if (filters.search) {
        const query = filters.search.toLowerCase().trim();
        const matchesId = summary.studentId && summary.studentId.toLowerCase().includes(query);
        const matchesName = summary.candidateName && summary.candidateName.toLowerCase().includes(query);
        const matchesSession = summary.id && summary.id.toLowerCase().includes(query);
        if (!matchesId && !matchesName && !matchesSession) continue;
      }

      summaries.push(summary);
    }

    // Sort: Live/In-progress first, then newest startedAt
    summaries.sort((a, b) => {
      if (a.status === 'IN_PROGRESS' && b.status !== 'IN_PROGRESS') return -1;
      if (b.status === 'IN_PROGRESS' && a.status !== 'IN_PROGRESS') return 1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    return summaries;
  }

  /**
   * Admin / Proctor Dashboard: High-level analytics overview
   */
  async getOverviewStats() {
    if (!this.datastore) {
      return {
        totalSessions: 0,
        activeSessions: 0,
        submittedSessions: 0,
        disqualifiedSessions: 0,
        totalViolations: 0,
        totalAiQueries: 0,
        averageScore: 0,
        averageIntegrity: 100
      };
    }

    const sessions = await this.getAllSessionsSummary();
    const totalSessions = sessions.length;
    const activeSessions = sessions.filter(s => s.status === 'IN_PROGRESS').length;
    const submittedSessions = sessions.filter(s => ['SUBMITTED', 'COMPLETED', 'AUTO_SUBMITTED_TIMEOUT'].includes(s.status)).length;
    const disqualifiedSessions = sessions.filter(s => s.status.includes('DISQUALIFIED')).length;

    let totalViolations = 0;
    let totalAiQueries = 0;
    let scoreSum = 0;
    let scoredCount = 0;
    let integritySum = 0;

    for (const s of sessions) {
      totalViolations += s.violationsCount || 0;
      totalAiQueries += s.aiQueriesCount || 0;
      integritySum += s.integrityScore;
      if (s.score !== null && s.score !== undefined) {
        scoreSum += s.percentage !== null ? s.percentage : (s.score * 10);
        scoredCount++;
      }
    }

    return {
      totalSessions,
      activeSessions,
      submittedSessions,
      disqualifiedSessions,
      totalViolations,
      totalAiQueries,
      averageScore: scoredCount > 0 ? Math.round(scoreSum / scoredCount) : 0,
      averageIntegrity: totalSessions > 0 ? Math.round(integritySum / totalSessions) : 100
    };
  }

  /**
   * Admin Intervention: Disqualify, issue warning or append note
   */
  async performSessionAction(sessionId, action, details = {}) {
    if (!this.datastore) throw new Error('DataStore not available');
    const session = this.datastore.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (action === 'DISQUALIFY') {
      session.status = 'DISQUALIFIED_MANUAL';
      session.disqualifiedReason = details.reason || 'Terminated by Proctor';
      session.disqualifiedAt = Date.now();
      session.proctorActions = [...(session.proctorActions || []), { action: 'TERMINATED', at: session.disqualifiedAt, reason: session.disqualifiedReason }];
      session.strikeCount = 3;

      this.datastore.addViolation({
        sessionId,
        type: 'MANUAL_DISQUALIFICATION',
        severity: 'TERMINATION',
        details: { proctorReason: details.reason || 'Manually terminated from Proctor Dashboard' },
        timestamp: Date.now()
      });

      if (this.datastore.updateSession) {
        this.datastore.updateSession(sessionId, session);
      }
      return { success: true, action: 'DISQUALIFY', session };
    }

    if (action === 'WARN') {
      session.strikeCount = (session.strikeCount || 0) + 1;
      this.datastore.addViolation({
        sessionId,
        type: 'PROCTOR_MANUAL_WARNING',
        severity: 'HIGH',
        details: { proctorMessage: details.message || 'Direct proctor attention flag' },
        timestamp: Date.now()
      });

      if (session.strikeCount >= 3) {
        session.status = 'DISQUALIFIED_VIOLATIONS';
        session.disqualifiedAt = Date.now();
      }

      if (this.datastore.updateSession) {
        this.datastore.updateSession(sessionId, session);
      }
      return { success: true, action: 'WARN', strikeCount: session.strikeCount, session };
    }

    if (action === 'RESUME') {
      const terminated = String(session.status || '').startsWith('DISQUALIFIED');
      if (!terminated) {
        const err = new Error('Only a terminated attempt can be resumed.');
        err.status = 400;
        throw err;
      }
      const now = Date.now();
      const lockedAt = session.disqualifiedAt || session.submittedAt || now;
      // Give back the time the candidate spent locked out, plus any extra the proctor grants.
      const extraMs = Math.max(0, Math.min(Number(details.extraMinutes) || 0, 120)) * 60000;
      const remainingBefore = Math.max(0, (session.expiresAt || now) - lockedAt);
      const expiresAt = now + Math.max(remainingBefore, 60000) + extraMs;
      const resetWarnings = details.resetWarnings !== false;

      const entry = {
        action: 'RESUMED',
        at: now,
        reason: String(details.reason || '').slice(0, 300) || 'Resumed by proctor',
        previousStatus: session.status,
        previousReason: session.disqualifiedReason || null,
        warningsReset: resetWarnings,
        extraMinutes: extraMs / 60000
      };
      const updates = {
        status: 'IN_PROGRESS',
        expiresAt,
        submittedAt: null,
        disqualifiedAt: null,
        disqualifiedReason: null,
        score: null,
        resumeCount: (session.resumeCount || 0) + 1,
        proctorActions: [...(session.proctorActions || []), entry]
      };
      if (resetWarnings) {
        updates.strikeCount = 0;
        updates.strikes = 0;
      }
      const updated = this.datastore.updateSession(sessionId, updates);
      return { success: true, action: 'RESUME', session: updated, expiresAt, strikeCount: updated.strikeCount || 0 };
    }

    throw new Error(`Unsupported proctor action: ${action}`);
  }
}

const proctorService = new ProctorService();
module.exports = proctorService;
module.exports.ProctorService = ProctorService;
module.exports.proctorService = proctorService;
