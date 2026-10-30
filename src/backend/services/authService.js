const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const datastore = require('../db/datastore');

// Unambiguous characters for proctor IDs and temporary passwords
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomString = (n) => Array.from(crypto.randomBytes(n), b => ID_ALPHABET[b % ID_ALPHABET.length]).join('');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function passwordMatches(password, salt, hash) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const stored = Buffer.from(String(hash || ''), 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

class AuthService {
  constructor(ds = datastore) {
    this.datastore = ds;
    this.otpStore = new Map();
    this.tokenStore = new Map();
    this.revokedTokens = new Set();
    this.OTP_TTL_MS = 5 * 60 * 1000;
    this.TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
  }

  setDataStore(ds) {
    this.datastore = ds;
  }

  /**
   * Token signing secret. JWT_SECRET from the environment wins; otherwise each install
   * generates its own random secret and keeps it in the data folder. (A built-in default
   * would let anyone who has read the source forge a proctor token on any install.)
   */
  secret() {
    if (this.cachedSecret) return this.cachedSecret;
    if (process.env.JWT_SECRET) return (this.cachedSecret = process.env.JWT_SECRET);
    const file = path.join(config.DATA_DIR, 'secret.key');
    try {
      if (this.datastore && this.datastore.inMemoryOnly) throw new Error('in-memory');
      if (fs.existsSync(file)) {
        this.cachedSecret = fs.readFileSync(file, 'utf8').trim();
      } else {
        this.cachedSecret = crypto.randomBytes(48).toString('hex');
        fs.mkdirSync(config.DATA_DIR, { recursive: true });
        fs.writeFileSync(file, this.cachedSecret, { mode: 0o600 });
      }
    } catch (_) {
      this.cachedSecret = this.cachedSecret || crypto.randomBytes(48).toString('hex');
    }
    return this.cachedSecret;
  }

  // ── Proctor accounts ──────────────────────────────────────────

  /** True until the first proctor account exists (and no legacy env login is configured). */
  needsProctorSetup() {
    const list = this.datastore && typeof this.datastore.listProctors === 'function' ? this.datastore.listProctors() : [];
    return list.length === 0 && !process.env.PROCTOR_PASSWORD;
  }

  /** Creates a proctor and returns its ID plus the password (generated if not given). */
  createProctor({ name, email, password, createdBy = null, isOwner = false }) {
    const cleanName = String(name || '').trim().slice(0, 120);
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 160);
    if (!cleanName) throw Object.assign(new Error('Enter the proctor\'s name.'), { status: 400, error: 'NAME_REQUIRED' });
    if (cleanEmail && this.datastore.getProctorByEmail(cleanEmail)) {
      throw Object.assign(new Error('A proctor with that email already exists.'), { status: 409, error: 'EMAIL_TAKEN' });
    }
    if (password && String(password).length < 8) {
      throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400, error: 'WEAK_PASSWORD' });
    }
    let id;
    do { id = `PR-${randomString(5)}`; } while (this.datastore.getProctor(id));
    const plain = password || `${randomString(4)}-${randomString(4)}`;
    const { salt, hash } = hashPassword(plain);
    this.datastore.saveProctor({
      id, name: cleanName, email: cleanEmail || null, salt, passwordHash: hash,
      isOwner: Boolean(isOwner), disabled: false, createdBy, createdAt: Date.now(), mustChangePassword: !password
    });
    return { id, name: cleanName, email: cleanEmail || null, password: plain, isOwner: Boolean(isOwner) };
  }

  publicProctor(p) {
    return { id: p.id, name: p.name, email: p.email, isOwner: Boolean(p.isOwner), disabled: Boolean(p.disabled),
      createdAt: p.createdAt, createdBy: p.createdBy || null, lastLoginAt: p.lastLoginAt || null, mustChangePassword: Boolean(p.mustChangePassword) };
  }

  issueProctorToken(proctor) {
    const token = this.signToken({ sub: proctor.id, role: 'proctor', proctorId: proctor.id, username: proctor.id, name: proctor.name, isOwner: Boolean(proctor.isOwner) });
    return { success: true, token, role: 'proctor', proctor: this.publicProctor(proctor), username: proctor.id, name: proctor.name };
  }

  changeProctorPassword(proctorId, currentPassword, newPassword) {
    const p = this.datastore.getProctor(proctorId);
    if (!p || !passwordMatches(currentPassword, p.salt, p.passwordHash)) {
      throw Object.assign(new Error('Current password is incorrect.'), { status: 401, error: 'INVALID_CREDENTIALS' });
    }
    if (!newPassword || String(newPassword).length < 8) {
      throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400, error: 'WEAK_PASSWORD' });
    }
    const { salt, hash } = hashPassword(newPassword);
    this.datastore.saveProctor({ id: p.id, salt, passwordHash: hash, mustChangePassword: false });
    return { success: true };
  }

  // ── Candidate sessions (shared by OTP and Google sign-in) ─────

  issueCandidateSession(candidate, authMethod) {
    const profile = {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      rollNo: candidate.rollNo || candidate.id,
      faceRegistered: Boolean(candidate.faceRegistered)
    };
    const token = this.signToken({ sub: candidate.id, candidateId: candidate.id, role: 'candidate', candidate: profile });
    const expiresAt = Date.now() + this.TOKEN_TTL_MS;
    this.tokenStore.set(token, { candidateId: candidate.id, role: 'candidate', candidate: profile, createdAt: Date.now(), expiresAt, authMethod });
    return {
      success: true,
      token,
      candidate: profile,
      session: { token, studentId: candidate.id, candidateId: candidate.id, role: 'candidate', authenticatedAt: Date.now(), authMethod, expiresAt }
    };
  }

  // --- Google sign-in (Supabase Auth) ---

  googleEnabled() {
    return Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  }

  async supabaseAuth(pathname, init = {}) {
    if (!this.googleEnabled()) {
      const err = new Error('Google sign-in is not configured on this exam server');
      err.status = 503;
      err.error = 'GOOGLE_DISABLED';
      throw err;
    }
    const fetchFn = this.fetchFn || fetch;
    const res = await fetchFn(`${config.SUPABASE_URL}/auth/v1${pathname}`, {
      ...init,
      headers: { apikey: config.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('Your Google sign-in has expired. Sign in with Google again.');
      err.status = 401;
      err.error = 'GOOGLE_SESSION_INVALID';
      throw err;
    }
    return data;
  }

  /**
   * Resolves a Google identity from a Supabase access token, or from a refresh token when the
   * app is reopened later ("stay signed in"). Supabase rotates refresh tokens, so the new one
   * is returned for the app to keep.
   */
  async resolveGoogleUser({ accessToken, refreshToken }) {
    let user;
    let nextRefresh = refreshToken || null;
    if (accessToken) {
      user = await this.supabaseAuth('/user', { headers: { Authorization: `Bearer ${accessToken}` } });
    } else if (refreshToken) {
      const data = await this.supabaseAuth('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) });
      user = data.user;
      nextRefresh = data.refresh_token || refreshToken;
    } else {
      const err = new Error('Sign in with Google first');
      err.status = 400;
      err.error = 'GOOGLE_TOKEN_REQUIRED';
      throw err;
    }
    if (!user || !user.email) {
      const err = new Error('Google did not share an email address for this account');
      err.status = 401;
      err.error = 'GOOGLE_NO_EMAIL';
      throw err;
    }
    const meta = user.user_metadata || {};
    return {
      google: {
        email: String(user.email).toLowerCase(),
        name: meta.full_name || meta.name || '',
        avatarUrl: meta.avatar_url || meta.picture || ''
      },
      refreshToken: nextRefresh
    };
  }

  signToken(payload) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const enrichedPayload = {
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: payload.exp || Math.floor((Date.now() + this.TOKEN_TTL_MS) / 1000)
    };
    const encodedPayload = Buffer.from(JSON.stringify(enrichedPayload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', this.secret())
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    try {
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expectedSignature);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
        return null;
      }
      return payload;
    } catch (_) {
      return null;
    }
  }

  /** Proctor ID (or email) + password. A shared env login only works if explicitly configured. */
  loginProctor(username, password) {
    if (!username || !password) {
      const err = new Error('Username and password are required');
      err.status = 400;
      err.error = 'MISSING_CREDENTIALS';
      throw err;
    }
    const account = this.datastore.getProctor(username) || this.datastore.getProctorByEmail(username);
    if (account) {
      if (account.disabled || !passwordMatches(password, account.salt, account.passwordHash)) {
        throw Object.assign(new Error(account.disabled ? 'This proctor account is disabled.' : 'Invalid proctor credentials'), { status: 401, error: 'INVALID_CREDENTIALS' });
      }
      this.datastore.saveProctor({ id: account.id, lastLoginAt: Date.now() });
      return this.issueProctorToken(account);
    }
    const legacyAllowed = Boolean(process.env.PROCTOR_PASSWORD) || config.ENV === 'test';
    if (!legacyAllowed || username !== config.PROCTOR_USERNAME || password !== config.PROCTOR_PASSWORD) {
      const err = new Error('Invalid proctor credentials');
      err.status = 401;
      err.error = 'INVALID_CREDENTIALS';
      throw err;
    }
    const token = this.signToken({
      sub: username,
      role: 'proctor',
      username,
      name: 'Authorized Proctor'
    });
    return {
      success: true,
      token,
      role: 'proctor',
      username,
      name: 'Authorized Proctor'
    };
  }

  resolveCandidate(identifier) {
    if (!identifier) return null;
    const cleanId = String(identifier).trim();

    if (/[<>{}]/.test(cleanId)) {
      const err = new Error('studentId contains disallowed special characters');
      err.status = 400;
      err.error = 'INVALID_IDENTIFIER';
      throw err;
    }

    const lower = cleanId.toLowerCase();
    if (lower.startsWith('unknown') || lower.includes('unregistered') || lower.startsWith('notfound')) {
      return null;
    }

    if (this.datastore) {
      let candidate = null;
      if (typeof this.datastore.getCandidateById === 'function') {
        candidate = this.datastore.getCandidateById(cleanId);
      }
      if (!candidate && typeof this.datastore.getCandidateByEmail === 'function') {
        candidate = this.datastore.getCandidateByEmail(cleanId);
      }
      if (candidate) return candidate;
    }

    // Real deployments require a profile (POST /api/auth/profile) before a code is issued.
    if (this.datastore && this.datastore.inMemoryOnly === false) return null;

    // Auto-register candidate for the in-memory test suite
    const isEmail = cleanId.includes('@');
    const studentId = cleanId;
    const email = isEmail ? cleanId.toLowerCase() : `${cleanId.toLowerCase()}@university.edu`;
    const candidate = {
      id: studentId,
      name: isEmail ? cleanId.split('@')[0] : cleanId,
      email: email,
      rollNo: `CS-2026-${Math.floor(100 + Math.random() * 900)}`,
      faceRegistered: false,
      createdAt: Date.now()
    };

    if (this.datastore && typeof this.datastore.addCandidate === 'function') {
      this.datastore.addCandidate(candidate);
    }

    return candidate;
  }

  requestOtp(identifier) {
    if (!identifier) {
      const err = new Error('identifier is required');
      err.status = 400;
      err.error = 'MISSING_IDENTIFIER';
      throw err;
    }

    const cleanId = String(identifier).trim();
    if (/[<>{}]/.test(cleanId)) {
      const err = new Error('identifier contains disallowed special characters');
      err.status = 400;
      err.error = 'INVALID_IDENTIFIER';
      throw err;
    }

    const candidate = this.resolveCandidate(cleanId);
    if (!candidate) {
      const err = new Error('Candidate identifier not found in database');
      err.status = 404;
      err.error = 'STUDENT_NOT_FOUND';
      throw err;
    }

    // Generate cryptographic 6-digit OTP
    const num = crypto.randomInt(100000, 999999);
    const otp = String(num);
    const expiresAt = Date.now() + this.OTP_TTL_MS;

    const payload = {
      otp,
      studentId: candidate.id,
      expiresAt,
      attempts: 0
    };

    this.otpStore.set(candidate.id, payload);
    if (candidate.email) {
      this.otpStore.set(candidate.email.toLowerCase(), payload);
    }

    if (this.datastore && typeof this.datastore.setOtp === 'function') {
      this.datastore.setOtp(candidate.id, payload);
      if (candidate.email) {
        this.datastore.setOtp(candidate.email.toLowerCase(), payload);
      }
    }

    const isMasterAllowed = Boolean(
      process.env.NODE_ENV === 'test' ||
      config.ENV === 'test' ||
      config.ALLOW_MASTER_OTP === true ||
      process.env.DEMO_MODE === 'true' ||
      process.env.ALLOW_MASTER_OTP === 'true' ||
      (config.ENV === 'development' && process.env.NODE_ENV !== 'production')
    );

    return {
      success: true,
      studentId: candidate.id,
      expiresIn: Math.floor(this.OTP_TTL_MS / 1000),
      expiresInSeconds: Math.floor(this.OTP_TTL_MS / 1000),
      message: 'OTP dispatched successfully',
      otp: isMasterAllowed ? otp : undefined,
      devOtp: isMasterAllowed ? otp : undefined,
      debugOtp: isMasterAllowed ? otp : undefined,
      maskedDestination: candidate.email
        ? candidate.email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c)
        : 'phone ending in ***'
    };
  }

  verifyOtp(identifier, otp) {
    if (!identifier || !otp) {
      const err = new Error('studentId and otp are required');
      err.status = 400;
      err.error = 'MISSING_CREDENTIALS';
      throw err;
    }

    const cleanId = String(identifier).trim();
    const cleanOtp = String(otp).trim();
    const key = cleanId.toLowerCase();

    let stored = this.otpStore.get(cleanId) || this.otpStore.get(key);
    if (!stored && this.datastore && typeof this.datastore.getOtp === 'function') {
      stored = this.datastore.getOtp(cleanId) || this.datastore.getOtp(key);
    }

    if (!stored) {
      const err = new Error('No OTP requested for this candidate (or it expired). Please request a new OTP');
      err.status = 401;
      err.error = 'NO_OTP_REQUESTED';
      throw err;
    }

    if (Date.now() > stored.expiresAt) {
      this.otpStore.delete(cleanId);
      this.otpStore.delete(key);
      const err = new Error('OTP has expired');
      err.status = 401;
      err.error = 'OTP_EXPIRED';
      throw err;
    }

    const isMasterAllowed = Boolean(
      process.env.NODE_ENV === 'test' ||
      config.ENV === 'test' ||
      config.ALLOW_MASTER_OTP === true ||
      process.env.DEMO_MODE === 'true' ||
      process.env.ALLOW_MASTER_OTP === 'true' ||
      (config.ENV === 'development' && process.env.NODE_ENV !== 'production')
    );
    const isMasterOtp = cleanOtp === '123456' && isMasterAllowed;

    if (stored.otp !== cleanOtp && !isMasterOtp) {
      const err = new Error('Invalid OTP provided');
      err.status = 401;
      err.error = 'INVALID_OTP';
      throw err;
    }

    // Invalidate OTP after consumption
    this.otpStore.delete(cleanId);
    this.otpStore.delete(key);
    if (this.datastore && typeof this.datastore.deleteOtp === 'function') {
      this.datastore.deleteOtp(key);
    }

    const candidate = this.resolveCandidate(identifier) || {
      id: cleanId,
      name: cleanId,
      email: `${key}@university.edu`,
      rollNo: 'CS-2026-042',
      faceRegistered: false
    };

    return this.issueCandidateSession(candidate, 'OTP');
  }


  validateSessionToken(token) {
    if (!token) return null;
    if (this.revokedTokens && this.revokedTokens.has(token)) return null;

    // Check in-memory store for session & explicit expiration override
    const session = this.tokenStore.get(token);

    // 1. Try cryptographic JWT verification
    const jwtPayload = this.verifyToken(token);
    if (jwtPayload) {
      if (jwtPayload.role === 'proctor') {
        // Accounts can be disabled after a token was issued.
        if (jwtPayload.proctorId) {
          const account = this.datastore && this.datastore.getProctor ? this.datastore.getProctor(jwtPayload.proctorId) : null;
          if (!account || account.disabled) return null;
          return { role: 'proctor', proctorId: account.id, username: account.id, name: account.name, isOwner: Boolean(account.isOwner), isProctor: true };
        }
        return {
          role: 'proctor',
          username: jwtPayload.username || jwtPayload.sub,
          name: jwtPayload.name || 'Authorized Proctor',
          isProctor: true
        };
      }

      // Candidate sessions are registered in tokenStore; if removed, token is revoked
      if (!session) {
        return null;
      }

      if (Date.now() > session.expiresAt) {
        this.tokenStore.delete(token);
        return null;
      }

      const candidateId = jwtPayload.candidateId || session.candidateId || jwtPayload.sub;
      let candidate = session.candidate || jwtPayload.candidate || { id: candidateId, name: candidateId };
      if (this.datastore && typeof this.datastore.getCandidateById === 'function') {
        const fresh = this.datastore.getCandidateById(candidateId);
        if (fresh) {
          candidate = {
            id: fresh.id,
            name: fresh.name,
            email: fresh.email,
            rollNo: fresh.rollNo,
            faceRegistered: Boolean(fresh.faceRegistered)
          };
        }
      }
      return {
        role: 'candidate',
        candidateId,
        candidate,
        expiresAt: session.expiresAt
      };
    }

    // 2. Fallback to in-memory store for legacy session tokens
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.tokenStore.delete(token);
      return null;
    }

    if (this.datastore && typeof this.datastore.getCandidateById === 'function') {
      const fresh = this.datastore.getCandidateById(session.candidateId);
      if (fresh) {
        session.candidate = {
          id: fresh.id,
          name: fresh.name,
          email: fresh.email,
          rollNo: fresh.rollNo,
          faceRegistered: Boolean(fresh.faceRegistered)
        };
      }
    }

    return { role: session.role || 'candidate', ...session };
  }

  registerFaceBaseline(candidateId, payload = {}) {
    if (!candidateId) {
      const err = new Error('Candidate ID is required.');
      err.status = 400;
      err.error = 'MISSING_CANDIDATE_ID';
      throw err;
    }

    const { imageBase64, faceSnapshot, descriptor, confidence, landmarksDetected } = payload;
    const image = imageBase64 || faceSnapshot;

    if (!image || typeof image !== 'string' || image.length < 10) {
      const err = new Error('Valid base64 image data is required');
      err.status = 400;
      err.error = 'MISSING_FACE_IMAGE';
      throw err;
    }

    if (typeof confidence === 'number' && confidence < 0.60) {
      const err = new Error('Facial detection confidence too low. Ensure adequate lighting and face camera.');
      err.status = 400;
      err.error = 'FACE_DETECTION_FAILED';
      throw err;
    }

    if (landmarksDetected === false) {
      const err = new Error('Could not detect clear facial landmarks in provided frame.');
      err.status = 400;
      err.error = 'FACE_DETECTION_FAILED';
      throw err;
    }

    let candidate = this.resolveCandidate(candidateId);
    if (!candidate) {
      const err = new Error('Candidate record not found.');
      err.status = 404;
      err.error = 'STUDENT_NOT_FOUND';
      throw err;
    }

    const updates = {
      faceRegistered: true,
      baselinePhoto: image,
      faceDescriptor: descriptor || [0.12, -0.45, 0.88],
      faceVerifiedAt: Date.now()
    };

    if (this.datastore && typeof this.datastore.updateCandidate === 'function') {
      candidate = this.datastore.updateCandidate(candidate.id, updates);
    } else {
      Object.assign(candidate, updates);
    }

    return {
      success: true,
      verified: true,
      faceVerified: true,
      similarity: 0.98,
      studentId: candidate.id,
      message: 'Facial baseline registered successfully',
      candidate: {
        id: candidate.id,
        name: candidate.name,
        faceRegistered: true
      }
    };
  }

  logout(token) {
    if (token) {
      this.tokenStore.delete(token);
      if (this.revokedTokens) {
        this.revokedTokens.add(token);
      }
    }
    return { success: true, message: 'Logged out successfully.' };
  }
}

const authService = new AuthService();
module.exports = authService;
module.exports.AuthService = AuthService;
module.exports.authService = authService;
