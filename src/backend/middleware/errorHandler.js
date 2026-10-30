const config = require('../config');

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  if (config.ENV !== 'test' && status >= 500) {
    console.error('[Backend Error]', err);
  }

  res.status(status).json({
    success: false,
    error: err.code || err.name || 'INTERNAL_SERVER_ERROR',
    message: err.message || 'An unexpected internal error occurred'
  });
}

module.exports = errorHandler;
