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

// GET /api/auth/google/config — whether account sign-in (Supabase) is available, and which methods
router.get('/google/config', async (req, res) => {
  const methods = await authService.signInMethods();
  res.status(200).json({ enabled: authService.googleEnabled() && (methods.email || methods.google), ...methods });
});

const authError = (res, next, err) => {
  if (err.status) return res.status(err.status).json({ error: true, statusCode: err.status, code: err.error, message: err.message });
  next(err);
};

// POST /api/auth/email/send — emails a one-time sign-in code (Supabase Auth). Body: { email }
router.post('/email/send', async (req, res, next) => {
  try {
    const { email } = await authService.sendEmailCode((req.body || {}).email);
    res.status(200).json({ success: true, email });
  } catch (err) { authError(res, next, err); }
});

// POST /api/auth/email/verify — checks the emailed code. Body: { email, code }. Returns the
// signed-in account and a refresh token the app keeps so the student stays signed in.
router.post('/email/verify', async (req, res, next) => {
  try {
    const datastore = require('../db/datastore');
    const body = req.body || {};
    const tokens = await authService.verifyEmailCode(body.email, body.code);
    const { google, refreshToken } = await authService.resolveGoogleUser(tokens);
    const linked = datastore.getCandidateByEmail(google.email);
    res.status(200).json({ google, refreshToken: tokens.refreshToken || refreshToken, profile: linked ? publicProfile(linked) : null });
  } catch (err) { authError(res, next, err); }
});

// POST /api/auth/google/session — signs a student in with their Google account instead of a
// one-time code. Body: { accessToken | refreshToken, rollNo?, name? }. Without a roll number it
// only reports who is signed in and which profile (if any) that Gmail is linked to.
router.post('/google/session', async (req, res, next) => {
  try {
    const datastore = require('../db/datastore');
    const body = req.body || {};
    const { google, refreshToken } = await authService.resolveGoogleUser(body);
    const linked = datastore.getCandidateByEmail(google.email);
    const rollNo = cleanRoll(body.rollNo);
    if (!rollNo) {
      return res.status(200).json({ google, refreshToken, profile: linked ? publicProfile(linked) : null });
    }
    if (/[<>{}]/.test(rollNo)) {
      return res.status(400).json({ error: true, code: 'INVALID_ROLL_NO', message: 'Enter a valid roll number.' });
    }
    if (linked && linked.id !== rollNo) {
      return res.status(409).json({ error: true, code: 'EMAIL_LINKED_ELSEWHERE', message: `This account is linked to roll number ${linked.id}.` });
    }

    let candidate = datastore.getCandidateById(rollNo);
    const name = String(body.name || google.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (candidate) {
      const ownEmail = String(candidate.email || '').toLowerCase();
      if (ownEmail !== google.email) {
        // Only an unclaimed profile (no real email yet) with the same name can be linked to this Gmail
        const unclaimed = !ownEmail || ownEmail.endsWith('@candidate.local');
        if (!unclaimed || !sameName(candidate.name, name)) {
          return res.status(409).json({ error: true, code: 'ROLL_NO_TAKEN', message: 'This roll number belongs to a different account. Check it, or ask your proctor.' });
        }
        candidate = datastore.updateCandidate(rollNo, { email: google.email, googleLinkedAt: Date.now() });
      }
    } else {
      if (!name) return res.status(400).json({ error: true, code: 'NAME_REQUIRED', message: 'Enter your full name.' });
      candidate = datastore.addCandidate({
        id: rollNo, rollNo, name, email: google.email, institution: '',
        faceRegistered: false, googleLinkedAt: Date.now(), createdAt: Date.now()
      });
    }
    const session = authService.issueCandidateSession(candidate, 'GOOGLE');
    return res.status(200).json({ ...session, google, refreshToken, profile: publicProfile(candidate) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: true, statusCode: err.status, code: err.error, message: err.message });
    next(err);
  }
});

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

const { requireProctor, requireOwnerProctor } = require('../middleware/authMiddleware');

const isLoopback = (req) => {
  const ip = String(req.socket && req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
const sendError = (res, next, err) => (err.status
  ? res.status(err.status).json({ error: true, code: err.error, message: err.message })
  : next(err));

// GET /api/auth/proctor/setup — does this server still need its first proctor account?
router.get('/proctor/setup', (req, res) => {
  res.status(200).json({ needsSetup: authService.needsProctorSetup(), fromThisComputer: isLoopback(req) });
});

// POST /api/auth/proctor/setup — create the owner proctor. Only once, and only from the
// computer running the server, so nobody on the network can claim the exam server first.
router.post('/proctor/setup', (req, res, next) => {
  try {
    if (!authService.needsProctorSetup()) {
      return res.status(409).json({ error: true, code: 'ALREADY_SET_UP', message: 'A proctor account already exists. Sign in instead.' });
    }
    if (!isLoopback(req)) {
      return res.status(403).json({ error: true, code: 'SETUP_LOCAL_ONLY', message: 'The first proctor account must be created on the computer running the exam server.' });
    }
    const { name, email, password } = req.body || {};
    if (!password) return res.status(400).json({ error: true, code: 'WEAK_PASSWORD', message: 'Choose a password of at least 8 characters.' });
    const created = authService.createProctor({ name, email, password, isOwner: true });
    const datastore = require('../db/datastore');
    return res.status(201).json({ ...authService.issueProctorToken(datastore.getProctor(created.id)), proctorId: created.id });
  } catch (err) { return sendError(res, next, err); }
});

// GET /api/auth/proctors — list proctor accounts
router.get('/proctors', requireProctor, (req, res) => {
  const datastore = require('../db/datastore');
  res.status(200).json(datastore.listProctors().map(p => authService.publicProctor(p)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
});

// POST /api/auth/proctors — the owner adds a proctor; the generated password is shown once
router.post('/proctors', requireOwnerProctor, (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    const created = authService.createProctor({ name, email, createdBy: req.user && req.user.proctorId });
    return res.status(201).json(created);
  } catch (err) { return sendError(res, next, err); }
});

// PATCH /api/auth/proctors/:id — enable/disable an account (owner only; the owner can't disable itself)
router.patch('/proctors/:id', requireOwnerProctor, (req, res) => {
  const datastore = require('../db/datastore');
  const target = datastore.getProctor(req.params.id);
  if (!target) return res.status(404).json({ error: true, message: 'Proctor not found' });
  if (target.isOwner) return res.status(400).json({ error: true, message: 'The owner account cannot be disabled.' });
  const updated = datastore.saveProctor({ id: target.id, disabled: Boolean(req.body && req.body.disabled) });
  return res.status(200).json(authService.publicProctor(updated));
});

// POST /api/auth/proctor/password — change your own password
router.post('/proctor/password', requireProctor, (req, res, next) => {
  try {
    if (!req.user || !req.user.proctorId) return res.status(400).json({ error: true, message: 'This login has no proctor account.' });
    const { currentPassword, newPassword } = req.body || {};
    return res.status(200).json(authService.changeProctorPassword(req.user.proctorId, currentPassword, newPassword));
  } catch (err) { return sendError(res, next, err); }
});

// POST /api/auth/proctor/login
router.post('/proctor/login', (req, res, next) => {
  try {
    const { username, proctorId, password } = req.body || {};
    const result = authService.loginProctor(String(proctorId || username || '').trim(), password);
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
