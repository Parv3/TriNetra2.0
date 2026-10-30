const express = require('express');
const router = express.Router();
const assistService = require('../services/assistService');
const { optionalAuthMiddleware } = require('../middleware/authMiddleware');

// POST /api/assist — guided, answer-safe help for the current question
router.post('/', optionalAuthMiddleware, async (req, res, next) => {
  try {
    const { sessionId, questionId, message } = req.body || {};
    const result = await assistService.ask({ sessionId, questionId, message });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: true, code: err.error, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
