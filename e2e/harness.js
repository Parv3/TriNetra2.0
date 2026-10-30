/**
 * Unified Test Harness for Opaque-Box E2E Testing
 *
 * Provides:
 * 1. Automatic backend boot / port resolution:
 *    - Connects to a live server on TEST_PORT/4100 only when E2E_LIVE_SERVER=1
 *    - Otherwise boots src/backend/app.js in memory
 *    - Or boots reference ContractServer conforming to PROJECT.md
 * 2. High-level API Client for all REST endpoints
 * 3. BrowserMock & VisionMock instances for UI and proctoring simulation
 */

const { ContractServer } = require('./helpers/contractServer');
const { BrowserMock } = require('./helpers/browserMock');
const { VisionHeuristicsMock } = require('./helpers/visionMock');
const http = require('node:http');

class E2EHarness {
  constructor(options = {}) {
    this.serverInstance = null;
    this.baseUrl = '';
    this.port = 0;
    this.isEmbeddedServer = false;
    this.browser = null;
    this.vision = null;
    this.maxStrikes = options.maxStrikes || 3;
  }

  async setup() {
    // 1. Only target a running server when explicitly asked (E2E_LIVE_SERVER=1). By default the
    // suite boots its own in-memory backend, so it never writes test candidates into real data.
    const livePort = process.env.TEST_PORT || 4100;
    const isLive = process.env.E2E_LIVE_SERVER === '1' && await this.pingPort(livePort);

    if (isLive) {
      this.port = livePort;
      this.baseUrl = `http://127.0.0.1:${this.port}`;
      this.isEmbeddedServer = false;
    } else {
      // 2. Check if src/backend/app.js exists and is importable
      let realApp = null;
      try {
        realApp = require('../src/backend/app.js');
      } catch {
        // Not yet implemented or failed to load
      }

      if (realApp && typeof realApp.listen === 'function') {
        // Start real express app on ephemeral port
        await new Promise((resolve, reject) => {
          this.serverInstance = realApp.listen(0, '127.0.0.1', () => {
            this.port = this.serverInstance.address().port;
            this.baseUrl = `http://127.0.0.1:${this.port}`;
            this.isEmbeddedServer = true;
            resolve();
          });
          this.serverInstance.on('error', reject);
        });
      } else {
        // 3. Fallback to reference ContractServer
        this.serverInstance = new ContractServer({ maxStrikes: this.maxStrikes });
        this.port = await this.serverInstance.start();
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        this.isEmbeddedServer = true;
      }
    }

    // Initialize mock clients
    this.browser = new BrowserMock({ backendPort: this.port });
    this.vision = new VisionHeuristicsMock();
    return this;
  }

  async teardown() {
    if (this.isEmbeddedServer && this.serverInstance) {
      if (typeof this.serverInstance.stop === 'function') {
        await this.serverInstance.stop();
      } else if (typeof this.serverInstance.close === 'function') {
        await new Promise(resolve => this.serverInstance.close(resolve));
      }
    }
  }

  resetStore() {
    if (this.serverInstance && typeof this.serverInstance.reset === 'function') {
      this.serverInstance.reset();
    }
    if (this.browser) {
      this.browser = new BrowserMock({ backendPort: this.port });
    }
    if (this.vision) {
      this.vision.reset();
    }
  }

  pingPort(port) {
    return new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/health',
        method: 'GET',
        timeout: 400
      }, res => {
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  // --- HTTP Request Helper ---
  async request(path, options = {}) {
    const method = options.method || 'GET';
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    let bodyStr = null;
    if (options.body) {
      bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr
    });

    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return {
      status: res.status,
      headers: res.headers,
      data
    };
  }

  // --- High-level Endpoint Methods ---
  async requestOtp(studentId) {
    return this.request('/api/auth/otp/request', {
      method: 'POST',
      body: { studentId }
    });
  }

  async verifyOtp(studentId, otp) {
    return this.request('/api/auth/otp/verify', {
      method: 'POST',
      body: { studentId, otp }
    });
  }

  async verifyFace(studentId, imageBase64, descriptor) {
    return this.request('/api/auth/face/verify', {
      method: 'POST',
      body: { studentId, imageBase64, descriptor }
    });
  }

  async getQuestions(token) {
    return this.request('/api/assessment/questions', {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }

  async startSession(durationMinutes, studentId = 'STUDENT-TEST') {
    return this.request('/api/assessment/session/start', {
      method: 'POST',
      body: { durationMinutes, studentId }
    });
  }

  async getTimer(sessionId) {
    return this.request(`/api/assessment/session/${sessionId}/timer`, {
      method: 'GET'
    });
  }

  async submitAnswer(sessionId, questionId, selectedOptionId, flagged) {
    return this.request('/api/assessment/answer', {
      method: 'POST',
      body: { sessionId, questionId, selectedOptionId, flagged }
    });
  }

  async submitExam(sessionId) {
    return this.request('/api/assessment/submit', {
      method: 'POST',
      body: { sessionId }
    });
  }

  async sendViolation(sessionId, type, details = {}, snapshotBase64 = null, immediateDisqualify = false) {
    return this.request('/api/proctor/violation', {
      method: 'POST',
      body: { sessionId, type, details, snapshotBase64, immediateDisqualify }
    });
  }

  async sendTabEvent(sessionId, type, url, title = '') {
    return this.request('/api/proctor/tab-event', {
      method: 'POST',
      body: { sessionId, type, url, title }
    });
  }

  async sendSearchEvent(sessionId, service, query, url = '') {
    return this.request('/api/proctor/search-event', {
      method: 'POST',
      body: { sessionId, service, query, url }
    });
  }

  async sendInputActivity(sessionId, type, data = {}) {
    return this.request('/api/proctor/input-activity', {
      method: 'POST',
      body: { sessionId, type, data }
    });
  }

  async getAuditReport(sessionId, queryParams = '') {
    const q = queryParams ? `?${queryParams}` : '';
    return this.request(`/api/audit/session/${sessionId}/report${q}`, {
      method: 'GET'
    });
  }

  async exportAuditHtml(sessionId) {
    return this.request(`/api/audit/session/${sessionId}/export?format=html`, {
      method: 'GET'
    });
  }
}

module.exports = { E2EHarness };
