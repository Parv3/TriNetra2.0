const crypto = require('crypto');
const datastore = require('../db/datastore');
const config = require('../config');

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class AssessmentService {
  constructor(ds = datastore) {
    this.datastore = ds;
    this.DEFAULT_DURATION_MINUTES = config.DEFAULT_DURATION_MINUTES || 10;
    this.gracePeriodMs = config.GRACE_PERIOD_MS || 2000;
  }

  setDataStore(ds) {
    this.datastore = ds;
  }

  sanitizeQuestion(question) {
    if (!question) return null;
    const { correctOptionId, explanation, hint, ...sanitized } = question;
    return {
      ...sanitized,
      text: sanitized.text || sanitized.prompt,
      prompt: sanitized.prompt || sanitized.text,
      options: Array.isArray(sanitized.options)
        ? sanitized.options.map(opt => ({ id: opt.id, text: opt.text }))
        : []
    };
  }

  getAllSanitizedQuestions() {
    const questions = this.datastore && typeof this.datastore.getAllQuestions === 'function'
      ? this.datastore.getAllQuestions()
      : [];
    return questions.map(q => this.sanitizeQuestion(q));
  }

  startSession(candidateId = 'STU-001', durationMinutes, options = {}) {
    let opts = options || {};
    if (typeof candidateId === 'object' && candidateId !== null) {
      opts = candidateId;
      candidateId = opts.candidateId || opts.studentId || 'STU-001';
      durationMinutes = opts.durationMinutes !== undefined ? opts.durationMinutes : durationMinutes;
    }

    const rawDuration = durationMinutes !== undefined ? Number(durationMinutes) : this.DEFAULT_DURATION_MINUTES;
    if (isNaN(rawDuration) || rawDuration < 0) {
      const err = new Error('durationMinutes must be a non-negative number');
      err.status = 400;
      err.statusCode = 400;
      err.error = 'INVALID_DURATION';
      throw err;
    }

    // Concurrent-login guard. Only enforced for clients that identify their device
    // (the desktop shell always does), so headless API callers keep the old behaviour.
    const deviceId = opts.deviceId ? String(opts.deviceId).slice(0, 128) : null;
    if (deviceId) {
      const live = this.findLiveSessionForCandidate(candidateId);
      if (live) {
        if (live.deviceId === deviceId) {
          return this.buildStartResponse(live, { resumed: true });
        }
        this.flagConcurrentLogin(live, deviceId);
        const err = new Error('This candidate already has an assessment in progress on another device. The attempt has been reported to the proctor.');
        err.status = 409;
        err.statusCode = 409;
        err.error = 'CONCURRENT_SESSION';
        throw err;
      }
    }

    const duration = Math.min(Math.max(rawDuration, 0), 180);
    const now = Date.now();
    const durationMs = duration * 60 * 1000;
    const expiresAt = now + durationMs;
    const hrtimeStart = process.hrtime.bigint().toString();
    const sessionId = 'sess_' + crypto.randomUUID();

    const examId = opts.examId || null;
    const examRecord = examId && this.datastore && typeof this.datastore.getExam === 'function'
      ? this.datastore.getExam(examId)
      : null;
    if (examRecord && (examRecord.status || 'OPEN') !== 'OPEN') {
      const err = new Error('This exam is closed to new candidates.');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'EXAM_CLOSED';
      throw err;
    }

    // Real exams carry their own questions; the global bank only exists for the test suite.
    const examQuestions = examRecord && Array.isArray(examRecord.questions) && examRecord.questions.length > 0
      ? examRecord.questions
      : null;
    const allQuestions = examQuestions || (this.datastore && typeof this.datastore.getAllQuestions === 'function'
      ? this.datastore.getAllQuestions()
      : []);
    // Every candidate gets their own question and option order, so neighbours can't share "the answer to 3 is B".
    const questionIds = examQuestions ? shuffle(allQuestions.map(q => q.id)) : allQuestions.map(q => q.id);
    const optionOrder = {};
    if (examQuestions) {
      allQuestions.forEach(q => { optionOrder[q.id] = shuffle((q.options || []).map(o => o.id)); });
    }
    let examRules = {
      enableVisionProctoring: true,
      enableMultiTab: true,
      enableAiGuard: true,
      enableClipboardProtection: true,
      enableGuidedAssistant: true,
      maxStrikes: 3
    };

    if (this.datastore && typeof this.datastore.getExam === 'function') {
      const exam = this.datastore.getExam(examId);
      if (exam && exam.rules) {
        examRules = { ...examRules, ...exam.rules };
      }
    }

    let candidateName = candidateId || 'STU-001';
    let candidatePhoto = null;
    if (this.datastore && typeof this.datastore.getCandidateById === 'function') {
      const cand = this.datastore.getCandidateById(candidateId);
      if (cand) {
        candidateName = cand.name || candidateId;
        candidatePhoto = cand.photoBase64 || null;
      }
    }

    const session = {
      id: sessionId,
      sessionId: sessionId,
      candidateId: candidateId || 'STU-001',
      studentId: candidateId || 'STU-001',
      candidateName: candidateName,
      studentName: candidateName,
      photoBase64: candidatePhoto,
      examId: examId,
      rules: examRules,
      status: 'IN_PROGRESS',
      startedAt: now,
      durationMinutes: duration,
      expiresAt: expiresAt,
      hrtimeStart: hrtimeStart,
      questionIds: questionIds,
      optionOrder,
      answerLog: [],
      answers: {},
      flaggedQuestions: [],
      violations: [],
      tabEvents: [],
      searchEvents: [],
      inputEvents: [],
      strikeCount: 0,
      strikes: 0,
      maxStrikes: (typeof opts.maxStrikes === 'number' && opts.maxStrikes > 0)
        ? opts.maxStrikes
        : (examRules.maxStrikes || config.MAX_STRIKES || 3),
      score: null,
      total: questionIds.length,
      deviceId,
      createdAt: now
    };

    if (this.datastore && typeof this.datastore.createSession === 'function') {
      this.datastore.createSession(session);
    }

    const sanitizedQuestions = this.orderedQuestionsFor(session);

    return {
      success: true,
      examTitle: examRecord ? examRecord.title : null,
      sessionId: session.id,
      examId: session.examId,
      maxStrikes: examRules.maxStrikes || 3,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      durationMinutes: session.durationMinutes,
      rules: examRules,
      session: {
        id: session.id,
        sessionId: session.id,
        examId: session.examId,
        rules: examRules,
        status: session.status,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        durationMinutes: session.durationMinutes,
        totalQuestions: questionIds.length
      },
      questions: sanitizedQuestions
    };
  }

  /** Sanitized questions in this session's order, with options in this session's order. */
  orderedQuestionsFor(session) {
    const byId = new Map((this.datastore ? this.datastore.getAllQuestions() : []).map(q => [q.id, q]));
    const ids = session.questionIds || [];
    return ids.map(id => byId.get(id)).filter(Boolean).map(q => {
      const clean = this.sanitizeQuestion(q);
      const order = session.optionOrder && session.optionOrder[q.id];
      if (order) {
        clean.options = order.map(optId => clean.options.find(o => o.id === optId)).filter(Boolean);
      }
      return clean;
    });
  }

  findLiveSessionForCandidate(candidateId) {
    if (!this.datastore || typeof this.datastore.getAllSessions !== 'function') return null;
    const now = Date.now();
    return this.datastore.getAllSessions().find(s =>
      s.status === 'IN_PROGRESS' &&
      (s.candidateId === candidateId || s.studentId === candidateId) &&
      s.expiresAt > now
    ) || null;
  }

  flagConcurrentLogin(session, deviceId) {
    const violation = {
      id: 'viol_' + crypto.randomUUID().slice(0, 8),
      sessionId: session.id,
      candidateId: session.candidateId,
      type: 'CONCURRENT_LOGIN',
      severity: 'CRITICAL',
      confidence: 1.0,
      message: 'A second device tried to start this candidate\'s assessment while it was in progress',
      details: { attemptedDeviceId: deviceId },
      snapshot: null,
      hasSnapshot: false,
      timestamp: Date.now()
    };
    if (typeof this.datastore.addViolation === 'function') {
      this.datastore.addViolation(violation);
    }
    if (!session.violations) session.violations = [];
    session.violations.push(violation);
  }

  buildStartResponse(session, extra = {}) {
    const ids = session.questionIds || [];
    const questions = this.orderedQuestionsFor(session);
    const answers = {};
    Object.entries(session.answers || {}).forEach(([qId, ans]) => {
      answers[qId] = typeof ans === 'object' && ans !== null ? ans.selectedOptionId : ans;
    });
    return {
      success: true,
      ...extra,
      sessionId: session.id,
      examId: session.examId,
      maxStrikes: session.maxStrikes,
      strikeCount: session.strikeCount || 0,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      durationMinutes: session.durationMinutes,
      rules: session.rules,
      answers,
      session: {
        id: session.id,
        sessionId: session.id,
        examId: session.examId,
        rules: session.rules,
        status: session.status,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        durationMinutes: session.durationMinutes,
        totalQuestions: ids.length
      },
      questions
    };
  }

  getSession(sessionId) {
    if (!sessionId || !this.datastore) return null;
    return this.datastore.getSession(sessionId);
  }

  getSessionQuestions(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error('Assessment session not found.');
      err.status = 404;
      err.statusCode = 404;
      err.error = 'SESSION_NOT_FOUND';
      throw err;
    }

    const allQuestions = this.datastore ? this.datastore.getAllQuestions() : [];
    const sessionQuestions = session.questionIds && session.questionIds.length > 0
      ? allQuestions.filter(q => session.questionIds.includes(q.id))
      : allQuestions;

    const sanitized = sessionQuestions.map(q => {
      const clean = this.sanitizeQuestion(q);
      const savedAnswer = session.answers ? session.answers[q.id] : null;
      const selectedOptionId = savedAnswer
        ? (typeof savedAnswer === 'object' ? savedAnswer.selectedOptionId : savedAnswer)
        : null;
      const isFlagged = session.flaggedQuestions ? session.flaggedQuestions.includes(q.id) : false;

      return {
        ...clean,
        savedAnswer: selectedOptionId,
        selectedOptionId: selectedOptionId,
        isFlagged
      };
    });

    return {
      success: true,
      sessionId: session.id,
      status: session.status,
      questions: sanitized
    };
  }

  saveAnswer(sessionId, questionId, selectedOptionId, metadata = {}) {
    if (!sessionId || !questionId) {
      const err = new Error('sessionId and questionId are required.');
      err.status = 400;
      err.statusCode = 400;
      err.error = 'INVALID_PAYLOAD';
      throw err;
    }

    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error('Assessment session not found.');
      err.status = 404;
      err.statusCode = 404;
      err.error = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Terminal Status Checks - prioritized
    if (['DISQUALIFIED', 'DISQUALIFIED_VIOLATIONS'].includes(session.status)) {
      const err = new Error('Test session has been disqualified due to proctoring violations');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'SESSION_DISQUALIFIED';
      throw err;
    }
    if (session.status === 'AUTO_SUBMITTED_TIMEOUT') {
      const err = new Error('Test session has expired and was automatically submitted');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'SESSION_EXPIRED';
      throw err;
    }
    if (session.status === 'SUBMITTED') {
      const err = new Error('Test session has already been submitted');
      err.status = 400;
      err.statusCode = 400;
      err.error = 'SESSION_SUBMITTED';
      throw err;
    }

    // Time Check with grace period
    const now = Date.now();
    if (now > session.expiresAt + this.gracePeriodMs) {
      this.finalizeExpiredSession(session.id);
      const err = new Error('Test session has expired and was automatically submitted');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'SESSION_EXPIRED';
      throw err;
    }

    const question = this.datastore ? this.datastore.getQuestionById(questionId) : null;
    if (!question) {
      const err = new Error(`Question not found with id: ${questionId}`);
      err.status = 404;
      err.statusCode = 404;
      err.error = 'QUESTION_NOT_FOUND';
      throw err;
    }

    if (selectedOptionId !== undefined && selectedOptionId !== null) {
      if (typeof selectedOptionId !== 'string' || selectedOptionId.trim() === '') {
        const err = new Error('selectedOptionId must be a non-empty string');
        err.status = 400;
        err.statusCode = 400;
        err.error = 'INVALID_OPTION_ID';
        throw err;
      }
      if (question && Array.isArray(question.options)) {
        const validOption = question.options.some(opt => opt.id === selectedOptionId);
        if (!validOption) {
          const err = new Error(`Invalid selectedOptionId: ${selectedOptionId} for question: ${questionId}`);
          err.status = 400;
          err.statusCode = 400;
          err.error = 'INVALID_OPTION_ID';
          throw err;
        }
      }
    }

    if (!session.answers) session.answers = {};
    if (!session.flaggedQuestions) session.flaggedQuestions = [];

    const isFlagged = Boolean(metadata.flagged !== undefined ? metadata.flagged : metadata.isFlagged);
    const answerRecord = {
      questionId,
      selectedOptionId: selectedOptionId || null,
      savedAt: now,
      isFlagged,
      timeSpentSeconds: Number(metadata.timeSpentSeconds) || 0
    };

    const previous = session.answers[questionId];
    const previousOptionId = previous ? (typeof previous === 'object' ? previous.selectedOptionId : previous) : null;
    session.answers[questionId] = answerRecord;
    if (previousOptionId !== answerRecord.selectedOptionId) {
      const answerLog = [...(session.answerLog || []), { questionId, selectedOptionId: answerRecord.selectedOptionId, previousOptionId, at: now }];
      session.answerLog = answerLog;
      if (this.datastore && typeof this.datastore.updateSession === 'function') {
        this.datastore.updateSession(sessionId, { answerLog });
      }
    }

    const flagIdx = session.flaggedQuestions.indexOf(questionId);
    if (isFlagged && flagIdx === -1) {
      session.flaggedQuestions.push(questionId);
    } else if (!isFlagged && flagIdx !== -1) {
      session.flaggedQuestions.splice(flagIdx, 1);
    }

    if (this.datastore && typeof this.datastore.saveAnswer === 'function') {
      this.datastore.saveAnswer(sessionId, questionId, answerRecord);
    }

    return {
      success: true,
      saved: true,
      questionId,
      selectedOptionId: answerRecord.selectedOptionId,
      flagged: session.flaggedQuestions.includes(questionId),
      savedAt: answerRecord.savedAt
    };
  }

  evaluateScore(session) {
    const allQuestions = this.datastore ? this.datastore.getAllQuestions() : [];
    const questionMap = new Map(allQuestions.map(q => [q.id, q]));

    let correctCount = 0;
    let incorrectCount = 0;
    let unattemptedCount = 0;
    let rawScore = 0;
    let maxScore = 0;
    const results = [];

    const questionIdsToGrade = session.questionIds && session.questionIds.length > 0
      ? session.questionIds
      : Array.from(questionMap.keys());

    for (const qId of questionIdsToGrade) {
      const q = questionMap.get(qId);
      if (!q) continue;

      const marks = typeof q.marks === 'number' ? q.marks : 1;
      const negativeMarks = typeof q.negativeMarks === 'number' ? q.negativeMarks : 0;
      maxScore += marks;

      const studentAnswer = session.answers && session.answers[qId];
      const selectedOptionId = studentAnswer
        ? (typeof studentAnswer === 'object' ? studentAnswer.selectedOptionId : studentAnswer)
        : null;

      if (!selectedOptionId) {
        unattemptedCount++;
        results.push({
          questionId: q.id,
          category: q.category || 'General',
          prompt: q.prompt || q.text,
          text: q.text || q.prompt,
          options: q.options,
          selectedOptionId: null,
          correctOptionId: q.correctOptionId,
          isCorrect: false,
          isAttempted: false,
          marksAwarded: 0,
          explanation: q.explanation || ''
        });
      } else if (selectedOptionId === q.correctOptionId) {
        correctCount++;
        rawScore += marks;
        results.push({
          questionId: q.id,
          category: q.category || 'General',
          prompt: q.prompt || q.text,
          text: q.text || q.prompt,
          options: q.options,
          selectedOptionId: selectedOptionId,
          correctOptionId: q.correctOptionId,
          isCorrect: true,
          isAttempted: true,
          marksAwarded: marks,
          explanation: q.explanation || ''
        });
      } else {
        incorrectCount++;
        rawScore -= negativeMarks;
        results.push({
          questionId: q.id,
          category: q.category || 'General',
          prompt: q.prompt || q.text,
          text: q.text || q.prompt,
          options: q.options,
          selectedOptionId: selectedOptionId,
          correctOptionId: q.correctOptionId,
          isCorrect: false,
          isAttempted: true,
          marksAwarded: -negativeMarks,
          explanation: q.explanation || ''
        });
      }
    }

    const totalAttempted = correctCount + incorrectCount;
    const finalScore = Math.max(0, Number(rawScore.toFixed(2)));
    const totalPossible = maxScore || questionIdsToGrade.length || 1;
    const accuracy = totalAttempted > 0
      ? Number(((correctCount / totalAttempted) * 100).toFixed(1))
      : 0;

    return {
      score: finalScore,
      maxScore: totalPossible,
      accuracy,
      correctCount,
      incorrectCount,
      unattemptedCount,
      results
    };
  }

  gradeSession(session) {
    const grading = this.evaluateScore(session);
    session.score = grading.score;
    session.maxScore = grading.maxScore;
    session.total = session.questionIds ? session.questionIds.length : grading.maxScore;
    session.accuracy = grading.accuracy;
    session.correctCount = grading.correctCount;
    session.incorrectCount = grading.incorrectCount;
    session.unattemptedCount = grading.unattemptedCount;
    session.results = grading.results;
    return grading;
  }

  submitSession(sessionId) {
    if (!sessionId) {
      const err = new Error('sessionId is required.');
      err.status = 400;
      err.statusCode = 400;
      err.error = 'MISSING_SESSION_ID';
      throw err;
    }

    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error('Assessment session not found.');
      err.status = 404;
      err.statusCode = 404;
      err.error = 'SESSION_NOT_FOUND';
      throw err;
    }

    // Idempotent return if already submitted
    if (session.status === 'SUBMITTED' || session.status === 'AUTO_SUBMITTED_TIMEOUT') {
      return {
        success: true,
        status: session.status,
        score: session.score,
        total: session.maxScore || session.total,
        percentage: Math.round(((session.score || 0) / (session.maxScore || session.total || 1)) * 100),
        summary: {
          score: session.score,
          maxScore: session.maxScore,
          accuracy: session.accuracy,
          correctCount: session.correctCount,
          incorrectCount: session.incorrectCount,
          unattemptedCount: session.unattemptedCount,
          submittedAt: session.submittedAt
        },
        results: session.results || []
      };
    }

    if (session.status === 'DISQUALIFIED_VIOLATIONS' || session.status === 'DISQUALIFIED') {
      const err = new Error('Session is disqualified and cannot be submitted');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'SESSION_DISQUALIFIED';
      throw err;
    }

    const grading = this.gradeSession(session);
    const submittedAt = Date.now();

    const updates = {
      status: 'SUBMITTED',
      submittedAt
    };

    Object.assign(session, updates);

    if (this.datastore && typeof this.datastore.updateSession === 'function') {
      this.datastore.updateSession(session.id, session);
    }

    return {
      success: true,
      status: 'SUBMITTED',
      score: grading.score,
      total: session.maxScore || session.total,
      percentage: Math.round((grading.score / (session.maxScore || session.total || 1)) * 100),
      message: 'Assessment submitted successfully.',
      summary: {
        score: grading.score,
        maxScore: grading.maxScore,
        accuracy: grading.accuracy,
        correctCount: grading.correctCount,
        incorrectCount: grading.incorrectCount,
        unattemptedCount: grading.unattemptedCount,
        submittedAt
      },
      results: grading.results
    };
  }

  finalizeExpiredSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    // Do not alter sessions already cleanly submitted or disqualified
    if (['SUBMITTED', 'DISQUALIFIED', 'DISQUALIFIED_VIOLATIONS'].includes(session.status)) {
      return session;
    }

    // Only process sessions that are IN_PROGRESS or AUTO_SUBMITTED_TIMEOUT needing grading
    if (session.status !== 'IN_PROGRESS' && session.status !== 'AUTO_SUBMITTED_TIMEOUT') {
      return session;
    }

    // Idempotent auto-grading
    this.gradeSession(session);
    session.status = 'AUTO_SUBMITTED_TIMEOUT';
    session.submittedAt = session.submittedAt || session.expiresAt || Date.now();

    const targetId = session.id || session.sessionId;
    if (this.datastore && typeof this.datastore.updateSession === 'function') {
      this.datastore.updateSession(targetId, session);
    }

    return session;
  }

  getSessionResults(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error('Assessment session not found.');
      err.status = 404;
      err.statusCode = 404;
      err.error = 'SESSION_NOT_FOUND';
      throw err;
    }

    if (session.status === 'IN_PROGRESS') {
      const err = new Error('Results and explanations cannot be viewed while exam is in progress.');
      err.status = 403;
      err.statusCode = 403;
      err.error = 'EXAM_IN_PROGRESS';
      throw err;
    }

    return {
      success: true,
      sessionId: session.id,
      status: session.status,
      candidateId: session.candidateId,
      score: session.score,
      maxScore: session.maxScore || session.total,
      accuracy: session.accuracy,
      summary: {
        score: session.score,
        maxScore: session.maxScore || session.total,
        accuracy: session.accuracy,
        correctCount: session.correctCount,
        incorrectCount: session.incorrectCount,
        unattemptedCount: session.unattemptedCount,
        startedAt: session.startedAt,
        submittedAt: session.submittedAt
      },
      results: session.results || []
    };
  }
}

const assessmentService = new AssessmentService();
module.exports = assessmentService;
module.exports.AssessmentService = AssessmentService;
module.exports.assessmentService = assessmentService;
