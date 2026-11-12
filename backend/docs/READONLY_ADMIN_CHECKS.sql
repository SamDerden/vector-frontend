-- Read-only checks for an administrator.
-- Every statement is a SELECT. Do not add INSERT, UPDATE, DELETE, TRUNCATE, or ALTER.
-- Do not select answer, comment, prompt, snapshot, cookie, token, or proof columns.
-- Run only against the database that was explicitly approved.
-- Do not point this file at navigator-postgres (port 5433).

-- Identity. Expect the approved database name, not a guess from this repository.
SELECT current_database() AS database_name, current_user AS user_name;

-- Applied migration files. This repository records the full filename.
SELECT filename FROM schema_migrations ORDER BY filename;

-- Catalog shape. graph_profession_id is expected to stay empty until an approved source mapping exists.
SELECT
  (SELECT count(*)::int FROM professions) AS professions,
  (SELECT count(*)::int FROM professions WHERE external_id IS NULL) AS professions_without_external_id,
  (SELECT count(*)::int FROM professions WHERE graph_profession_id IS NULL) AS professions_without_graph_id,
  (SELECT count(*)::int FROM education_programs) AS education_programs,
  (SELECT count(*)::int FROM education_programs WHERE graph_program_id IS NULL) AS programs_without_graph_id,
  (SELECT count(*)::int FROM organizations) AS organizations,
  (SELECT count(*)::int FROM organizations WHERE graph_organization_id IS NULL) AS organizations_without_graph_id,
  (SELECT count(*)::int FROM professional_trials) AS trials,
  (SELECT count(*)::int FROM professional_trials WHERE graph_trial_id IS NULL) AS trials_without_graph_id,
  (SELECT count(*)::int FROM industries) AS industries,
  (SELECT count(*)::int FROM program_professions) AS program_links,
  (SELECT count(*)::int FROM trial_professions) AS trial_links;

-- Broken links. A non-zero count is a catalog defect. Do not repair it from this file.
SELECT
  (SELECT count(*)::int FROM program_professions pp
    WHERE NOT EXISTS (SELECT 1 FROM professions p WHERE p.id = pp.profession_id)) AS orphan_program_professions,
  (SELECT count(*)::int FROM program_professions pp
    WHERE NOT EXISTS (SELECT 1 FROM education_programs e WHERE e.id = pp.program_id)) AS orphan_program_rows,
  (SELECT count(*)::int FROM trial_professions tp
    WHERE NOT EXISTS (SELECT 1 FROM professions p WHERE p.id = tp.profession_id)) AS orphan_trial_professions,
  (SELECT count(*)::int FROM trial_professions tp
    WHERE NOT EXISTS (SELECT 1 FROM professional_trials t WHERE t.id = tp.trial_id)) AS orphan_trial_rows;

-- Queue health for the last hour. No payloads.
SELECT status, count(*)::int AS jobs
FROM generation_jobs
WHERE updated_at > now() - interval '1 hour'
GROUP BY status
ORDER BY status;

SELECT COALESCE(error_code, 'null') AS error_code, count(*)::int AS jobs
FROM generation_jobs
WHERE status = 'failed'
  AND updated_at > now() - interval '1 hour'
GROUP BY error_code
ORDER BY error_code;

-- Split writes: a recommendation without its job, or a completed job without a recommendation.
SELECT
  (SELECT count(*)::int FROM recommendations WHERE generation_job_id IS NULL) AS recommendations_without_job,
  (SELECT count(*)::int FROM generation_jobs
    WHERE status = 'completed' AND recommendation_id IS NULL) AS completed_without_recommendation,
  (SELECT count(*)::int FROM generation_jobs j
    JOIN recommendations r ON r.id = j.recommendation_id
    WHERE r.session_id <> j.session_id) AS session_mismatch;

-- Budgets. Keys only, no session identifiers beyond the aggregate key text already stored by the limiter.
SELECT key, used
FROM request_budgets
WHERE key IN ('generate:global', 'ai:global:day', 'sessions:global')
   OR key LIKE 'sessions:ip:%'
ORDER BY key;

-- Legacy rows. NULL expiry and NULL journey_step are valid old rows. Do not delete them from this file.
SELECT
  (SELECT count(*)::int FROM sessions WHERE expires_at IS NULL) AS sessions_without_expiry,
  (SELECT count(*)::int FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= now()) AS sessions_expired,
  (SELECT count(*)::int FROM reflections WHERE journey_step IS NULL) AS reflections_without_step,
  (SELECT count(*)::int FROM education_routes WHERE profession_key = 'none') AS routes_without_profession_uuid,
  (SELECT count(*)::int FROM education_routes WHERE profession_key <> 'none') AS routes_with_profession_uuid;
