const datastore = require('../db/datastore');
const assessmentService = require('./assessmentService');
const config = require('../config');

class TimerService {
  constructor(ds = datastore, as = assessmentService) {
    this.datastore = ds;
    this.assessmentService = as;
    this.sweeperInterval = null;
    this.sweeperTickMs = config.SWEEPER_INTERVAL_MS || 1000;
    this.gracePeriodMs = config.GRACE_PERIOD_MS || 2000;
    this.isRunning = false;
  }

  setDataStore(ds) {
    this.datastore = ds;
  }

  setAssessmentService(as) {
    this.assessmentService = as;
  }

  startSweeper() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.sweeperInterval = setInterval(() => {
      this.checkTimeouts().catch((err) => {
        if (config.ENV !== 'test') {
          console.error('[TimerSweeper Error]', err);
        }
      });
    }, this.sweeperTickMs);

    if (this.sweeperInterval && this.sweeperInterval.unref) {
      this.sweeperInterval.unref();
    }
  }

  stopSweeper() {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
    this.isRunning = false;
  }

  getSessionTimer(session) {
    if (!session) return null;

    const now = Date.now();
    const serverTime = now;
    const startedAt = session.startedAt || now;
    const expiresAt = session.expiresAt !== undefined ? session.expiresAt : (startedAt + 600000);

    // Monotonic clock anti-tamper checking
    let clockTampered = false;
    let monotonicRemainingMs = null;

    if (session.hrtimeStart) {
      try {
        const hrtimeNow = process.hrtime.bigint();
        const monotonicElapsedNs = hrtimeNow - BigInt(session.hrtimeStart);
        const monotonicElapsedMs = Number(monotonicElapsedNs / 1000000n);
        const wallElapsedMs = now - startedAt;

        if (Math.abs(wallElapsedMs - monotonicElapsedMs) > (config.CLOCK_TAMPERING_TOLERANCE_MS || 10000)) {
          clockTampered = true;
          const totalDurationMs = (session.durationMinutes !== undefined ? session.durationMinutes : 10) * 60 * 1000;
          monotonicRemainingMs = Math.max(0, totalDurationMs - monotonicElapsedMs);
        }
      } catch (_) {}
    }

    const effectiveRemainingMs = clockTampered && monotonicRemainingMs !== null
      ? monotonicRemainingMs
      : Math.max(0, expiresAt - now);

    // Active auto-submission transition if expired
    if ((session.status === 'IN_PROGRESS' && (now >= expiresAt || effectiveRemainingMs <= 0)) ||
        (session.status === 'AUTO_SUBMITTED_TIMEOUT' && (session.score === null || session.score === undefined))) {
      if (this.assessmentService && typeof this.assessmentService.finalizeExpiredSession === 'function') {
        const finalized = this.assessmentService.finalizeExpiredSession(session.id || session.sessionId);
        if (finalized) {
          Object.assign(session, finalized);
        } else {
          session.status = 'AUTO_SUBMITTED_TIMEOUT';
          session.submittedAt = session.submittedAt || session.expiresAt || now;
        }
      } else {
        session.status = 'AUTO_SUBMITTED_TIMEOUT';
        session.submittedAt = session.submittedAt || session.expiresAt || now;
        if (this.datastore && typeof this.datastore.updateSession === 'function') {
          this.datastore.updateSession(session.id || session.sessionId, session);
        }
      }
    }

    const remainingSeconds = session.status === 'IN_PROGRESS'
      ? Math.ceil(effectiveRemainingMs / 1000)
      : 0;

    const isExpired = session.status === 'AUTO_SUBMITTED_TIMEOUT' ||
      (session.status === 'IN_PROGRESS' && effectiveRemainingMs === 0);

    return {
      sessionId: session.id || session.sessionId,
      remainingSeconds,
      status: session.status,
      serverTime,
      expiresAt: session.expiresAt,
      startedAt,
      durationSeconds: (session.durationMinutes !== undefined ? session.durationMinutes : 10) * 60,
      isExpired,
      clockTampered
    };
  }

  async checkTimeouts() {
    if (!this.datastore) return;

    try {
      const allSessions = typeof this.datastore.getAllSessions === 'function'
        ? this.datastore.getAllSessions()
        : [];

      const now = Date.now();

      for (const session of allSessions) {
        if (session.status !== 'IN_PROGRESS') continue;

        let isExpired = now >= session.expiresAt;

        if (!isExpired && session.hrtimeStart) {
          try {
            const hrtimeNow = process.hrtime.bigint();
            const monotonicElapsedMs = Number((hrtimeNow - BigInt(session.hrtimeStart)) / 1000000n);
            const totalDurationMs = (session.durationMinutes !== undefined ? session.durationMinutes : 10) * 60 * 1000;
            if (monotonicElapsedMs >= totalDurationMs) {
              isExpired = true;
            }
          } catch (_) {}
        }

        if (isExpired) {
          if (this.assessmentService && typeof this.assessmentService.finalizeExpiredSession === 'function') {
            const finalized = this.assessmentService.finalizeExpiredSession(session.id || session.sessionId);
            if (finalized) {
              Object.assign(session, finalized);
            } else {
              session.status = 'AUTO_SUBMITTED_TIMEOUT';
              session.submittedAt = session.submittedAt || session.expiresAt || now;
            }
          } else {
            session.status = 'AUTO_SUBMITTED_TIMEOUT';
            session.submittedAt = session.submittedAt || session.expiresAt || now;
            if (this.datastore && typeof this.datastore.updateSession === 'function') {
              this.datastore.updateSession(session.id || session.sessionId, session);
            }
          }
        }
      }
    } catch (err) {
      if (config.ENV !== 'test') {
        console.error('[TimerSweeper Error]', err.message);
      }
    }
  }

  async checkExpiredSessions() {
    return this.checkTimeouts();
  }

  isSessionActive(session) {
    if (!session || session.status !== 'IN_PROGRESS') return false;
    const now = Date.now();
    return now <= session.expiresAt + this.gracePeriodMs;
  }
}

const timerService = new TimerService();
module.exports = timerService;
module.exports.TimerService = TimerService;
module.exports.timerService = timerService;
