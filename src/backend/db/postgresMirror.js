/**
 * PostgreSQL mirror of everything a teacher may want to query.
 *
 * The exam server keeps its fast local store; when DATABASE_URL is set, every change is
 * mirrored (incrementally, at most once a second) into normalised tables in the
 * `trinetra` schema, plus read-only views written for teachers:
 *   trinetra.v_attempts         one row per attempt: score, warnings, AI use, status
 *   trinetra.v_student_timeline every recorded event for every student, in order
 *   trinetra.v_ai_and_search    every site, search and AI prompt, blocked or not
 * See docs/TEACHER_SQL.md for example queries and a read-only teacher login.
 */

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS trinetra;

CREATE TABLE IF NOT EXISTS trinetra.candidates (
  roll_no        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT,
  institution    TEXT,
  face_registered BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.exams (
  id               TEXT PRIMARY KEY,
  join_code        TEXT UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT,
  duration_minutes INTEGER,
  status           TEXT,
  rules            JSONB,
  question_count   INTEGER,
  created_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.exam_questions (
  id                TEXT PRIMARY KEY,
  exam_id           TEXT NOT NULL,
  position          INTEGER,
  category          TEXT,
  text              TEXT NOT NULL,
  options           JSONB,
  correct_option_id TEXT,
  explanation       TEXT,
  hint              TEXT
);

CREATE TABLE IF NOT EXISTS trinetra.attempts (
  id                  TEXT PRIMARY KEY,
  exam_id             TEXT,
  roll_no             TEXT,
  candidate_name      TEXT,
  status              TEXT,
  started_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  submitted_at        TIMESTAMPTZ,
  score               NUMERIC,
  max_score           NUMERIC,
  warnings            INTEGER,
  warning_limit       INTEGER,
  resume_count        INTEGER,
  termination_reason  TEXT,
  device_id           TEXT,
  updated_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.answers (
  attempt_id          TEXT NOT NULL,
  question_id         TEXT NOT NULL,
  selected_option_id  TEXT,
  previous_option_id  TEXT,
  answered_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (attempt_id, question_id, answered_at)
);

CREATE TABLE IF NOT EXISTS trinetra.violations (
  id            TEXT PRIMARY KEY,
  attempt_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  severity      TEXT,
  message       TEXT,
  details       JSONB,
  warning_number INTEGER,
  snapshot_jpeg TEXT,
  occurred_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.page_visits (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL,
  event_type  TEXT,
  url         TEXT,
  domain      TEXT,
  title       TEXT,
  is_ai_tool  BOOLEAN,
  occurred_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.searches (
  id           TEXT PRIMARY KEY,
  attempt_id   TEXT NOT NULL,
  service      TEXT,
  query        TEXT,
  url          TEXT,
  is_ai_tool   BOOLEAN,
  blocked      BOOLEAN,
  block_reason TEXT,
  occurred_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.activity_events (
  id          TEXT PRIMARY KEY,
  attempt_id  TEXT NOT NULL,
  event_type  TEXT,
  details     JSONB,
  occurred_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trinetra.assistant_messages (
  attempt_id        TEXT NOT NULL,
  question_id       TEXT,
  asked_at          TIMESTAMPTZ NOT NULL,
  message           TEXT,
  reply             TEXT,
  outcome           TEXT,
  source            TEXT,
  removed_sentences INTEGER,
  PRIMARY KEY (attempt_id, asked_at)
);

CREATE TABLE IF NOT EXISTS trinetra.proctor_actions (
  attempt_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  reason     TEXT,
  details    JSONB,
  acted_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (attempt_id, acted_at, action)
);
`;

// Columns added after the first release; safe to re-run.
const UPGRADE_SQL = `
ALTER TABLE trinetra.exams ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE trinetra.exams ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE trinetra.exams ADD COLUMN IF NOT EXISTS created_by TEXT;
`;

// Hosted Postgres (e.g. Supabase) exposes tables through a public API; with row-level
// security on and no policies, only the server's own database login can read them.
const TABLES = ['candidates', 'exams', 'exam_questions', 'attempts', 'answers', 'violations', 'page_visits',
  'searches', 'activity_events', 'assistant_messages', 'proctor_actions'];
// Teachers read through the trinetra_reader role (see docs/TEACHER_SQL.md).
const HARDENING_SQL = [
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trinetra_reader') THEN CREATE ROLE trinetra_reader NOLOGIN; END IF; END $$`,
  'GRANT USAGE ON SCHEMA trinetra TO trinetra_reader',
  'GRANT SELECT ON ALL TABLES IN SCHEMA trinetra TO trinetra_reader',
  ...TABLES.map(t => `ALTER TABLE trinetra.${t} ENABLE ROW LEVEL SECURITY`),
  ...TABLES.map(t => `DROP POLICY IF EXISTS reader_select ON trinetra.${t}`),
  ...TABLES.map(t => `CREATE POLICY reader_select ON trinetra.${t} FOR SELECT TO trinetra_reader USING (true)`),
  ...['v_attempts', 'v_student_timeline', 'v_ai_and_search'].map(v => `ALTER VIEW trinetra.${v} SET (security_invoker = on)`)
];

const VIEWS_SQL = `
CREATE OR REPLACE VIEW trinetra.v_attempts AS
SELECT a.id AS attempt_id, a.roll_no, a.candidate_name, c.email, c.institution,
       e.title AS exam, e.join_code, a.status, a.started_at, a.submitted_at,
       a.score, a.max_score, a.warnings, a.warning_limit, a.resume_count, a.termination_reason,
       COALESCE(vc.n, 0) AS violation_count,
       COALESCE(sc.ai, 0) AS ai_attempts,
       COALESCE(sc.blocked, 0) AS blocked_searches,
       COALESCE(mc.n, 0) AS assistant_messages
FROM trinetra.attempts a
LEFT JOIN trinetra.candidates c ON c.roll_no = a.roll_no
LEFT JOIN trinetra.exams e ON e.id = a.exam_id
LEFT JOIN (SELECT attempt_id, COUNT(*) AS n FROM trinetra.violations GROUP BY attempt_id) vc ON vc.attempt_id = a.id
LEFT JOIN (SELECT attempt_id,
                  SUM(CASE WHEN is_ai_tool THEN 1 ELSE 0 END) AS ai,
                  SUM(CASE WHEN blocked THEN 1 ELSE 0 END) AS blocked
             FROM trinetra.searches GROUP BY attempt_id) sc ON sc.attempt_id = a.id
LEFT JOIN (SELECT attempt_id, COUNT(*) AS n FROM trinetra.assistant_messages GROUP BY attempt_id) mc ON mc.attempt_id = a.id;

CREATE OR REPLACE VIEW trinetra.v_student_timeline AS
SELECT a.roll_no, a.candidate_name, a.id AS attempt_id, v.occurred_at, 'violation' AS category, v.type AS event, v.message AS detail
  FROM trinetra.violations v JOIN trinetra.attempts a ON a.id = v.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, p.occurred_at, 'page', p.event_type, p.url
  FROM trinetra.page_visits p JOIN trinetra.attempts a ON a.id = p.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, s.occurred_at, 'search', s.service, s.query
  FROM trinetra.searches s JOIN trinetra.attempts a ON a.id = s.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, x.answered_at, 'answer', x.question_id, x.selected_option_id
  FROM trinetra.answers x JOIN trinetra.attempts a ON a.id = x.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, m.asked_at, 'assistant', m.outcome, m.message
  FROM trinetra.assistant_messages m JOIN trinetra.attempts a ON a.id = m.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, ev.occurred_at, 'activity', ev.event_type, CAST(ev.details AS TEXT)
  FROM trinetra.activity_events ev JOIN trinetra.attempts a ON a.id = ev.attempt_id
UNION ALL
SELECT a.roll_no, a.candidate_name, a.id, pa.acted_at, 'proctor', pa.action, pa.reason
  FROM trinetra.proctor_actions pa JOIN trinetra.attempts a ON a.id = pa.attempt_id;

CREATE OR REPLACE VIEW trinetra.v_ai_and_search AS
SELECT a.roll_no, a.candidate_name, e.title AS exam, s.occurred_at, s.service, s.query, s.url,
       s.is_ai_tool, s.blocked, s.block_reason
FROM trinetra.searches s
JOIN trinetra.attempts a ON a.id = s.attempt_id
LEFT JOIN trinetra.exams e ON e.id = a.exam_id;
`;

const ts = (ms) => (ms ? new Date(ms) : null);
const json = (v) => (v === undefined ? null : JSON.stringify(v));

class PostgresMirror {
  constructor() {
    this.pool = null;
    this.timer = null;
    this.running = false;
    this.pendingData = null;
    this.hashes = new Map();       // "kind:id" -> hash of last synced row
    this.counts = new Map();       // append-only collection -> rows already synced
    this.status = { enabled: false, lastSyncAt: null, lastError: null, rowsWritten: 0 };
  }

  async init(connectionStringOrPool) {
    if (typeof connectionStringOrPool === 'string') {
      const { Pool } = require('pg');
      const ssl = /sslmode=require|supabase|neon\.tech|render\.com|amazonaws/.test(connectionStringOrPool) ? { rejectUnauthorized: false } : undefined;
      this.pool = new Pool({ connectionString: connectionStringOrPool, max: 4, ssl });
    } else {
      this.pool = connectionStringOrPool;
    }
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(UPGRADE_SQL);
    await this.pool.query(VIEWS_SQL);
    for (const sql of HARDENING_SQL) {
      try { await this.pool.query(sql); } catch (_) { /* not supported by this engine (e.g. tests) */ }
    }
    this.status.enabled = true;
  }

  /** Called by the datastore on every change; coalesces into one sync per second. */
  schedule(data) {
    if (!this.pool) return;
    this.pendingData = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, 1000);
    if (this.timer.unref) this.timer.unref();
  }

  async flush() {
    if (!this.pool || !this.pendingData) return;
    if (this.running) {
      this.schedule(this.pendingData);
      return;
    }
    this.running = true;
    const data = this.pendingData;
    this.pendingData = null;
    try {
      const written = await this.sync(data);
      this.status.lastSyncAt = Date.now();
      this.status.lastError = null;
      this.status.rowsWritten += written;
    } catch (err) {
      this.status.lastError = err.message;
      // Retry on the next change; the watermarks were not advanced for the failed batch.
      console.warn('[Postgres] Mirror sync failed:', err.message);
    } finally {
      this.running = false;
    }
  }

  changed(kind, id, row) {
    const key = `${kind}:${id}`;
    const hash = JSON.stringify(row);
    if (this.hashes.get(key) === hash) return false;
    this.hashes.set(key, hash);
    return true;
  }

  /** Rows of an append-only collection that have not been mirrored yet. */
  fresh(key, items) {
    const done = this.counts.get(key) || 0;
    return { rows: items.slice(done), commit: () => this.counts.set(key, items.length) };
  }

  async sync(data) {
    const q = (sql, params) => this.pool.query(sql, params);
    let written = 0;

    for (const c of Object.values(data.candidates || {})) {
      const row = [c.id, c.name, c.email || null, c.institution || null, Boolean(c.faceRegistered), ts(c.createdAt)];
      if (!this.changed('candidate', c.id, row)) continue;
      await q(`INSERT INTO trinetra.candidates (roll_no, name, email, institution, face_registered, created_at)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (roll_no) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
                 institution = EXCLUDED.institution, face_registered = EXCLUDED.face_registered`, row);
      written++;
    }

    for (const e of Object.values(data.exams || {})) {
      const row = [e.id, e.code || null, e.title, e.description || null, e.durationMinutes || null, e.status || 'OPEN', json(e.rules || {}), (e.questions || []).length, ts(e.createdAt),
        ts(e.startsAt), ts(e.endsAt), e.createdBy || null];
      if (this.changed('exam', e.id, row)) {
        await q(`INSERT INTO trinetra.exams (id, join_code, title, description, duration_minutes, status, rules, question_count, created_at, starts_at, ends_at, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (id) DO UPDATE SET join_code = EXCLUDED.join_code, title = EXCLUDED.title, description = EXCLUDED.description,
                   duration_minutes = EXCLUDED.duration_minutes, status = EXCLUDED.status, rules = EXCLUDED.rules, question_count = EXCLUDED.question_count,
                   starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, created_by = EXCLUDED.created_by`, row);
        written++;
      }
      for (const [i, qn] of (e.questions || []).entries()) {
        const qrow = [qn.id, e.id, i + 1, qn.category || null, qn.text || qn.prompt, json(qn.options || []), qn.correctOptionId || null, qn.explanation || null, qn.hint || null];
        if (!this.changed('question', qn.id, qrow)) continue;
        await q(`INSERT INTO trinetra.exam_questions (id, exam_id, position, category, text, options, correct_option_id, explanation, hint)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, category = EXCLUDED.category, text = EXCLUDED.text,
                   options = EXCLUDED.options, correct_option_id = EXCLUDED.correct_option_id, explanation = EXCLUDED.explanation, hint = EXCLUDED.hint`, qrow);
        written++;
      }
    }

    for (const s of Object.values(data.sessions || {})) {
      const row = [s.id, s.examId || null, s.candidateId || s.studentId, s.candidateName || null, s.status, ts(s.startedAt), ts(s.expiresAt),
        ts(s.submittedAt), s.score == null ? null : s.score, s.maxScore || s.total || null, s.strikeCount || 0, s.maxStrikes || null,
        s.resumeCount || 0, s.disqualifiedReason || null, s.deviceId || null];
      if (this.changed('attempt', s.id, row)) {
        await q(`INSERT INTO trinetra.attempts (id, exam_id, roll_no, candidate_name, status, started_at, expires_at, submitted_at, score, max_score,
                   warnings, warning_limit, resume_count, termination_reason, device_id, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
                 ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, submitted_at = EXCLUDED.submitted_at,
                   score = EXCLUDED.score, max_score = EXCLUDED.max_score, warnings = EXCLUDED.warnings, warning_limit = EXCLUDED.warning_limit,
                   resume_count = EXCLUDED.resume_count, termination_reason = EXCLUDED.termination_reason, updated_at = NOW()`, row);
        written++;
      }

      const answers = this.fresh(`answers:${s.id}`, s.answerLog || []);
      for (const a of answers.rows) {
        await q(`INSERT INTO trinetra.answers (attempt_id, question_id, selected_option_id, previous_option_id, answered_at)
                 VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [s.id, a.questionId, a.selectedOptionId, a.previousOptionId, ts(a.at)]);
        written++;
      }
      answers.commit();

      const searches = this.fresh(`searches:${s.id}`, s.searchEvents || []);
      for (const e of searches.rows) {
        await q(`INSERT INTO trinetra.searches (id, attempt_id, service, query, url, is_ai_tool, blocked, block_reason, occurred_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [e.id, s.id, e.service, e.query || e.queryText || null, e.url || null, Boolean(e.isFlaggedAiTool), Boolean(e.blocked), e.blockReason || null, ts(e.timestamp)]);
        written++;
      }
      searches.commit();

      const assist = this.fresh(`assist:${s.id}`, s.assistLog || []);
      for (const m of assist.rows) {
        await q(`INSERT INTO trinetra.assistant_messages (attempt_id, question_id, asked_at, message, reply, outcome, source, removed_sentences)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [s.id, m.questionId, ts(m.at), m.message, m.reply, m.outcome, m.source, m.removedSentences || 0]);
        written++;
      }
      assist.commit();

      const actions = this.fresh(`actions:${s.id}`, s.proctorActions || []);
      for (const a of actions.rows) {
        const { action, reason, at, ...details } = a;
        await q(`INSERT INTO trinetra.proctor_actions (attempt_id, action, reason, details, acted_at)
                 VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [s.id, action, reason || null, json(details), ts(at)]);
        written++;
      }
      actions.commit();
    }

    const violations = this.fresh('violations', data.violations || []);
    for (const v of violations.rows) {
      if (!v.id) continue;
      await q(`INSERT INTO trinetra.violations (id, attempt_id, type, severity, message, details, warning_number, snapshot_jpeg, occurred_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.sessionId, v.type, v.severity || null, v.message || null, json(v.details || {}), v.strikeNumber || null, v.snapshot || null, ts(v.timestamp)]);
      written++;
    }
    violations.commit();

    const visits = this.fresh('page_visits', data.tabActivities || []);
    for (const t of visits.rows) {
      await q(`INSERT INTO trinetra.page_visits (id, attempt_id, event_type, url, domain, title, is_ai_tool, occurred_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [t.id, t.sessionId, t.eventType || t.type, t.url || null, t.domain || null, t.title || null, Boolean(t.isFlaggedAiTool), ts(t.timestamp)]);
      written++;
    }
    visits.commit();

    const activity = this.fresh('activity', data.inputActivities || []);
    for (const i of activity.rows) {
      await q(`INSERT INTO trinetra.activity_events (id, attempt_id, event_type, details, occurred_at)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [i.id, i.sessionId, i.eventType || i.type, json(i.details || i.data || {}), ts(i.timestamp)]);
      written++;
    }
    activity.commit();

    return written;
  }

  async close() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingData) await this.flush();
    if (this.pool && typeof this.pool.end === 'function') await this.pool.end();
    this.pool = null;
  }
}

module.exports = new PostgresMirror();
module.exports.PostgresMirror = PostgresMirror;
module.exports.SCHEMA_SQL = SCHEMA_SQL;
module.exports.VIEWS_SQL = VIEWS_SQL;
module.exports.UPGRADE_SQL = UPGRADE_SQL;
module.exports.HARDENING_SQL = HARDENING_SQL;
