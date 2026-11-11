-- Session lifetime metadata. Existing sessions remain legacy (NULL expiry)
-- until an explicit rollout decision. This migration does not delete rows.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_mode TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_session_mode_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_session_mode_check
  CHECK (session_mode IS NULL OR session_mode IN ('demo', 'own'));

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON sessions (expires_at) WHERE expires_at IS NOT NULL;
