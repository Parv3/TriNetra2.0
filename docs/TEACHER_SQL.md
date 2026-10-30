# Student logs in PostgreSQL

When the server runs with `DATABASE_URL` set, every attempt, answer, violation, page visit, search, Guided help message and proctor action is mirrored into PostgreSQL (schema `trinetra`) within about a second. Teachers can query it with any PostgreSQL client — `psql`, pgAdmin, DBeaver, DataGrip, Metabase, or Excel/Power BI via ODBC.

## 1. Enable it

```bash
# Local Postgres
DATABASE_URL=postgres://trinetra:secret@localhost:5432/trinetra npm start

# Docker deployment: already enabled by deploy/docker-compose.yml
```

The console's top bar shows **PostgreSQL: synced hh:mm:ss** when it is working. Tables and views are created automatically on first start.

## 2. Give teachers a read-only login

Run once as the database owner:

```sql
CREATE ROLE teacher LOGIN PASSWORD 'choose-a-password';
GRANT USAGE ON SCHEMA trinetra TO teacher;
GRANT SELECT ON ALL TABLES IN SCHEMA trinetra TO teacher;
ALTER DEFAULT PRIVILEGES IN SCHEMA trinetra GRANT SELECT ON TABLES TO teacher;
```

Teachers connect with host, port `5432`, database `trinetra`, user `teacher`. They can read everything and change nothing.

## 3. What's there

**Views written for teachers** (start here):

| View | One row per | Useful columns |
|---|---|---|
| `trinetra.v_attempts` | exam attempt | `roll_no`, `candidate_name`, `exam`, `status`, `score`, `max_score`, `warnings`, `violation_count`, `ai_attempts`, `blocked_searches`, `assistant_messages`, `resume_count`, `termination_reason` |
| `trinetra.v_student_timeline` | recorded event | `roll_no`, `occurred_at`, `category` (answer, search, page, violation, assistant, activity, proctor), `event`, `detail` |
| `trinetra.v_ai_and_search` | site / search / AI attempt | `roll_no`, `service`, `query`, `is_ai_tool`, `blocked`, `block_reason` |

**Tables:** `candidates`, `exams`, `exam_questions`, `attempts`, `answers` (every answer change), `violations` (with `snapshot_jpeg`, the frame captured as evidence), `page_visits`, `searches`, `activity_events` (keyboard, mouse, clipboard, devices), `assistant_messages`, `proctor_actions`.

## 4. Example queries

Results for one exam, worst integrity first:

```sql
SELECT roll_no, candidate_name, score, max_score, warnings, violation_count, ai_attempts, status
FROM trinetra.v_attempts
WHERE join_code = 'AJZD7P'
ORDER BY violation_count DESC, ai_attempts DESC;
```

Everything one student did, in order:

```sql
SELECT occurred_at, category, event, detail
FROM trinetra.v_student_timeline
WHERE roll_no = '21CS101'
ORDER BY occurred_at;
```

Who tried to use AI, and what they typed:

```sql
SELECT roll_no, candidate_name, occurred_at, service, query, blocked
FROM trinetra.v_ai_and_search
WHERE is_ai_tool
ORDER BY occurred_at;
```

Students who were caught with a phone or earphones:

```sql
SELECT a.roll_no, a.candidate_name, v.type, v.occurred_at, v.message
FROM trinetra.violations v
JOIN trinetra.attempts a ON a.id = v.attempt_id
WHERE v.type IN ('PHONE_DETECTED', 'EARPIECE_DETECTED')
ORDER BY v.occurred_at;
```

Questions most often changed after a lookup (answer churn):

```sql
SELECT q.position, q.text, COUNT(*) AS changes
FROM trinetra.answers x
JOIN trinetra.exam_questions q ON q.id = x.question_id
WHERE x.previous_option_id IS NOT NULL
GROUP BY q.position, q.text
ORDER BY changes DESC;
```

Per-question accuracy for an exam:

```sql
WITH final AS (
  SELECT DISTINCT ON (attempt_id, question_id) attempt_id, question_id, selected_option_id
  FROM trinetra.answers
  ORDER BY attempt_id, question_id, answered_at DESC
)
SELECT q.position, q.text,
       ROUND(100.0 * AVG(CASE WHEN f.selected_option_id = q.correct_option_id THEN 1 ELSE 0 END), 1) AS pct_correct,
       COUNT(*) AS answered
FROM final f
JOIN trinetra.exam_questions q ON q.id = f.question_id
GROUP BY q.position, q.text
ORDER BY q.position;
```

Attempts the proctor terminated or resumed, and why:

```sql
SELECT a.roll_no, a.candidate_name, p.action, p.reason, p.acted_at
FROM trinetra.proctor_actions p
JOIN trinetra.attempts a ON a.id = p.attempt_id
ORDER BY p.acted_at;
```
