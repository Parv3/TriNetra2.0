const express = require('express');
const router = express.Router();
const assessmentService = require('../services/assessmentService');
const timerService = require('../services/timerService');
const { authMiddleware, optionalAuthMiddleware, requireProctor } = require('../middleware/authMiddleware');

// GET /api/assessment/questions (Protected per PROJECT.md line 143 and E2E F2.4)
router.get('/questions', authMiddleware, (req, res, next) => {
  try {
    const questions = assessmentService.getAllSanitizedQuestions();
    return res.status(200).json(questions);
  } catch (err) {
    next(err);
  }
});

// POST /api/assessment/session/start
router.post('/session/start', optionalAuthMiddleware, (req, res, next) => {
  try {
    const candidateId = req.candidateId || (req.body && (req.body.candidateId || req.body.studentId)) || 'STU-001';
    const maxStrikes = req.body && req.body.maxStrikes !== undefined ? Number(req.body.maxStrikes) : undefined;
    const examId = req.body && req.body.examId ? String(req.body.examId).trim() : undefined;
    const deviceId = req.body && req.body.deviceId ? String(req.body.deviceId) : undefined;
    const exam = examId && assessmentService.datastore && typeof assessmentService.datastore.getExam === 'function'
      ? assessmentService.datastore.getExam(examId)
      : null;
    let durationMinutes = req.body && req.body.durationMinutes !== undefined
      ? Number(req.body.durationMinutes)
      : ((exam && exam.durationMinutes) || 30);

    const window = scheduleState(exam);
    if (window === 'UPCOMING') {
      return res.status(403).json({ error: true, statusCode: 403, code: 'EXAM_NOT_STARTED', startsAt: exam.startsAt, message: `This exam opens at ${formatWhen(exam.startsAt)}.` });
    }
    if (window === 'ENDED') {
      return res.status(403).json({ error: true, statusCode: 403, code: 'EXAM_ENDED', message: 'The scheduled window for this exam has ended.' });
    }
    // A late starter gets only the time left in the window
    if (exam && exam.endsAt) {
      durationMinutes = Math.max(1, Math.min(durationMinutes, Math.floor((exam.endsAt - Date.now()) / 60000)));
    }

    const result = assessmentService.startSession(candidateId, durationMinutes, { maxStrikes, examId, deviceId });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: true,
        statusCode: err.status,
        code: err.error,
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/assessment/session/:id/questions
router.get('/session/:id/questions', optionalAuthMiddleware, (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const result = assessmentService.getSessionQuestions(sessionId);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: true,
        statusCode: err.status,
        code: err.error,
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/assessment/session/:id/timer
router.get('/session/:id/timer', (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const session = assessmentService.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        error: true,
        statusCode: 404,
        code: 'SESSION_NOT_FOUND',
        message: 'Assessment session not found.'
      });
    }

    const timerInfo = timerService.getSessionTimer(session);
    return res.status(200).json(timerInfo);
  } catch (err) {
    next(err);
  }
});

// POST /api/assessment/answer
router.post('/answer', optionalAuthMiddleware, (req, res, next) => {
  try {
    const { sessionId, questionId, selectedOptionId, flagged, isFlagged, timeSpentSeconds } = req.body;
    const result = assessmentService.saveAnswer(sessionId, questionId, selectedOptionId, { flagged, isFlagged, timeSpentSeconds });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.error || err.code || 'ANSWER_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// PATCH /api/assessment/session/:id/answers
router.patch('/session/:id/answers', optionalAuthMiddleware, (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const { questionId, selectedOptionId, flagged, isFlagged, timeSpentSeconds } = req.body;
    const result = assessmentService.saveAnswer(sessionId, questionId, selectedOptionId, { flagged, isFlagged, timeSpentSeconds });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.error || err.code || 'ANSWER_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/assessment/submit
router.post('/submit', optionalAuthMiddleware, (req, res, next) => {
  try {
    const sessionId = req.body && req.body.sessionId;
    const result = assessmentService.submitSession(sessionId);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.error || err.code || 'SUBMIT_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/assessment/session/:id/submit
router.post('/session/:id/submit', optionalAuthMiddleware, (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const result = assessmentService.submitSession(sessionId);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.error || err.code || 'SUBMIT_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/assessment/session/:id/results
router.get('/session/:id/results', optionalAuthMiddleware, (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const result = assessmentService.getSessionResults(sessionId);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.error || err.code || 'RESULTS_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// EXAM CONFIGURATIONS & PROCTORING FEATURE TOGGLES
// ═══════════════════════════════════════════════════════════════

const RULE_DEFAULTS = {
  enableVisionProctoring: true,
  enableMultiTab: true,
  enableAiGuard: true,
  enableClipboardProtection: true,
  enableGuidedAssistant: true,
  enableVoiceMonitoring: true,
  maxStrikes: 3,
  strictness: 'standard'
};
const STRICTNESS = ['relaxed', 'standard', 'strict'];

function examSummary(exam, sessions) {
  const { questions, ...rest } = exam;
  const examSessions = sessions.filter(s => s.examId === exam.id);
  return {
    ...rest,
    status: exam.status || 'OPEN',
    questionCount: (questions || []).length,
    sessionCount: examSessions.length,
    liveCount: examSessions.filter(s => s.status === 'IN_PROGRESS').length,
    schedule: scheduleState(exam)
  };
}

/** Where an exam's start/end window stands: UPCOMING, LIVE, ENDED, or null when unscheduled. */
function scheduleState(exam, now = Date.now()) {
  if (!exam || (!exam.startsAt && !exam.endsAt)) return null;
  if (exam.startsAt && now < exam.startsAt) return 'UPCOMING';
  if (exam.endsAt && now >= exam.endsAt) return 'ENDED';
  return 'LIVE';
}

function toEpoch(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Reads startsAt/endsAt (epoch ms or ISO text) from a request body. */
function parseSchedule(body) {
  const startsAt = toEpoch(body.startsAt);
  const endsAt = toEpoch(body.endsAt);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return { error: 'Start and end must be valid dates.' };
  if (startsAt && endsAt && endsAt <= startsAt) return { error: 'The exam must end after it starts.' };
  return { startsAt, endsAt };
}

function formatWhen(ms) {
  return new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Validates proctor-authored questions and gives them ids that are unique across exams.
 * Accepts options as strings or {text}, and the answer as correctIndex or correctOptionId.
 */
function normalizeQuestions(examId, raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Add at least one question.' };
  }
  const letters = 'abcdef';
  const questions = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {};
    const text = String(q.text || q.prompt || '').trim();
    const options = (q.options || [])
      .map(o => String(typeof o === 'string' ? o : (o && o.text) || '').trim())
      .filter(Boolean);
    if (!text) return { error: `Question ${i + 1} has no text.` };
    if (options.length < 2 || options.length > 6) return { error: `Question ${i + 1} needs between 2 and 6 options.` };

    let correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : -1;
    if (correctIndex < 0 && q.correctOptionId) {
      correctIndex = (q.options || []).findIndex(o => o && o.id === q.correctOptionId);
    }
    if (correctIndex < 0 || correctIndex >= options.length) return { error: `Mark the correct option for question ${i + 1}.` };

    questions.push({
      id: `${examId}_q${i + 1}`,
      text,
      prompt: text,
      category: String(q.category || '').trim().slice(0, 80),
      options: options.map((t, j) => ({ id: `opt_${letters[j]}`, text: t })),
      correctOptionId: `opt_${letters[correctIndex]}`,
      explanation: String(q.explanation || '').trim(),
      hint: String(q.hint || '').trim(),
      marks: Number(q.marks) > 0 ? Number(q.marks) : 1,
      negativeMarks: Number(q.negativeMarks) > 0 ? Number(q.negativeMarks) : 0
    });
  }
  return { questions };
}

function broadcast(payload) {
  try {
    require('../services/websocketService').broadcastToProctors({ ...payload, timestamp: Date.now() });
  } catch (_) {}
}

// GET /api/assessment/exams — proctor list (no questions)
router.get('/exams', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const sessions = datastore.getAllSessions();
  const exams = datastore.getAllExams()
    .map(e => examSummary(e, sessions))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.status(200).json(exams);
});

// GET /api/assessment/exams/join/:code — what a candidate sees before joining. Never includes questions.
router.get('/exams/join/:code', (req, res) => {
  const datastore = require('../db/datastore');
  const exam = datastore.getExamByCode(req.params.code);
  if (!exam) {
    return res.status(404).json({ error: true, code: 'EXAM_NOT_FOUND', message: 'No exam matches that code. Check it with your proctor.' });
  }
  if ((exam.status || 'OPEN') !== 'OPEN') {
    return res.status(403).json({ error: true, code: 'EXAM_CLOSED', message: 'This exam is not accepting candidates right now.' });
  }
  if (scheduleState(exam) === 'ENDED') {
    return res.status(403).json({ error: true, code: 'EXAM_ENDED', message: `This exam closed at ${formatWhen(exam.endsAt)}.` });
  }
  return res.status(200).json({
    startsAt: exam.startsAt || null,
    endsAt: exam.endsAt || null,
    schedule: scheduleState(exam),
    serverTime: Date.now(),
    id: exam.id,
    code: exam.code,
    title: exam.title,
    description: exam.description,
    durationMinutes: exam.durationMinutes,
    questionCount: (exam.questions || []).length,
    rules: exam.rules
  });
});

// GET /api/assessment/exams/:id — full exam for the proctor console
router.get('/exams/:id', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const exam = datastore.getExam(req.params.id);
  if (!exam) {
    return res.status(404).json({ error: true, message: `Exam ${req.params.id} not found` });
  }
  return res.status(200).json(exam);
});

// POST /api/assessment/exams — proctor creates an exam; the response carries its join code
router.post('/exams', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const body = req.body || {};

  if (!body.title || !String(body.title).trim()) {
    return res.status(400).json({ error: true, message: 'Exam title is required' });
  }

  const examId = body.id && String(body.id).trim()
    ? String(body.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    : `exam_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  let questions;
  if (body.questions !== undefined) {
    const result = normalizeQuestions(examId, body.questions);
    if (result.error) return res.status(400).json({ error: true, message: result.error });
    questions = result.questions;
  }

  const schedule = parseSchedule(body);
  if (schedule.error) return res.status(400).json({ error: true, message: schedule.error });

  const rules = { ...RULE_DEFAULTS };
  Object.keys(RULE_DEFAULTS).forEach(key => {
    if (body.rules && body.rules[key] !== undefined) {
      if (key === 'maxStrikes') rules[key] = Math.max(1, Number(body.rules[key]) || 3);
      else if (key === 'strictness') rules[key] = STRICTNESS.includes(body.rules[key]) ? body.rules[key] : 'standard';
      else rules[key] = Boolean(body.rules[key]);
    }
  });

  const exam = datastore.createOrUpdateExam({
    id: examId,
    title: String(body.title).trim().slice(0, 160),
    description: String(body.description || '').trim().slice(0, 500),
    durationMinutes: Math.min(Math.max(Number(body.durationMinutes) || 30, 1), 180),
    rules,
    ...(questions ? { questions } : {}),
    status: 'OPEN',
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    createdBy: (req.user && (req.user.proctorId || req.user.username)) || null,
    createdAt: Date.now()
  });

  broadcast({ type: 'EXAM_CREATED', exam: examSummary(exam, []) });
  return res.status(201).json(exam);
});

// PATCH /api/assessment/exams/:id/status — open or close an exam for new candidates
router.patch('/exams/:id/status', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const exam = datastore.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: true, message: `Exam ${req.params.id} not found` });
  const status = String((req.body && req.body.status) || '').toUpperCase();
  if (!['OPEN', 'CLOSED'].includes(status)) return res.status(400).json({ error: true, message: 'status must be OPEN or CLOSED' });
  const updated = datastore.createOrUpdateExam({ id: exam.id, status });
  broadcast({ type: 'EXAM_RULES_UPDATED', examId: exam.id });
  return res.status(200).json(examSummary(updated, datastore.getAllSessions()));
});

// PATCH /api/assessment/exams/:id/schedule — set or clear the start/end window
router.patch('/exams/:id/schedule', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const exam = datastore.getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: true, message: `Exam ${req.params.id} not found` });
  const schedule = parseSchedule(req.body || {});
  if (schedule.error) return res.status(400).json({ error: true, message: schedule.error });
  const updated = datastore.createOrUpdateExam({ id: exam.id, startsAt: schedule.startsAt, endsAt: schedule.endsAt });
  broadcast({ type: 'EXAM_RULES_UPDATED', examId: exam.id });
  return res.status(200).json(examSummary(updated, datastore.getAllSessions()));
});

// PATCH /api/assessment/exams/:id/rules
router.patch('/exams/:id/rules', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const exam = datastore.updateExamRules(req.params.id, req.body);
  if (!exam) {
    return res.status(404).json({ error: true, message: `Exam ${req.params.id} not found` });
  }

  // Notify connected proctors & WebSocket clients about rule changes
  try {
    const websocketService = require('../services/websocketService');
    websocketService.broadcastToProctors({
      type: 'EXAM_RULES_UPDATED',
      examId: req.params.id,
      rules: exam.rules,
      timestamp: Date.now()
    });
  } catch (_) {}

  return res.status(200).json(exam);
});

module.exports = router;
