-- Миграция 007: задачи генерации.
-- Аддитивно: sessions, recommendations и миграции 001–006 не изменяются.
-- Существующие рекомендации остаются без строк в generation_jobs.
-- Миграция ничего не вставляет и не обновляет.

CREATE TABLE IF NOT EXISTS generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_request_id UUID NOT NULL,
  input_hash TEXT NOT NULL,
  input_schema_version INTEGER NOT NULL DEFAULT 1,
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  error_code TEXT,
  stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (session_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS generation_jobs_session_status_idx
  ON generation_jobs (session_id, status);

CREATE INDEX IF NOT EXISTS generation_jobs_reclaim_idx
  ON generation_jobs (locked_until)
  WHERE status IN ('pending', 'running');

-- Пустая колонка не меняет уже сохранённые рекомендации и старый INSERT.
-- Уникальность не даёт worker создать вторую рекомендацию для той же задачи.
ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS generation_job_id UUID UNIQUE
  REFERENCES generation_jobs(id) ON DELETE SET NULL;
