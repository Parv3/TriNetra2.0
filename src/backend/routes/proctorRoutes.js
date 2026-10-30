const express = require('express');
const router = express.Router();
const proctorService = require('../services/proctorService');
const { requireProctor } = require('../middleware/authMiddleware');

// Violations that justify interrupting the proctor with a modal (others go to the stream only).
const URGENT_TYPES = new Set(['PHONE_DETECTED', 'EARPIECE_DETECTED', 'MULTIPLE_FACES', 'IDENTITY_MISMATCH', 'CONCURRENT_LOGIN', 'REMOTE_ACCESS_SOFTWARE', 'SCREEN_CAPTURE_SOFTWARE', 'MULTIPLE_DISPLAYS', 'VIRTUAL_MACHINE']);

function notifyProctors(body, result) {
  try {
    const websocketService = require('../services/websocketService');
    const datastore = require('../db/datastore');
    const session = datastore.getSession(body.sessionId) || {};
    const type = body.type || 'UNUSUAL_BEHAVIOR';
    const base = { sessionId: body.sessionId, studentName: session.candidateName || session.studentId, timestamp: Date.now() };
    websocketService.broadcastToProctors({ ...base, type: 'LIVE_ANOMALY', payload: { type, strikeCount: result.strikeCount } });
    websocketService.broadcastToProctors({ ...base, type: 'LIVE_LOG_EVENT', category: 'vision', summary: `${body.message || type} — warning ${result.strikeCount}/${result.warningThreshold}` });
    if (URGENT_TYPES.has(type) || result.action === 'DISQUALIFY') {
      websocketService.broadcastToProctors({
        ...base,
        type: 'EXTREME_SUSPICION_ALERT',
        violationType: type,
        reason: result.action === 'DISQUALIFY' ? `Terminated automatically: ${body.message || type}` : (body.message || type),
        snapshot: body.snapshot || body.snapshotBase64 || null
      });
    }
  } catch (_) {}
}

// POST /api/proctor/violation
router.post('/violation', async (req, res, next) => {
  try {
    const result = await proctorService.recordViolation(req.body.sessionId, req.body);
    notifyProctors(req.body, result);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'VIOLATION_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/proctor/tab-event and alias /tab-activity
const handleTabActivity = async (req, res, next) => {
  try {
    const result = await proctorService.recordTabActivity(req.body.sessionId, req.body);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'TAB_ACTIVITY_ERROR',
        message: err.message
      });
    }
    next(err);
  }
};

router.post('/tab-event', handleTabActivity);
router.post('/tab-activity', handleTabActivity);

// POST /api/proctor/search-event
router.post('/search-event', async (req, res, next) => {
  try {
    const result = await proctorService.recordSearchEvent(req.body.sessionId, req.body);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'SEARCH_EVENT_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// POST /api/proctor/input-activity
router.post('/input-activity', async (req, res, next) => {
  try {
    const result = await proctorService.recordInputActivity(req.body.sessionId, req.body);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'INPUT_ACTIVITY_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/proctor/audit-report/:sessionId
router.get('/audit-report/:sessionId', requireProctor, async (req, res, next) => {
  try {
    const report = await proctorService.getAuditReport(req.params.sessionId, req.query);
    if (req.query.format === 'html') {
      const html = proctorService.generateHtmlReport(report);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }
    return res.status(200).json(report);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'AUDIT_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/proctor/export/:sessionId
router.get('/export/:sessionId', requireProctor, async (req, res, next) => {
  try {
    const report = await proctorService.getAuditReport(req.params.sessionId, req.query);
    const format = req.query.format || 'html';
    if (format === 'html') {
      const html = proctorService.generateHtmlReport(report);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }
    return res.status(200).json(report);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        statusCode: err.status || err.statusCode,
        code: err.code || 'EXPORT_ERROR',
        message: err.message
      });
    }
    next(err);
  }
});

module.exports = router;
