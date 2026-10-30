const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

const sameName = (a, b) => String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cleanRoll = (v) => String(v || '').trim().toUpperCase().slice(0, 40);
const maskEmail = (email) => {
  if (!email || !email.includes('@')) return '';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
};
const publicProfile = (c) => ({
  rollNo: c.id,
  name: c.name,
  institution: c.institution || '',
  emailHint: maskEmail(c.email),
  createdAt: c.createdAt || null
});

// GET /api/auth/profile/:rollNo — does a profile exist for this roll number?
router.get('/profile/:rollNo', (req, res) => {
  const datastore = require('../db/datastore');
  const rollNo = cleanRoll(req.params.rollNo);
  const candidate = rollNo ? datastore.getCandidateById(rollNo) : null;
  if (!candidate) return res.status(404).json({ exists: false });
  return res.status(200).json({ exists: true, profile: publicProfile(candidate) });
});

// POST /api/auth/profile — a student creates their profile (or confirms an existing one).
// This does not authenticate; the one-time code step issues the session token.
function upsertProfile(req, res) {
  const datastore = require('../db/datastore');
  const body = req.body || {};
  const rollNo = cleanRoll(body.rollNo || body.studentId);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  const institution = String(body.institution || '').trim().slice(0, 160);

  if (!rollNo || /[<>{}]/.test(rollNo)) {
    return res.status(400).json({ error: true, code: 'INVALID_ROLL_NO', message: 'Enter a valid roll number.' });
  }
  if (!name) {
    return res.status(400).json({ error: true, code: 'NAME_REQUIRED', message: 'Enter your full name.' });
  }

  const existing = datastore.getCandidateById(rollNo);
  if (existing) {
    // A roll number belongs to one person: joining under someone else's roll number is refused.
    if (!sameName(existing.name, name)) {
      return res.status(409).json({ error: true, code: 'NAME_MISMATCH', message: 'This roll number is registered to a different name. Use the name on your profile, or ask your proctor.' });
    }
    return res.status(200).json({ success: true, created: false, studentId: existing.id, name: existing.name, profile: publicProfile(existing) });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: true, code: 'INVALID_EMAIL', message: 'Enter a valid email address.' });
  }
  if (email && datastore.getCandidateByEmail(email)) {
    return res.status(409).json({ error: true, code: 'EMAIL_TAKEN', message: 'That email is already linked to another profile.' });
  }

  const candidate = {
    id: rollNo,
    rollNo,
    name,
    email: email || `${rollNo.toLowerCase().replace(/[^a-z0-9]/g, '')}@candidate.local`,
    institution,
    faceRegistered: false,
    createdAt: Date.now()
  };
  datastore.addCandidate(candidate);
  return res.status(201).json({ success: true, created: true, studentId: candidate.id, name: candidate.name, profile: publicProfile(candidate) });
}
router.post('/profile', upsertProfile);
router.post('/register-or-login', upsertProfile);

// POST /api/auth/otp/request
router.post('/otp/request', (req, res, next) => {
  try {
    const identifier = req.body.studentId || req.body.email || req.body.identifier;
    if (!identifier) {
      return res.status(400).json({
        error: 'MISSING_IDENTIFIER',
        message: 'studentId or email is required'
      });
    }

    const result = authService.requestOtp(identifier);

    // Production: the code never goes back to the candidate's own screen. It is delivered to
    // the proctor console, and the invigilator hands it over after checking the student's ID.
    const config = require('../config');
    if (config.ENV === 'production' && process.env.TRINETRA_SHOW_OTP !== '1') {
      const datastore = require('../db/datastore');
      const candidate = datastore.getCandidateById(result.studentId) || {};
      try {
        require('../services/websocketService').broadcastToProctors({
          type: 'OTP_ISSUED',
          studentId: result.studentId,
          studentName: candidate.name || result.studentId,
          otp: result.otp,
          expiresInSeconds: result.expiresInSeconds,
          timestamp: Date.now()
        });
      } catch (_) {}
      const { otp, devOtp, ...safe } = result;
      return res.status(200).json({ ...safe, delivery: 'proctor' });
    }
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

// POST /api/auth/otp/verify
router.post('/otp/verify', (req, res, next) => {
  try {
    const identifier = req.body.studentId || req.body.email || req.body.identifier;
    const otp = req.body.otp;

    if (!identifier || otp === undefined || otp === null) {
      return res.status(400).json({
        error: true,
        statusCode: 400,
        code: 'MISSING_CREDENTIALS',
        message: 'studentId (or email) and otp are required'
      });
    }

    const result = authService.verifyOtp(identifier, otp);
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

// POST /api/auth/face/verify
router.post('/face/verify', (req, res, next) => {
  try {
    let candidateId = req.body.studentId || req.body.candidateId;

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const session = authService.validateSessionToken(authHeader.slice(7).trim());
      if (session) {
        candidateId = candidateId || session.candidateId;
      }
    }

    if (!candidateId) {
      candidateId = 'STU-001';
    }

    const result = authService.registerFaceBaseline(candidateId, req.body);
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

// POST /api/auth/proctor/login
router.post('/proctor/login', (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = authService.loginProctor(username, password);
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

// GET /api/auth/me
router.get('/me', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ authenticated: false, message: 'No bearer token provided' });
  }
  const token = authHeader.slice(7).trim();
  const session = authService.validateSessionToken(token);
  if (!session) {
    return res.status(401).json({ authenticated: false, message: 'Invalid or expired token' });
  }
  return res.status(200).json({
    authenticated: true,
    role: session.role || (session.isProctor ? 'proctor' : 'candidate'),
    user: session
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    authService.logout(authHeader.slice(7).trim());
  }
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;
