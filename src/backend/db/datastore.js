const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Unambiguous characters only (no 0/O, 1/I/L) — codes are read aloud and typed by candidates.
const PERSIST_DEBOUNCE_MS = 1000;

const EXAM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizeExamCode(code) {
  if (!code) return '';
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

class DataStore {
  constructor(options = {}) {
    this.filePath = options.filePath || config.DATASTORE_FILE;
    this.inMemoryOnly = options.inMemoryOnly ?? (config.ENV === 'test');
    this.isWriting = false;
    this.writeQueue = [];
    this.data = this._createEmptyState();

    // Collection adapters for flexible property-based access
    this.candidates = {
      findById: (id) => this.getCandidateById(id),
      findByEmail: (email) => this.getCandidateByEmail(email),
      create: (c) => this.addCandidate(c),
      update: (id, u) => this.updateCandidate(id, u),
      getAll: () => this.getAllCandidates()
    };

    this.sessions = {
      findById: (id) => this.getSession(id),
      create: (s) => this.createSession(s),
      update: (id, u) => this.updateSession(id, u),
      saveAnswer: (sId, qId, a) => this.saveAnswer(sId, qId, a),
      getAll: () => this.getAllSessions(),
      getAllActive: () => this.getAllSessions().filter(s => s.status === 'IN_PROGRESS'),
      find: (predicate = {}) => {
        const all = this.getAllSessions();
        if (typeof predicate === 'function') return all.filter(predicate);
        return all.filter(s => {
          for (const [k, v] of Object.entries(predicate)) {
            if (s[k] !== v) return false;
          }
          return true;
        });
      }
    };

    this.questions = {
      getAll: () => this.getAllQuestions(),
      findById: (id) => this.getQuestionById(id),
      set: (qs) => this.setQuestions(qs),
      getSanitized: () => this.getSanitizedQuestions()
    };

    this.exams = {
      findById: (id) => this.getExam(id),
      getAll: () => this.getAllExams(),
      save: (ex) => this.createOrUpdateExam(ex),
      updateRules: (id, rules) => this.updateExamRules(id, rules)
    };
  }

  _createEmptyState() {
    return {
      candidates: {},       // id -> Candidate
      candidateByEmail: {}, // email (lowercase) -> id
      otps: {},             // key (lowercase) -> { otp, studentId, expiresAt, attempts }
      sessions: {},         // sessionId -> AssessmentSession
      questions: [],        // Array of Question objects
      violations: [],       // Array of ProctorViolation objects
      tabActivities: [],    // Array of TabActivity objects
      inputActivities: [],  // Array of InputActivity objects
      exams: {}             // examId -> ExamConfiguration
    };
  }

  async init(options = {}) {
    if (options.filePath) this.filePath = options.filePath;
    if (options.inMemoryOnly !== undefined) this.inMemoryOnly = options.inMemoryOnly;

    if (this.inMemoryOnly) {
      this.reset();
      return;
    }

    const dataDir = path.dirname(this.filePath);
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (_) {}
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = { ...this._createEmptyState(), ...parsed };
      } catch (err) {
        console.warn(`[DataStore] Failed to read ${this.filePath}: ${err.message}. Starting fresh.`);
      }
    }

    // Attempt MongoDB Connection with Graceful Fallback
    try {
      const { MongoClient } = require('mongodb');
      const mongoUri = options.mongoUri || config.MONGODB_URI;
      const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 1200 });
      await client.connect();
      this.mongoClient = client;
      this.mongoDb = client.db();
      console.log(`[DataStore] MongoDB connected successfully to ${mongoUri}`);

      // Seed / Sync MongoDB with current state
      await this._syncToMongo();
    } catch (mErr) {
      console.log(`[DataStore] MongoDB not active at ${config.MONGODB_URI} (${mErr.message}). Operating with local JSON storage.`);
    }
  }

  async _syncToMongo() {
    if (!this.mongoDb) return;
    try {
      const sessionsColl = this.mongoDb.collection('sessions');
      const count = await sessionsColl.countDocuments();
      if (count === 0 && Object.keys(this.data.sessions).length > 0) {
        // Bulk import existing sessions to MongoDB
        const sessionDocs = Object.values(this.data.sessions).map(s => ({ _id: s.id, ...s }));
        await sessionsColl.insertMany(sessionDocs);
      }
    } catch (_) {}
  }

  _triggerPersistence() {
    // Optional PostgreSQL mirror for teachers (see db/postgresMirror.js); debounced internally.
    if (this.mirror) this.mirror.schedule(this.data);
    if (!this.inMemoryOnly) {
      // Coalesce bursts of telemetry into one write per second. Serialising the whole store
      // on every event blocked the event loop and made live proctoring stutter.
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          this.saveToDisk().catch((err) => {
            console.warn(`[DataStore] Async disk persistence warning: ${err.message}`);
          });
        }, PERSIST_DEBOUNCE_MS);
        if (this.persistTimer.unref) this.persistTimer.unref();
      }

      if (this.mongoDb) {
        this._asyncSaveToMongo().catch(() => {});
      }
    }
  }

  async _asyncSaveToMongo() {
    if (!this.mongoDb) return;
    try {
      // Async write to MongoDB collections
      const sessions = Object.values(this.data.sessions);
      if (sessions.length > 0) {
        const coll = this.mongoDb.collection('sessions');
        for (const s of sessions.slice(-10)) { // sync recent
          await coll.updateOne({ _id: s.id }, { $set: s }, { upsert: true });
        }
      }
    } catch (_) {}
  }

  saveToDisk() {
    if (this.inMemoryOnly) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ resolve, reject });
      this._drainQueue();
    });
  }

  async _drainQueue() {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;
    const batch = [...this.writeQueue];
    this.writeQueue = [];

    const dataDir = path.dirname(this.filePath);
    if (!fs.existsSync(dataDir)) {
      try {
        await fs.promises.mkdir(dataDir, { recursive: true });
      } catch (_) {}
    }

    const tempFile = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;

    try {
      // Live camera frames are transient: keep them in memory only.
      const serialized = JSON.stringify(this.data, (key, value) => (key === 'lastSnapshot' ? undefined : value));
      await fs.promises.writeFile(tempFile, serialized, 'utf8');

      // Windows EPERM/EBUSY retry loop
      let delay = 10;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await fs.promises.rename(tempFile, this.filePath);
          break;
        } catch (err) {
          if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < 5) {
            await new Promise((r) => setTimeout(r, delay));
            delay *= 2;
          } else {
            try { await fs.promises.unlink(tempFile); } catch (_) {}
            throw err;
          }
        }
      }
      batch.forEach((p) => p.resolve());
    } catch (err) {
      batch.forEach((p) => p.reject(err));
    } finally {
      this.isWriting = false;
      this._drainQueue();
    }
  }

  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.saveToDisk();
  }

  reset() {
    this.data = this._createEmptyState();
  }

  // --- Candidates ---
  addCandidate(candidate) {
    if (!candidate || !candidate.id) return null;
    this.data.candidates[candidate.id] = { ...candidate };
    if (candidate.email) {
      this.data.candidateByEmail[candidate.email.toLowerCase()] = candidate.id;
    }
    this._triggerPersistence();
    return { ...this.data.candidates[candidate.id] };
  }

  getCandidateById(id) {
    if (!id) return null;
    return this.data.candidates[id] ? { ...this.data.candidates[id] } : null;
  }

  getCandidateByEmail(email) {
    if (!email) return null;
    const id = this.data.candidateByEmail[email.toLowerCase()];
    return id ? this.getCandidateById(id) : null;
  }

  updateCandidate(id, updates) {
    if (!id || !this.data.candidates[id]) return null;
    this.data.candidates[id] = { ...this.data.candidates[id], ...updates };
    if (updates.email) {
      this.data.candidateByEmail[updates.email.toLowerCase()] = id;
    }
    this._triggerPersistence();
    return { ...this.data.candidates[id] };
  }

  getAllCandidates() {
    return Object.values(this.data.candidates).map((c) => ({ ...c }));
  }

  // --- OTP Authentication ---
  setOtp(key, record) {
    if (!key) return;
    this.data.otps[key.toLowerCase()] = { ...record };
    this._triggerPersistence();
  }

  getOtp(key) {
    if (!key) return null;
    const record = this.data.otps[key.toLowerCase()];
    return record ? { ...record } : null;
  }

  deleteOtp(key) {
    if (!key) return;
    delete this.data.otps[key.toLowerCase()];
    this._triggerPersistence();
  }

  // --- Questions ---
  setQuestions(questions) {
    if (!Array.isArray(questions)) return;
    this.data.questions = questions.map((q) => ({
      ...q,
      text: q.text || q.prompt,
      prompt: q.prompt || q.text
    }));
    this._triggerPersistence();
  }

  _ensureQuestionsLoaded() {
    // Fixture questions exist only for the in-memory test suite; real exams carry their own.
    if (this.inMemoryOnly && this.data.questions.length === 0) {
      try {
        const { loadSeedQuestions } = require('./seed');
        this.setQuestions(loadSeedQuestions());
      } catch (_) {}
    }
  }

  getAllQuestions() {
    this._ensureQuestionsLoaded();
    const examQuestions = Object.values(this.data.exams || {}).flatMap(e => e.questions || []);
    return [...this.data.questions, ...examQuestions].map((q) => ({ ...q }));
  }

  getSanitizedQuestions() {
    this._ensureQuestionsLoaded();
    return this.data.questions.map((q) => {
      const { correctOptionId, explanation, ...sanitized } = q;
      return {
        ...sanitized,
        text: sanitized.text || sanitized.prompt,
        prompt: sanitized.prompt || sanitized.text
      };
    });
  }

  getQuestionById(id) {
    const q = this.getAllQuestions().find((item) => item.id === id);
    return q || null;
  }

  // --- Assessment Sessions ---
  createSession(session) {
    if (!session) return null;
    const sId = session.id || session.sessionId;
    const cleanSession = {
      ...session,
      id: sId,
      sessionId: sId,
      answers: session.answers || {},
      flaggedQuestions: session.flaggedQuestions || [],
      violations: session.violations || [],
      tabEvents: session.tabEvents || [],
      searchEvents: session.searchEvents || [],
      inputEvents: session.inputEvents || []
    };
    this.data.sessions[sId] = cleanSession;
    this._triggerPersistence();
    return { ...this.data.sessions[sId] };
  }

  getSession(id) {
    if (!id) return null;
    return this.data.sessions[id] ? { ...this.data.sessions[id] } : null;
  }

  updateSession(id, updates) {
    if (!id || !this.data.sessions[id]) return null;
    const existing = this.data.sessions[id];
    this.data.sessions[id] = { ...existing, ...updates };
    this._triggerPersistence();
    return { ...this.data.sessions[id] };
  }

  saveAnswer(sessionId, questionId, answerData) {
    const session = this.data.sessions[sessionId];
    if (!session) return null;
    if (!session.answers) session.answers = {};
    const record = typeof answerData === 'object' && answerData !== null
      ? { ...answerData }
      : { questionId, selectedOptionId: answerData, savedAt: Date.now() };
    session.answers[questionId] = record;
    this._triggerPersistence();
    return session.answers[questionId];
  }

  getAllSessions() {
    return Object.values(this.data.sessions).map((s) => ({ ...s }));
  }

  // --- Proctoring Violations ---
  addViolation(violation) {
    if (!violation) return null;
    if (!violation.id) violation.id = `viol_${crypto.randomUUID().slice(0, 8)}`;
    this.data.violations.push({ ...violation });
    this._triggerPersistence();
    return violation;
  }

  getViolationsBySession(sessionId) {
    return this.data.violations
      .filter((v) => v.sessionId === sessionId)
      .map((v) => ({ ...v }));
  }

  // --- Tab & Search Activity Tracking ---
  addTabActivity(activity) {
    if (!activity) return null;
    this.data.tabActivities.push({ ...activity });
    this._triggerPersistence();
    return activity;
  }

  getTabActivitiesBySession(sessionId) {
    return this.data.tabActivities
      .filter((a) => a.sessionId === sessionId)
      .map((a) => ({ ...a }));
  }

  // --- Keystroke & Mouse Input Tracking ---
  addInputActivity(input) {
    if (!input) return null;
    this.data.inputActivities.push({ ...input });
    this._triggerPersistence();
    return input;
  }

  getInputActivitiesBySession(sessionId) {
    return this.data.inputActivities
      .filter((i) => i.sessionId === sessionId)
      .map((i) => ({ ...i }));
  }

  // --- Exam Configurations & Feature Toggles ---
  getExam(id) {
    if (!id || !this.data.exams) return null;
    return this.data.exams[id] ? { ...this.data.exams[id] } : null;
  }

  getExamByCode(code) {
    const clean = normalizeExamCode(code);
    if (!clean || !this.data.exams) return null;
    const exam = Object.values(this.data.exams).find(e => e.code === clean);
    return exam ? { ...exam } : null;
  }

  generateExamCode() {
    const taken = new Set(Object.values(this.data.exams || {}).map(e => e.code));
    let code;
    do {
      code = Array.from(crypto.randomBytes(6), b => EXAM_CODE_ALPHABET[b % EXAM_CODE_ALPHABET.length]).join('');
    } while (taken.has(code));
    return code;
  }

  getAllExams() {
    if (!this.data.exams) return [];
    return Object.values(this.data.exams).map(e => ({ ...e }));
  }

  createOrUpdateExam(exam) {
    if (!exam || !exam.id) return null;
    if (!this.data.exams) this.data.exams = {};
    const existing = this.data.exams[exam.id] || {};
    this.data.exams[exam.id] = {
      ...existing,
      ...exam,
      code: existing.code || normalizeExamCode(exam.code) || this.generateExamCode(),
      rules: {
        enableVisionProctoring: true,
        enableMultiTab: true,
        enableAiGuard: true,
        enableClipboardProtection: true,
        enableGuidedAssistant: true,
        maxStrikes: 3,
        strictness: 'standard',
        ...(existing.rules || {}),
        ...(exam.rules || {})
      },
      updatedAt: Date.now()
    };
    this._triggerPersistence();
    return this.data.exams[exam.id];
  }

  updateExamRules(examId, rules = {}) {
    if (!examId || !this.data.exams || !this.data.exams[examId]) {
      return null;
    }
    const exam = this.data.exams[examId];
    exam.rules = {
      ...(exam.rules || {}),
      ...rules
    };
    exam.updatedAt = Date.now();
    this._triggerPersistence();
    return exam;
  }
}

// Global singleton instance
const datastore = new DataStore();

module.exports = datastore;
module.exports.datastore = datastore;
module.exports.DataStore = DataStore;
module.exports.normalizeExamCode = normalizeExamCode;
