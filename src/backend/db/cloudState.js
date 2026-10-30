/**
 * Keeps the exam server's whole state in PostgreSQL, for hosts without a persistent disk
 * (e.g. Render's free plan, which wipes files on every restart or sleep).
 *
 * The state is one JSONB row in trinetra.app_state, loaded once at startup and saved a few
 * seconds after changes. Enabled with TRINETRA_STATE_IN_DB=1 together with DATABASE_URL.
 * Row-level security is on with no policies, so only the server's own login can read it:
 * it holds password hashes and one-time codes, unlike the teacher-facing mirror tables.
 */

const SAVE_DEBOUNCE_MS = 3000;
const ROW_ID = 'main';

const SETUP_SQL = `
CREATE SCHEMA IF NOT EXISTS trinetra;
CREATE TABLE IF NOT EXISTS trinetra.app_state (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;
const RLS_SQL = 'ALTER TABLE trinetra.app_state ENABLE ROW LEVEL SECURITY';

// Live camera frames are transient, as in the on-disk store
const serialize = (data) => JSON.stringify(data, (key, value) => (key === 'lastSnapshot' ? undefined : value));

class CloudState {
  constructor() {
    this.pool = null;
    this.timer = null;
    this.pending = null;
    this.saving = null;
    this.status = { enabled: false, lastSavedAt: null, lastError: null };
  }

  async init(connectionStringOrPool) {
    if (typeof connectionStringOrPool === 'string') {
      const { Pool } = require('pg');
      const ssl = /sslmode=require|supabase|neon\.tech|render\.com|amazonaws/.test(connectionStringOrPool) ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({ connectionString: connectionStringOrPool, max: 2, ssl, connectionTimeoutMillis: 10000 });
    } else {
      this.pool = connectionStringOrPool;
    }
    let exists = true;
    try { await this.pool.query('SELECT 1 FROM trinetra.app_state LIMIT 1'); } catch (_) { exists = false; }
    if (!exists) {
      await this.pool.query(SETUP_SQL);
      try { await this.pool.query(RLS_SQL); } catch (_) { /* not supported by this engine (e.g. tests) */ }
    }
    this.status.enabled = true;
  }

  /** The saved state, or null when nothing has been saved yet. */
  async load() {
    const res = await this.pool.query('SELECT data FROM trinetra.app_state WHERE id = $1', [ROW_ID]);
    if (!res.rows.length) return null;
    const data = res.rows[0].data;
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  /** Called by the datastore on every change; coalesces into one write every few seconds. */
  schedule(data) {
    if (!this.pool) return;
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (!this.pool || !this.pending) return;
    const json = serialize(this.pending);
    this.pending = null;
    this.saving = this.pool.query(
      `INSERT INTO trinetra.app_state (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [ROW_ID, json]
    ).then(() => {
      this.status.lastSavedAt = Date.now();
      this.status.lastError = null;
    }).catch((err) => {
      this.status.lastError = err.message;
      console.warn('[CloudState] Save failed:', err.message);
    }).finally(() => {
      this.saving = null;
    });
    await this.saving;
  }

  async close() {
    await this.flush().catch(() => {});
    if (this.pool && typeof this.pool.end === 'function') await this.pool.end().catch(() => {});
    this.pool = null;
  }
}

module.exports = new CloudState();
module.exports.CloudState = CloudState;
