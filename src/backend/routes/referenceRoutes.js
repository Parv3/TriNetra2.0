const express = require('express');
const router = express.Router();
const referenceService = require('../services/referenceService');
const { optionalAuthMiddleware } = require('../middleware/authMiddleware');

function send(res, next, promise) {
  promise
    .then(result => res.status(200).json(result))
    .catch(err => {
      if (err.status) return res.status(err.status).json({ error: true, code: err.error, message: err.message });
      next(err);
    });
}

// GET /api/reference/search?sessionId=&questionId=&q=
router.get('/search', optionalAuthMiddleware, (req, res, next) => {
  send(res, next, referenceService.search({ sessionId: req.query.sessionId, questionId: req.query.questionId, query: req.query.q }));
});

// GET /api/reference/article?sessionId=&questionId=&title=
router.get('/article', optionalAuthMiddleware, (req, res, next) => {
  send(res, next, referenceService.article({ sessionId: req.query.sessionId, questionId: req.query.questionId, title: req.query.title }));
});

module.exports = router;
