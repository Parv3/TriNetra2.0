const path = require('path');

const ENV = process.env.NODE_ENV || 'development';

module.exports = {
  // Server network configuration
  PORT: parseInt(process.env.PORT, 10) || 4100,
  HOST: process.env.HOST || '0.0.0.0', // Bind to 0.0.0.0 for LAN network proctoring
  MAX_PORT_RETRIES: 10,
  ENV,

  // Assessment & timer settings
  DEFAULT_DURATION_MINUTES: 10,
  SWEEPER_INTERVAL_MS: 1000, // 1-second background timeout evaluation
  GRACE_PERIOD_MS: 2000,     // 2-second network latency buffer
  CLOCK_TAMPERING_TOLERANCE_MS: 10000, // Discrepancy between monotonic and wall clock

  // Proctoring & security thresholds
  MAX_STRIKES: parseInt(process.env.MAX_STRIKES, 10) || 3,
  MAX_STRIKES_BEFORE_DISQUALIFY: parseInt(process.env.MAX_STRIKES, 10) || 3,
  DISQUALIFICATION_STATUS: 'DISQUALIFIED',
  ALLOW_MASTER_OTP: process.env.ALLOW_MASTER_OTP === 'true' ||
                    process.env.NODE_ENV === 'test' ||
                    process.env.DEMO_MODE === 'true' ||
                    (process.env.NODE_ENV !== 'production' && ENV !== 'production'),
  OTP_EXPIRY_MS: 5 * 60 * 1000, // 5 minutes
  TOKEN_EXPIRY_HOURS: 24,
  BODY_SIZE_LIMIT: '10mb', // Supports base64 webcam baseline photos

  // Persistence file paths & Database
  DATA_DIR: path.resolve(process.env.TRINETRA_DATA_DIR || path.join(process.cwd(), 'data')),
  DATASTORE_FILE: path.resolve(process.env.TRINETRA_DATA_DIR || path.join(process.cwd(), 'data'), 'proctor_store.json'),
  SEED_QUESTIONS_FILE: path.resolve(process.cwd(), 'assets', 'seed_questions.json'),
  // Optional PostgreSQL mirror of all student activity, for teachers (docs/TEACHER_SQL.md)
  DATABASE_URL: process.env.DATABASE_URL || '',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trinetra'
};
