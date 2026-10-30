const SESSION_STATUS = {
  AUTHENTICATED: 'AUTHENTICATED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  AUTO_SUBMITTED_TIMEOUT: 'AUTO_SUBMITTED_TIMEOUT',
  DISQUALIFIED_VIOLATIONS: 'DISQUALIFIED_VIOLATIONS',
  DISQUALIFIED: 'DISQUALIFIED'
};

const VIOLATION_TYPE = {
  NO_FACE: 'NO_FACE',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  GAZE_DIVERSION: 'GAZE_DIVERSION',
  SUSPICIOUS_OBJECT: 'SUSPICIOUS_OBJECT',
  UNUSUAL_BEHAVIOR: 'UNUSUAL_BEHAVIOR'
};

const VIOLATION_SEVERITY = {
  LOW: 'LOW',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  CRITICAL_INTEGRITY: 'CRITICAL_INTEGRITY'
};

const TAB_EVENT_TYPE = {
  TAB_OPENED: 'TAB_OPENED',
  TAB_CLOSED: 'TAB_CLOSED',
  TAB_SWITCH: 'TAB_SWITCH',
  TAB_NAVIGATE: 'TAB_NAVIGATE',
  URL_VISITED: 'URL_VISITED',
  AI_SEARCH_QUERY: 'AI_SEARCH_QUERY'
};

const INPUT_EVENT_TYPE = {
  KEYSTROKE: 'KEYSTROKE',
  KEY_SUMMARY: 'KEY_SUMMARY',
  CLIPBOARD: 'CLIPBOARD',
  COPY_PASTE_ATTEMPT: 'COPY_PASTE_ATTEMPT',
  MOUSE_LEAVE_WINDOW: 'MOUSE_LEAVE_WINDOW',
  MOUSE_BURST: 'MOUSE_BURST',
  CLICK_EVENT: 'CLICK_EVENT'
};

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['candidate must be an object'] };
  }
  if (!candidate.id || typeof candidate.id !== 'string') errors.push('candidate.id must be a non-empty string');
  if (!candidate.name || typeof candidate.name !== 'string') errors.push('candidate.name must be a non-empty string');
  if (!candidate.email || typeof candidate.email !== 'string') errors.push('candidate.email must be a valid email string');
  return { valid: errors.length === 0, errors };
}

function validateQuestion(question) {
  const errors = [];
  if (!question || typeof question !== 'object') {
    return { valid: false, errors: ['question must be an object'] };
  }
  if (!question.id) errors.push('question.id is required');
  if (!question.prompt && !question.text) errors.push('question.prompt or question.text is required');
  if (!Array.isArray(question.options) || question.options.length < 2) errors.push('question.options must be an array of at least 2 options');
  if (!question.correctOptionId) errors.push('question.correctOptionId is required');
  return { valid: errors.length === 0, errors };
}

function validateSession(session) {
  const errors = [];
  if (!session || typeof session !== 'object') {
    return { valid: false, errors: ['session must be an object'] };
  }
  if (!session.id && !session.sessionId) errors.push('session.id is required');
  if (!session.candidateId && !session.studentId) errors.push('session.candidateId is required');
  if (session.status && !Object.values(SESSION_STATUS).includes(session.status)) {
    errors.push(`Invalid session.status: ${session.status}`);
  }
  if (typeof session.startedAt !== 'number') errors.push('session.startedAt must be an epoch timestamp');
  if (typeof session.expiresAt !== 'number') errors.push('session.expiresAt must be an epoch timestamp');
  return { valid: errors.length === 0, errors };
}

function validateViolation(violation) {
  const errors = [];
  if (!violation || typeof violation !== 'object') {
    return { valid: false, errors: ['violation must be an object'] };
  }
  if (!violation.sessionId) errors.push('violation.sessionId is required');
  if (typeof violation.timestamp !== 'number') errors.push('violation.timestamp must be a number');
  return { valid: errors.length === 0, errors };
}

function validateTabActivity(activity) {
  const errors = [];
  if (!activity || typeof activity !== 'object') {
    return { valid: false, errors: ['activity must be an object'] };
  }
  if (!activity.sessionId) errors.push('activity.sessionId is required');
  if (!activity.url && !activity.service) errors.push('activity.url or activity.service is required');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SESSION_STATUS,
  VIOLATION_TYPE,
  VIOLATION_SEVERITY,
  TAB_EVENT_TYPE,
  INPUT_EVENT_TYPE,
  validateCandidate,
  validateQuestion,
  validateSession,
  validateViolation,
  validateTabActivity
};
