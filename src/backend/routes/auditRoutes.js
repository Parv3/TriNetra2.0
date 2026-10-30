const express = require('express');
const router = express.Router();
const proctorService = require('../services/proctorService');
const websocketService = require('../services/websocketService');
const datastore = require('../db/datastore');
const { requireProctor } = require('../middleware/authMiddleware');

// GET /api/audit/overview — High-level KPI metrics across all candidates (Proctor only)
router.get('/overview', requireProctor, async (req, res, next) => {
  try {
    const stats = await proctorService.getOverviewStats();
    return res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/sessions — List and filter all candidate sessions (Proctor only)
router.get('/sessions', requireProctor, async (req, res, next) => {
  try {
    const sessions = await proctorService.getAllSessionsSummary(req.query);
    return res.status(200).json(sessions);
  } catch (err) {
    next(err);
  }
});

// POST /api/audit/session/:id/action — Proctor intervention (Disqualify / Warn) (Proctor only)
router.post('/session/:id/action', requireProctor, async (req, res, next) => {
  try {
    const result = await proctorService.performSessionAction(
      req.params.id,
      req.body.action,
      req.body
    );

    // Live WebSocket push to candidate screen and proctor dashboards
    if (req.body.action === 'DISQUALIFY') {
      websocketService.sendToStudent(req.params.id, {
        type: 'TERMINATED',
        action: 'LOCK_EXAM',
        reason: req.body.reason || 'Terminated by Proctor',
        timestamp: Date.now()
      });
      websocketService.broadcastToProctors({
        type: 'SESSION_TERMINATED',
        sessionId: req.params.id,
        reason: req.body.reason || 'Terminated by Proctor',
        timestamp: Date.now()
      });
    } else if (req.body.action === 'RESUME') {
      websocketService.sendToStudent(req.params.id, {
        type: 'RESUMED',
        expiresAt: result.expiresAt,
        strikeCount: result.strikeCount,
        message: req.body.reason || 'Your proctor has resumed your exam.',
        timestamp: Date.now()
      });
      websocketService.broadcastToProctors({ type: 'SESSION_RESUMED', sessionId: req.params.id, timestamp: Date.now() });
    } else if (req.body.action === 'WARN') {
      websocketService.sendToStudent(req.params.id, {
        type: 'PROCTOR_WARNING',
        message: req.body.message || 'Direct proctor attention flag',
        strikeCount: result.strikeCount || 1,
        timestamp: Date.now()
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: true,
        message: err.message
      });
    }
    next(err);
  }
});

// GET /api/audit/session/:id/report
router.get('/session/:id/report', async (req, res, next) => {
  try {
    const report = await proctorService.getAuditReport(req.params.id, req.query);
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

// GET /api/audit/session/:id/export
router.get('/session/:id/export', async (req, res, next) => {
  try {
    const report = await proctorService.getAuditReport(req.params.id, req.query);
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
