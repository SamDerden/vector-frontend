CREATE TABLE IF NOT EXISTS request_budgets (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0)
);
CREATE INDEX IF NOT EXISTS idx_clarifications_diagnostic_latest
  ON clarifications(session_id, diagnostic_id, submitted_at DESC);
