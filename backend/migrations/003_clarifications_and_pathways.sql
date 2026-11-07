-- Миграция 003: уточняющие ответы и пути развития.
-- Аддитивно: существующие таблицы и данные не удаляются.

CREATE TABLE IF NOT EXISTS clarifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  diagnostic_id UUID REFERENCES diagnostics(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clarifications_session ON clarifications(session_id);

CREATE TABLE IF NOT EXISTS clarification_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clarification_id UUID NOT NULL REFERENCES clarifications(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clarification_id, question_id)
);

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS pathways JSONB NOT NULL DEFAULT '[]'::jsonb;
