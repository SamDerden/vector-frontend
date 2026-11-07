CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  track_type TEXT NOT NULL CHECK (track_type IN ('explore', 'interests', 'known_direction')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  school_grade SMALLINT CHECK (school_grade BETWEEN 8 AND 11),
  municipality TEXT NOT NULL DEFAULT 'Екатеринбург',
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_diagnostics_session ON diagnostics(session_id);

CREATE TABLE IF NOT EXISTS diagnostic_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  diagnostic_id UUID NOT NULL REFERENCES diagnostics(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (diagnostic_id, question_id)
);

CREATE TABLE IF NOT EXISTS regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  organization_type TEXT,
  website TEXT,
  contact_email TEXT,
  region_id UUID REFERENCES regions(id),
  source_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT,
  source_type TEXT,
  checked_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_source_id_fkey;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_source_id_fkey
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS professions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL UNIQUE,
  description TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  industries TEXT[] NOT NULL DEFAULT '{}',
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS education_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  institution TEXT NOT NULL,
  description TEXT,
  url TEXT,
  region_id UUID REFERENCES regions(id),
  profession_id UUID REFERENCES professions(id) ON DELETE SET NULL,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS professional_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  format TEXT,
  age_min SMALLINT,
  age_max SMALLINT,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  region_id UUID REFERENCES regions(id),
  profession_id UUID REFERENCES professions(id) ON DELETE SET NULL,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (age_min IS NULL OR age_min BETWEEN 8 AND 25),
  CHECK (age_max IS NULL OR age_max BETWEEN 8 AND 25),
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max)
);
CREATE INDEX IF NOT EXISTS idx_trials_region_active ON professional_trials(region_id, is_active);

CREATE TABLE IF NOT EXISTS recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT,
  hypotheses JSONB NOT NULL DEFAULT '[]'::jsonb,
  trial_ids UUID[] NOT NULL DEFAULT '{}',
  next_step TEXT,
  model_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_session ON recommendations(session_id);

CREATE TABLE IF NOT EXISTS reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  rating TEXT NOT NULL CHECK (rating IN ('useful', 'unsure', 'not_useful')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  description TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by TEXT
);

INSERT INTO regions(name) VALUES ('Екатеринбург')
ON CONFLICT (name) DO NOTHING;
