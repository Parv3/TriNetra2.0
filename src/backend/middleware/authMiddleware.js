const authService = require('../services/authService');
const config = require('../config');

/**
 * Authentication Middleware
 * Validates Bearer session token from Authorization header, x-session-token, or query parameter.
 * Attaches user, candidate profile, role and session token to req.
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
  if (!token && (process.env.NODE_ENV === 'test' || config.ENV === 'test') && req.headers['x-dev-candidate']) {
    req.candidate = {
      id: req.headers['x-dev-candidate'],
      name: 'Test Student',
      email: 'test@university.edu'
    };
    req.candidateId = req.candidate.id;
    req.token = 'sess_tok_dev_bypass';
    req.role = 'candidate';
    req.user = { role: 'candidate', candidateId: req.candidate.id, candidate: req.candidate };
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
  req.user = session;
  req.role = session.role || (session.isProctor ? 'proctor' : 'candidate');
  req.candidate = session.candidate;
  req.candidateId = session.candidate ? session.candidate.id : session.candidateId;
  req.sessionData = session;
  next();
}

/**
 * Proctor-Only Authorization Middleware
 * Enforces role: 'proctor' on administrative endpoints.
 */
function requireProctor(req, res, next) {
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

  // Allow test suite fallback when auth enforcement is not explicitly enabled
  if (!token && (process.env.NODE_ENV === 'test' || config.ENV === 'test') && !config.ENFORCE_AUTH) {
    req.role = 'proctor';
    req.user = { role: 'proctor', name: 'Test Proctor' };
    return next();
  }

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Proctor authentication required. Missing Bearer token.'
    });
  }

  const session = authService.validateSessionToken(token);
  if (!session) {
    return res.status(401).json({
      error: 'INVALID_TOKEN',
      message: 'Proctor token is invalid or has expired.'
    });
  }

  if (session.role !== 'proctor' && !session.isProctor) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Proctor authorization required. Access denied.'
    });
  }

  req.token = token;
  req.user = session;
  req.role = 'proctor';
  next();
}

/**
 * Candidate-Only Authorization Middleware
 */
function requireCandidate(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.role === 'candidate' || !req.role) {
      return next();
    }
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Candidate authorization required. Access denied.'
    });
  });
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
      req.user = session;
      req.role = session.role || (session.isProctor ? 'proctor' : 'candidate');
      req.candidate = session.candidate;
      req.candidateId = session.candidate ? session.candidate.id : session.candidateId;
      req.sessionData = session;
    }
  }
  next();
}

module.exports = {
  authMiddleware,
  requireProctor,
  requireCandidate,
  optionalAuthMiddleware
};
