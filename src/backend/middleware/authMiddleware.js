const authService = require('../services/authService');

/**
 * Authentication Middleware
 * Validates Bearer session token from Authorization header, x-session-token, or query parameter.
 * Attaches candidate profile and session token to req.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  let token = null;

  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else {
      token = authHeader.trim();
    }
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  // Allow optional dev bypass header for test suites
  if (!token && process.env.NODE_ENV === 'test' && req.headers['x-dev-candidate']) {
    req.candidate = {
      id: req.headers['x-dev-candidate'],
      name: 'Test Student',
      email: 'test@university.edu'
    };
    req.candidateId = req.candidate.id;
    req.token = 'sess_tok_dev_bypass';
    return next();
  }

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required. Missing Bearer token in Authorization header.'
    });
  }

  const session = authService.validateSessionToken(token);
  if (!session) {
    return res.status(401).json({
      error: 'INVALID_TOKEN',
      message: 'Session token is invalid or has expired.'
    });
  }

  req.token = token;
  req.candidate = session.candidate;
  req.candidateId = session.candidate ? session.candidate.id : session.candidateId;
  req.sessionData = session;
  next();
}

/**
 * Optional Auth Middleware: Attaches candidate if token exists, but doesn't block if absent
 */
function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-session-token'];
  let token = null;

  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else {
      token = authHeader.trim();
    }
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    const session = authService.validateSessionToken(token);
    if (session) {
      req.token = token;
      req.candidate = session.candidate;
      req.candidateId = session.candidate ? session.candidate.id : session.candidateId;
      req.sessionData = session;
    }
  }
  next();
}

module.exports = {
  authMiddleware,
  optionalAuthMiddleware
};
