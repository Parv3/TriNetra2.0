/**
 * WebSocket Real-Time Proctor Telemetry & Intervention Service
 * Manages bi-directional live sockets between Candidate Clients and Proctor Dashboards.
 * Handles instant session lockdown, remote warnings, and real-time infraction broadcasting.
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const authService = require('./authService');
const config = require('../config');

// A proctor connection that is this far behind gets no thumbnails until it catches up;
// queueing stale frames is what makes a feed fall further and further behind.
const MAX_PROCTOR_BUFFER_BYTES = 256 * 1024;

class WebSocketService {
  constructor() {
    this.wss = null;
    this.studentSockets = new Map(); // sessionId -> Set of WebSocket instances
    this.proctorSockets = new Set();  // Set of WebSocket instances
    this.datastore = null;
    this.proctorService = null;
  }

  init(server, options = {}) {
    this.datastore = options.datastore || null;
    this.proctorService = options.proctorService || null;

    if (!server) return;

    this.wss = new WebSocketServer({ noServer: true });
    this.attach(server);

    this.wss.on('connection', (ws, req) => {
      try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const params = parsedUrl.searchParams;
        const requestedRole = params.get('role') || 'student';
        const sessionId = params.get('sessionId') || null;

        // Extract token from query param, sec-websocket-protocol, or authorization header
        const token = params.get('token') ||
                      (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null) ||
                      (req.headers['sec-websocket-protocol'] ? req.headers['sec-websocket-protocol'].split(',')[0].trim() : null);

        let session = null;
        if (token) {
          session = authService.validateSessionToken(token);
        }

        // Determine authenticated role
        let role = 'student';
        if (session && session.role === 'proctor') {
          role = 'proctor';
        } else if (requestedRole === 'proctor') {
          // Only the automated test suite may open an unauthenticated proctor channel.
          if (config.ENFORCE_AUTH || config.ENV !== 'test') {
            ws.close(4401, 'Unauthorized: Valid proctor JWT token required');
            return;
          }
          // Legacy/dev fallback for local automated test suites
          role = 'proctor';
        }

        // Student validation: in production, verify token matches session
        if (role === 'student' && config.ENFORCE_AUTH) {
          if (!session) {
            ws.close(4401, 'Unauthorized: Valid student session token required');
            return;
          }
        }

        if (role === 'proctor') {
          ws.watcherId = 'w_' + crypto.randomUUID().slice(0, 12);
          ws.watching = new Set();
          this.proctorSockets.add(ws);
          ws.send(JSON.stringify({
            type: 'CONNECTED',
            role: 'proctor',
            message: 'Connected to Trinetra Live Proctor Stream',
            timestamp: Date.now()
          }));

          ws.on('message', async (data) => {
            try {
              const msg = JSON.parse(data.toString());
              await this.handleProctorMessage(ws, msg);
            } catch (err) {
              console.warn('[WS] Error processing proctor message:', err.message);
            }
          });

          ws.on('close', () => {
            this.proctorSockets.delete(ws);
            ws.watching.forEach(sid => this.sendToStudent(sid, { type: 'WATCH_STOP', watcherId: ws.watcherId }));
          });
        } else {
          // Student role
          if (sessionId) {
            if (!this.studentSockets.has(sessionId)) {
              this.studentSockets.set(sessionId, new Set());
            }
            this.studentSockets.get(sessionId).add(ws);
          }

          ws.send(JSON.stringify({
            type: 'CONNECTED',
            role: 'student',
            sessionId,
            timestamp: Date.now()
          }));

          // Notify proctors that candidate is online
          this.broadcastToProctors({
            type: 'CANDIDATE_ONLINE',
            sessionId,
            timestamp: Date.now()
          });

          ws.on('message', async (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'RTC_SIGNAL') return this.relayToWatcher(sessionId, msg);
              await this.handleStudentMessage(sessionId, msg);
            } catch (err) {
              console.warn('[WS] Error processing student message:', err.message);
            }
          });

          ws.on('close', () => {
            if (sessionId && this.studentSockets.has(sessionId)) {
              const set = this.studentSockets.get(sessionId);
              set.delete(ws);
              if (set.size === 0) {
                this.studentSockets.delete(sessionId);
              }
            }
            this.broadcastToProctors({
              type: 'CANDIDATE_OFFLINE',
              sessionId,
              timestamp: Date.now()
            });
          });
        }
      } catch (err) {
        console.warn('[WS] Connection initialization error:', err.message);
      }
    });

    console.log('[WebSocket] Live Proctor WebSocket Server bound on /ws/proctor');
  }

  /** Serves /ws/proctor on another HTTP(S) server (the HTTPS listener for LAN candidates). */
  attach(server) {
    if (!server || !this.wss) return;
    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://localhost').pathname !== '/ws/proctor') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  // ── WebRTC signalling: a proctor watches one candidate's camera directly ──
  // The server only relays offers/answers/ICE; video flows peer-to-peer over the LAN.

  relayToWatcher(sessionId, msg) {
    for (const ws of this.proctorSockets) {
      if (ws.watcherId === msg.watcherId && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'RTC_SIGNAL', sessionId, description: msg.description, candidate: msg.candidate }));
      }
    }
  }

  async handleProctorMessage(ws, msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'TERMINATE_SESSION') {
      const { sessionId, reason } = msg;
      await this.terminateSession(sessionId, reason);
    } else if (msg.type === 'WARN_CANDIDATE') {
      const { sessionId, message } = msg;
      await this.warnCandidate(sessionId, message);
    } else if (msg.type === 'SEND_MESSAGE') {
      const { sessionId, message } = msg;
      if (sessionId && message) {
        this.sendToStudent(sessionId, {
          type: 'PROCTOR_MESSAGE',
          message,
          timestamp: Date.now()
        });
      }
    } else if (msg.type === 'WATCH_START' && msg.sessionId) {
      ws.watching.add(msg.sessionId);
      const delivered = this.sendToStudent(msg.sessionId, { type: 'WATCH_REQUEST', watcherId: ws.watcherId });
      if (!delivered) ws.send(JSON.stringify({ type: 'WATCH_UNAVAILABLE', sessionId: msg.sessionId }));
    } else if (msg.type === 'WATCH_STOP' && msg.sessionId) {
      ws.watching.delete(msg.sessionId);
      this.sendToStudent(msg.sessionId, { type: 'WATCH_STOP', watcherId: ws.watcherId });
    } else if (msg.type === 'RTC_SIGNAL' && msg.sessionId) {
      this.sendToStudent(msg.sessionId, { type: 'RTC_SIGNAL', watcherId: ws.watcherId, description: msg.description, candidate: msg.candidate });
    } else if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
    }
  }

  async handleStudentMessage(sessionId, msg) {
    if (!msg || !msg.type) return;

    let studentName = sessionId;
    let currentSession = null;

    // Save live telemetry and frame snapshot to datastore for proctor inspection
    if (this.datastore && this.datastore.data && this.datastore.data.sessions && this.datastore.data.sessions[sessionId]) {
      currentSession = this.datastore.data.sessions[sessionId];
      studentName = currentSession.candidateName || currentSession.studentName || sessionId;
      if (msg.snapshot) currentSession.lastSnapshot = msg.snapshot;
      if (msg.gaze !== undefined) currentSession.lastGaze = msg.gaze;
      if (msg.faceCount !== undefined) currentSession.lastFaceCount = msg.faceCount;
      if (msg.headPose) currentSession.lastHeadPose = msg.headPose;
      currentSession.lastSeenAt = Date.now();
    }

    // 1. Live Frame update
    if (msg.type === 'WEBCAM_FRAME' || msg.type === 'CANDIDATE_FRAME') {
      const faceCount = msg.faceCount !== undefined ? msg.faceCount : 1;
      const snapshot = msg.snapshot || msg.webcamSnapshot;

      this.broadcastToProctors({
        type: 'CANDIDATE_FRAME',
        sessionId,
        studentName,
        snapshot,
        faceCount,
        gaze: msg.gaze,
        headPose: msg.headPose,
        questionIdx: msg.questionIdx,
        questionTotal: msg.questionTotal,
        timestamp: Date.now()
      }, { droppable: true });

      return;
    }

    // 2. Keyboard, mouse, clipboard and device activity — logged to the stream, never a popup
    if (msg.type === 'INPUT_EVENT') {
      const eventType = msg.eventType || 'INPUT';
      const data = msg.data || {};
      const describe = {
        KEYSTROKE: () => ['keyboard', `Shortcut ${data.combo || data.key || ''}${data.blocked ? ' (blocked)' : ''}`],
        KEY_SUMMARY: () => ['keyboard', `Typed ${data.keyCount} keys (${data.perMinute}/min)`],
        MOUSE_BURST: () => ['mouse', `Mouse moved ${data.distancePx || 0}px, ${data.clicks || 0} clicks`],
        MOUSE_LEAVE_WINDOW: () => ['focus', 'Cursor left the exam window'],
        VISIBILITY: () => ['focus', data.state === 'hidden' ? 'Exam page hidden' : 'Exam page visible again'],
        CLIPBOARD: () => ['keyboard', `${String(data.action || 'clipboard').replace(/^\w/, c => c.toUpperCase())} attempt${data.blocked ? ' (blocked)' : ''}`],
        DEVICE_CHANGE: () => ['vision', `Device change — added: ${(data.added || []).join(', ') || 'none'}; removed: ${(data.removed || []).join(', ') || 'none'}`]
      }[eventType];
      if (!describe) return; // e.g. QUESTION_VIEW: stored for analytics, not streamed
      const [category, summary] = describe();
      this.broadcastToProctors({ type: 'LIVE_LOG_EVENT', sessionId, studentName, category, summary, details: data, timestamp: Date.now() });
      return;
    }

    // 3. AI Intercepts & Vision Anomalies
    if (msg.type === 'TELEMETRY_PULSE' || msg.type === 'VIOLATION_ALERT') {
      const payload = msg.payload || msg;
      const pType = payload.type || 'ANOMALY';
      let summary = `Violation: ${pType}`;
      let isExtreme = false;

      if (pType === 'NO_FACE') {
        summary = 'Face not visible to the camera';
        isExtreme = true;
      } else if (pType === 'MULTIPLE_FACES') {
        summary = 'More than one person in view';
        isExtreme = true;
      } else if (pType.includes('AI') || pType === 'AI_PROMPT_INTERCEPT') {
        summary = `AI assistant opened (${payload.service || 'unknown'})`;
        isExtreme = true;
      }

      this.broadcastToProctors({
        type: 'LIVE_LOG_EVENT',
        sessionId,
        studentName,
        category: 'vision',
        summary,
        details: payload,
        timestamp: Date.now()
      });

      if (isExtreme) {
        this.broadcastToProctors({
          type: 'EXTREME_SUSPICION_ALERT',
          sessionId,
          studentName,
          category: 'security',
          violationType: pType,
          reason: summary,
          snapshot: payload.snapshot || currentSession?.lastSnapshot || null,
          timestamp: Date.now()
        });
      }
    }
  }

  broadcastToProctors(payload, { droppable = false } = {}) {
    const raw = JSON.stringify(payload);
    for (const ws of this.proctorSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      if (droppable && ws.bufferedAmount > MAX_PROCTOR_BUFFER_BYTES) continue;
      ws.send(raw);
    }
  }

  sendToStudent(sessionId, payload) {
    if (!sessionId || !this.studentSockets.has(sessionId)) return false;
    const raw = JSON.stringify(payload);
    let sent = false;
    for (const ws of this.studentSockets.get(sessionId)) {
      if (ws.readyState === ws.OPEN) {
        ws.send(raw);
        sent = true;
      }
    }
    return sent;
  }

  async terminateSession(sessionId, reason = 'Terminated by Proctor') {
    if (!sessionId) return;

    // 1. Update database status
    if (this.proctorService && typeof this.proctorService.performSessionAction === 'function') {
      try {
        await this.proctorService.performSessionAction(sessionId, 'DISQUALIFY', { reason });
      } catch (_) {}
    }

    // 2. Send instant lock command to student browser
    this.sendToStudent(sessionId, {
      type: 'TERMINATED',
      action: 'LOCK_EXAM',
      reason,
      timestamp: Date.now()
    });

    // 3. Notify all proctors
    this.broadcastToProctors({
      type: 'SESSION_TERMINATED',
      sessionId,
      reason,
      timestamp: Date.now()
    });
  }

  async warnCandidate(sessionId, message = 'Proctor Warning') {
    if (!sessionId) return;

    let strikeCount = 1;
    if (this.proctorService && typeof this.proctorService.performSessionAction === 'function') {
      try {
        const res = await this.proctorService.performSessionAction(sessionId, 'WARN', { message });
        strikeCount = res.strikeCount || 1;
      } catch (_) {}
    }

    // Send instant warning banner & chime command to student
    this.sendToStudent(sessionId, {
      type: 'PROCTOR_WARNING',
      message,
      strikeCount,
      timestamp: Date.now()
    });

    this.broadcastToProctors({
      type: 'WARNING_ISSUED',
      sessionId,
      message,
      strikeCount,
      timestamp: Date.now()
    });
  }

  close() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.studentSockets.clear();
    this.proctorSockets.clear();
  }
}

const websocketService = new WebSocketService();
module.exports = websocketService;
module.exports.WebSocketService = WebSocketService;
