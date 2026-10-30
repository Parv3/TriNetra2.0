/**
 * Contract Reference Server for Opaque-Box E2E Testing
 *
 * Implements the exact HTTP REST API interface specification defined in PROJECT.md:
 * - Dual-factor authentication (OTP and Facial verification)
 * - Sanitized MCQ delivery & grading
 * - Server-authoritative timer with auto-submit timeout sweeper
 * - Real-time proctoring telemetry ingestion (violations, tab switches, search queries, inputs)
 * - Multi-strike disqualification rule engine
 * - Full session audit reporting and HTML/JSON export
 *
 * Used by E2E test runner when running against a fresh environment or during CI,
 * and dynamically defers to src/backend/app.js when implemented.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const url = require('node:url');

const SEED_QUESTIONS = [
  {
    id: 'q1',
    text: 'What is the time complexity of searching in a balanced Binary Search Tree?',
    category: 'Algorithms',
    options: [
      { id: 'opt_1a', text: 'O(1)' },
      { id: 'opt_1b', text: 'O(log n)' },
      { id: 'opt_1c', text: 'O(n)' },
      { id: 'opt_1d', text: 'O(n^2)' }
    ],
    correctOptionId: 'opt_1b',
    explanation: 'A balanced BST divides search space in half at each step, yielding logarithmic O(log n) time.'
  },
  {
    id: 'q2',
    text: 'Which HTTP status code indicates that a client must authenticate itself to get the requested response?',
    category: 'Web Networking',
    options: [
      { id: 'opt_2a', text: '400 Bad Request' },
      { id: 'opt_2b', text: '401 Unauthorized' },
      { id: 'opt_2c', text: '403 Forbidden' },
      { id: 'opt_2d', text: '404 Not Found' }
    ],
    correctOptionId: 'opt_2b',
    explanation: '401 Unauthorized indicates that the request lacks valid authentication credentials.'
  },
  {
    id: 'q3',
    text: 'What is the primary role of Electron contextBridge in desktop applications?',
    category: 'Desktop Architecture',
    options: [
      { id: 'opt_3a', text: 'To compile native C++ modules' },
      { id: 'opt_3b', text: 'To securely expose controlled APIs from preload script to isolated renderer' },
      { id: 'opt_3c', text: 'To download offline AI weights from the internet' },
      { id: 'opt_3d', text: 'To bypass Node.js security sandbox' }
    ],
    correctOptionId: 'opt_3b',
    explanation: 'contextBridge allows safe IPC exposure without disabling context isolation or granting renderer direct Node access.'
  },
  {
    id: 'q4',
    text: 'In offline computer vision proctoring, what metric is typically used to detect natural blinks without false gaze diversion?',
    category: 'Computer Vision',
    options: [
      { id: 'opt_4a', text: 'EAR (Eye Aspect Ratio) under 400ms duration' },
      { id: 'opt_4b', text: 'Euler Yaw angle greater than 45 degrees' },
      { id: 'opt_4c', text: 'Offscreen canvas frame width' },
      { id: 'opt_4d', text: 'WebP snapshot byte size' }
    ],
    correctOptionId: 'opt_4a',
    explanation: 'Eye Aspect Ratio drops momentarily during a natural blink (<400ms), which hysteresis debouncing distinguishes from prolonged eye closure.'
  },
  {
    id: 'q5',
    text: 'Which data structure is best suited for implementing a server-side LRU cache?',
    category: 'Data Structures',
    options: [
      { id: 'opt_5a', text: 'Singly Linked List' },
      { id: 'opt_5b', text: 'Hash Map combined with Doubly Linked List' },
      { id: 'opt_5c', text: 'Binary Heap' },
      { id: 'opt_5d', text: 'Stack' }
    ],
    correctOptionId: 'opt_5b',
    explanation: 'Combining a hash map for O(1) lookup with a doubly linked list for O(1) node repositioning gives optimal LRU cache performance.'
  },
  {
    id: 'q6',
    text: 'Which protocol is strictly recommended for production WebSocket communication?',
    category: 'Web Networking',
    options: [
      { id: 'opt_6a', text: 'ws://' },
      { id: 'opt_6b', text: 'wss://' },
      { id: 'opt_6c', text: 'ftp://' },
      { id: 'opt_6d', text: 'http://' }
    ],
    correctOptionId: 'opt_6b',
    explanation: 'wss:// encrypts traffic via TLS, preventing eavesdropping and proxy tampering.'
  },
  {
    id: 'q7',
    text: 'In atomic file writing, what technique guarantees crash resilience?',
    category: 'Systems Programming',
    options: [
      { id: 'opt_7a', text: 'Direct in-place file overwriting' },
      { id: 'opt_7b', text: 'Writing to a temporary sibling file and executing an atomic filesystem rename' },
      { id: 'opt_7c', text: 'Flushing console logs before each write' },
      { id: 'opt_7d', text: 'Disabling file permissions' }
    ],
    correctOptionId: 'opt_7b',
    explanation: 'Atomic rename replaces the target file atomically at the OS filesystem level, preventing partially-written corrupted files.'
  },
  {
    id: 'q8',
    text: 'What does the Euler yaw angle measure in head pose estimation?',
    category: 'Computer Vision',
    options: [
      { id: 'opt_8a', text: 'Horizontal turning of the head (looking left or right)' },
      { id: 'opt_8b', text: 'Vertical tilting of the head (looking up or down)' },
      { id: 'opt_8c', text: 'Lateral tilting towards the shoulder' },
      { id: 'opt_8d', text: 'Distance of the nose from the webcam' }
    ],
    correctOptionId: 'opt_8a',
    explanation: 'Yaw represents horizontal rotation around the vertical Y-axis (turning head left or right).'
  },
  {
    id: 'q9',
    text: 'Which HTTP method should be used for idempotent answer updates in a REST API?',
    category: 'API Design',
    options: [
      { id: 'opt_9a', text: 'POST or PUT' },
      { id: 'opt_9b', text: 'DELETE only' },
      { id: 'opt_9c', text: 'TRACE' },
      { id: 'opt_9d', text: 'CONNECT' }
    ],
    correctOptionId: 'opt_9a',
    explanation: 'PUT (or parameterized POST with resource ID) allows clients to update state idempotently without side-effect duplication.'
  },
  {
    id: 'q10',
    text: 'What is the default strike threshold that triggers automated disqualification in the proctoring engine?',
    category: 'Proctoring Rules',
    options: [
      { id: 'opt_10a', text: '1 strike' },
      { id: 'opt_10b', text: '3 strikes' },
      { id: 'opt_10c', text: '20 strikes' },
      { id: 'opt_10d', text: 'Unlimited strikes' }
    ],
    correctOptionId: 'opt_10b',
    explanation: '3 strikes is the standard competition threshold before automated test termination / disqualification.'
  }
];

class ContractServer {
  constructor(options = {}) {
    this.port = options.port || 0;
    this.maxStrikes = options.maxStrikes || 3;
    this.gracePeriodMs = options.gracePeriodMs || 2000;
    this.server = null;
    this.actualPort = 0;

    // In-memory data store
    this.otpStore = new Map(); // studentId -> { otp, expiresAt }
    this.tokenStore = new Map(); // token -> { studentId, createdAt }
    this.faceBaselineStore = new Map(); // studentId -> { imageBase64, descriptor, verified: true }
    this.sessions = new Map(); // sessionId -> session object
    this.questionBank = [...SEED_QUESTIONS];
  }

  reset() {
    this.otpStore.clear();
    this.tokenStore.clear();
    this.faceBaselineStore.clear();
    this.sessions.clear();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        const address = this.server.address();
        this.actualPort = typeof address === 'object' && address ? address.port : 0;
        resolve(this.actualPort);
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  // Parse JSON body helper
  parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) { // 10MB limit
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body.trim()) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }

  sendJson(res, statusCode, data) {
    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(payload);
  }

  sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Access-Control-Allow-Origin': '*'
    });
    res.end(html);
  }

  sendError(res, statusCode, message, details = {}) {
    this.sendJson(res, statusCode, {
      error: true,
      statusCode,
      message,
      ...details
    });
  }

  extractBearerToken(req) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    return null;
  }

  checkAuth(req, res) {
    const token = this.extractBearerToken(req);
    if (!token || !this.tokenStore.has(token)) {
      this.sendError(res, 401, 'Unauthorized: Missing or invalid Bearer token');
      return null;
    }
    return this.tokenStore.get(token);
  }

  async handleRequest(req, res) {
    const fullUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = fullUrl.pathname;
    const searchParams = fullUrl.searchParams;
    const method = req.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      return res.end();
    }

    try {
      // 1. Health check
      if (pathname === '/api/health' && method === 'GET') {
        return this.sendJson(res, 200, { status: 'OK', uptime: process.uptime(), timestamp: Date.now() });
      }

      // 2. Auth OTP Request
      if (pathname === '/api/auth/otp/request' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const studentId = body.studentId;
        if (!studentId || typeof studentId !== 'string' || studentId.trim().length === 0) {
          return this.sendError(res, 400, 'studentId is required and must be a non-empty string');
        }
        if (/[<>{}]/.test(studentId)) {
          return this.sendError(res, 400, 'studentId contains disallowed special characters');
        }
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
        this.otpStore.set(studentId.trim(), { otp, expiresAt });
        return this.sendJson(res, 200, {
          message: 'OTP generated successfully',
          studentId: studentId.trim(),
          otp, // In demo / local mode, returned for test automation
          expiresInSeconds: 300
        });
      }

      // 3. Auth OTP Verify
      if (pathname === '/api/auth/otp/verify' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { studentId, otp } = body;
        if (!studentId || !otp) {
          return this.sendError(res, 400, 'studentId and otp are required');
        }
        const record = this.otpStore.get(studentId.trim());
        if (!record) {
          return this.sendError(res, 401, 'No OTP requested for this student ID');
        }
        if (Date.now() > record.expiresAt) {
          return this.sendError(res, 401, 'OTP has expired');
        }
        if (record.otp !== String(otp).trim()) {
          return this.sendError(res, 401, 'Invalid OTP provided');
        }

        const token = `sess_tok_${crypto.randomUUID()}`;
        this.tokenStore.set(token, { studentId: studentId.trim(), createdAt: Date.now() });
        return this.sendJson(res, 200, {
          token,
          session: {
            studentId: studentId.trim(),
            authenticatedAt: Date.now(),
            authMethod: 'OTP'
          }
        });
      }

      // 4. Face Baseline Verification
      if (pathname === '/api/auth/face/verify' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { studentId, imageBase64, descriptor } = body;
        if (!studentId || typeof studentId !== 'string') {
          return this.sendError(res, 400, 'studentId is required');
        }
        if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length < 10) {
          return this.sendError(res, 400, 'Valid base64 image data is required');
        }
        this.faceBaselineStore.set(studentId.trim(), {
          imageBase64: imageBase64.substring(0, 100) + '...',
          descriptor: descriptor || [0.12, -0.45, 0.88],
          verified: true,
          registeredAt: Date.now()
        });
        return this.sendJson(res, 200, {
          verified: true,
          similarity: 0.98,
          studentId: studentId.trim(),
          message: 'Facial baseline registered successfully'
        });
      }

      // 5. MCQ Question Delivery (Sanitized)
      if (pathname === '/api/assessment/questions' && method === 'GET') {
        const auth = this.checkAuth(req, res);
        if (!auth) return;

        // Strictly sanitize: NEVER return correctOptionId or explanation to test-taker
        const sanitizedQuestions = this.questionBank.map(q => ({
          id: q.id,
          text: q.text,
          category: q.category,
          options: q.options.map(opt => ({ id: opt.id, text: opt.text }))
        }));
        return this.sendJson(res, 200, sanitizedQuestions);
      }

      // 6. Start Assessment Session
      if (pathname === '/api/assessment/session/start' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const durationMinutes = body.durationMinutes !== undefined ? Number(body.durationMinutes) : 30;
        if (isNaN(durationMinutes) || durationMinutes < 0) {
          return this.sendError(res, 400, 'durationMinutes must be a non-negative number');
        }
        // Cap excessive durations
        const effectiveDuration = Math.min(Math.max(durationMinutes, 0), 180);
        const sessionId = `sess_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const expiresAt = startedAt + (effectiveDuration * 60 * 1000);

        const session = {
          sessionId,
          studentId: body.studentId || 'STUDENT_DEFAULT',
          startedAt,
          expiresAt,
          durationMinutes: effectiveDuration,
          status: 'IN_PROGRESS',
          strikes: 0,
          answers: {},
          flaggedQuestions: [],
          violations: [],
          tabEvents: [],
          searchEvents: [],
          inputEvents: [],
          score: null,
          total: this.questionBank.length,
          results: null,
          submittedAt: null
        };
        this.sessions.set(sessionId, session);

        return this.sendJson(res, 200, {
          sessionId,
          startedAt,
          expiresAt,
          durationMinutes: effectiveDuration
        });
      }

      // 7. Get Timer Status
      const timerMatch = pathname.match(/^\/api\/assessment\/session\/([^/]+)\/timer$/);
      if (timerMatch && method === 'GET') {
        const sessionId = timerMatch[1];
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }

        const now = Date.now();
        let remainingSeconds = Math.max(0, Math.round((session.expiresAt - now) / 1000));

        // Active sweeper timeout transition
        if (now >= session.expiresAt && session.status === 'IN_PROGRESS') {
          session.status = 'AUTO_SUBMITTED_TIMEOUT';
          session.submittedAt = session.expiresAt;
          this.gradeSession(session);
        }

        return this.sendJson(res, 200, {
          sessionId,
          remainingSeconds,
          status: session.status,
          serverTime: now,
          expiresAt: session.expiresAt
        });
      }

      // 8. Submit Answer
      if (pathname === '/api/assessment/answer' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId, questionId, selectedOptionId, flagged } = body;

        if (!sessionId || !questionId) {
          return this.sendError(res, 400, 'sessionId and questionId are required');
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }

        // Active sweeper check
        const now = Date.now();
        if (now > session.expiresAt + this.gracePeriodMs && session.status === 'IN_PROGRESS') {
          session.status = 'AUTO_SUBMITTED_TIMEOUT';
          session.submittedAt = session.expiresAt;
          this.gradeSession(session);
        }

        if (session.status === 'AUTO_SUBMITTED_TIMEOUT') {
          return this.sendError(res, 403, 'Test session has expired and was automatically submitted');
        }
        if (session.status === 'DISQUALIFIED') {
          return this.sendError(res, 403, 'Test session has been disqualified due to proctoring violations');
        }
        if (session.status === 'SUBMITTED') {
          return this.sendError(res, 400, 'Test session has already been submitted');
        }

        const question = this.questionBank.find(q => q.id === questionId);
        if (!question) {
          return this.sendError(res, 404, `Question not found with id: ${questionId}`);
        }

        if (selectedOptionId !== undefined && selectedOptionId !== null) {
          if (typeof selectedOptionId !== 'string' || selectedOptionId.trim() === '') {
            return this.sendError(res, 400, 'selectedOptionId must be a non-empty string');
          }
          const validOption = question.options.some(opt => opt.id === selectedOptionId);
          if (!validOption) {
            return this.sendError(res, 400, `Invalid selectedOptionId: ${selectedOptionId} for question: ${questionId}`);
          }
          session.answers[questionId] = selectedOptionId;
        }

        if (flagged !== undefined) {
          const index = session.flaggedQuestions.indexOf(questionId);
          if (flagged && index === -1) {
            session.flaggedQuestions.push(questionId);
          } else if (!flagged && index !== -1) {
            session.flaggedQuestions.splice(index, 1);
          }
        }

        return this.sendJson(res, 200, {
          saved: true,
          questionId,
          selectedOptionId: session.answers[questionId] || null,
          flagged: session.flaggedQuestions.includes(questionId)
        });
      }

      // 9. Final Exam Submission
      if (pathname === '/api/assessment/submit' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId } = body;
        if (!sessionId) {
          return this.sendError(res, 400, 'sessionId is required');
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }
        if (session.status === 'SUBMITTED') {
          return this.sendJson(res, 200, {
            status: 'SUBMITTED',
            message: 'Session was already submitted',
            score: session.score,
            total: session.total,
            results: session.results
          });
        }
        if (session.status === 'DISQUALIFIED') {
          return this.sendError(res, 403, 'Session is disqualified and cannot be submitted');
        }

        session.status = 'SUBMITTED';
        session.submittedAt = Date.now();
        this.gradeSession(session);

        return this.sendJson(res, 200, {
          status: 'SUBMITTED',
          score: session.score,
          total: session.total,
          percentage: Math.round((session.score / session.total) * 100),
          results: session.results
        });
      }

      // 10. Proctor Violation Ingestion
      if (pathname === '/api/proctor/violation' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId, type, details, snapshotBase64, immediateDisqualify } = body;

        if (!sessionId || !type) {
          return this.sendError(res, 400, 'sessionId and type are required');
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }

        // Validate snapshot size if present
        let cleanSnapshot = snapshotBase64 || null;
        if (cleanSnapshot && cleanSnapshot.length > 5 * 1024 * 1024) {
          return this.sendError(res, 413, 'Snapshot payload exceeds maximum allowed size (5MB)');
        }

        session.strikes += 1;
        const violationRecord = {
          id: `viol_${crypto.randomUUID()}`,
          timestamp: Date.now(),
          type,
          details: details || {},
          snapshot: cleanSnapshot ? cleanSnapshot.substring(0, 100) + '...' : null,
          hasSnapshot: !!cleanSnapshot,
          strikeIndex: session.strikes
        };
        session.violations.push(violationRecord);

        let action = 'WARN';
        if (session.strikes >= this.maxStrikes || immediateDisqualify) {
          action = 'DISQUALIFY';
          session.status = 'DISQUALIFIED';
          this.gradeSession(session); // Grade existing answers
        }

        return this.sendJson(res, 200, {
          recorded: true,
          strikeCount: session.strikes,
          action,
          violationId: violationRecord.id,
          sessionStatus: session.status
        });
      }

      // 11. Tab Event Logging
      if (pathname === '/api/proctor/tab-event' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId, type, url: targetUrl, title } = body;
        if (!sessionId || !type || !targetUrl) {
          return this.sendError(res, 400, 'sessionId, type, and url are required');
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }
        const eventRecord = {
          id: `tab_${crypto.randomUUID()}`,
          timestamp: Date.now(),
          type,
          url: targetUrl,
          title: title || ''
        };
        session.tabEvents.push(eventRecord);
        return this.sendJson(res, 200, { recorded: true, eventId: eventRecord.id });
      }

      // 12. Search & AI Prompt Logging
      if (pathname === '/api/proctor/search-event' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId, service, query, url: targetUrl } = body;
        if (!sessionId || !service) {
          return this.sendError(res, 400, 'sessionId and service are required');
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }
        const eventRecord = {
          id: `search_${crypto.randomUUID()}`,
          timestamp: Date.now(),
          service,
          query: query !== undefined ? String(query) : '',
          url: targetUrl || ''
        };
        session.searchEvents.push(eventRecord);
        return this.sendJson(res, 200, { recorded: true, eventId: eventRecord.id });
      }

      // 13. Input Activity Logging (Keystroke & Mouse)
      if (pathname === '/api/proctor/input-activity' && method === 'POST') {
        const body = await this.parseJsonBody(req);
        const { sessionId, type, data } = body;
        if (!sessionId || !type) {
          return this.sendError(res, 400, 'sessionId and type are required');
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }
        const eventRecord = {
          id: `input_${crypto.randomUUID()}`,
          timestamp: Date.now(),
          type,
          data: data || {}
        };
        session.inputEvents.push(eventRecord);
        return this.sendJson(res, 200, { recorded: true, eventId: eventRecord.id });
      }

      // 14. Audit Session Report & Export
      const auditMatch = pathname.match(/^\/api\/audit\/session\/([^/]+)\/(report|export)$/);
      if (auditMatch && method === 'GET') {
        const sessionId = auditMatch[1];
        const endpointType = auditMatch[2];
        const session = this.sessions.get(sessionId);
        if (!session) {
          return this.sendError(res, 404, 'Session not found');
        }

        const sinceParam = searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : 0;
        const filterEvents = (arr) => arr.filter(e => e.timestamp >= since);

        const reportData = {
          session: {
            sessionId: session.sessionId,
            studentId: session.studentId,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            submittedAt: session.submittedAt,
            status: session.status,
            strikeCount: session.strikes,
            score: session.score,
            total: session.total
          },
          summary: {
            totalViolations: session.violations.length,
            totalTabSwitches: session.tabEvents.length,
            totalSearchQueries: session.searchEvents.length,
            totalInputBursts: session.inputEvents.length
          },
          violations: filterEvents(session.violations),
          tabEvents: filterEvents(session.tabEvents),
          searchEvents: filterEvents(session.searchEvents),
          inputEvents: filterEvents(session.inputEvents),
          results: session.results
        };

        if (searchParams.get('format') === 'html' || endpointType === 'export') {
          const html = this.renderAuditHtml(reportData);
          return this.sendHtml(res, 200, html);
        }

        return this.sendJson(res, 200, reportData);
      }

      // Unmatched endpoint
      return this.sendError(res, 404, `Endpoint not found: ${method} ${pathname}`);
    } catch (err) {
      return this.sendError(res, 500, `Internal server error: ${err.message}`);
    }
  }

  gradeSession(session) {
    let score = 0;
    const results = this.questionBank.map(q => {
      const selected = session.answers[q.id] || null;
      const isCorrect = selected === q.correctOptionId;
      if (isCorrect) score += 1;
      return {
        questionId: q.id,
        category: q.category,
        selectedOptionId: selected,
        correctOptionId: q.correctOptionId,
        isCorrect,
        explanation: q.explanation
      };
    });
    session.score = score;
    session.results = results;
  }

  renderAuditHtml(report) {
    const s = report.session;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Assessment Audit Report - ${this.escapeHtml(s.sessionId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; border: 1px solid #334155; }
    h1, h2 { color: #38bdf8; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: bold; }
    .badge-ok { background: #065f46; color: #34d399; }
    .badge-warn { background: #78350f; color: #fbbf24; }
    .badge-danger { background: #7f1d1d; color: #f87171; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; }
  </style>
</head>
<body>
  <h1>Proctoring Audit Trail</h1>
  <div class="card">
    <h2>Session Metadata</h2>
    <p><strong>Session ID:</strong> ${this.escapeHtml(s.sessionId)}</p>
    <p><strong>Student ID:</strong> ${this.escapeHtml(s.studentId)}</p>
    <p><strong>Status:</strong> <span class="badge ${s.status === 'SUBMITTED' ? 'badge-ok' : s.status === 'DISQUALIFIED' ? 'badge-danger' : 'badge-warn'}">${this.escapeHtml(s.status)}</span></p>
    <p><strong>Strikes:</strong> ${s.strikeCount} / ${this.maxStrikes}</p>
    <p><strong>Score:</strong> ${s.score !== null ? `${s.score} / ${s.total}` : 'Pending'}</p>
  </div>
  <div class="card">
    <h2>Violations (${report.violations.length})</h2>
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>Strike</th><th>Details</th></tr></thead>
      <tbody>
        ${report.violations.map(v => `<tr><td>${new Date(v.timestamp).toISOString()}</td><td>${this.escapeHtml(v.type)}</td><td>#${v.strikeIndex}</td><td>${this.escapeHtml(JSON.stringify(v.details))}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="card">
    <h2>Search & AI Queries (${report.searchEvents.length})</h2>
    <table>
      <thead><tr><th>Time</th><th>Service</th><th>Query</th></tr></thead>
      <tbody>
        ${report.searchEvents.map(sq => `<tr><td>${new Date(sq.timestamp).toISOString()}</td><td>${this.escapeHtml(sq.service)}</td><td>${this.escapeHtml(sq.query)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
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
}

module.exports = { ContractServer, SEED_QUESTIONS };
