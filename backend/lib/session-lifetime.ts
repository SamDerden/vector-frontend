export const SESSION_EXPIRY_SQL = `SELECT id, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
FROM sessions
WHERE id = $1`;

export const SESSION_ID_SQL = `SELECT id FROM sessions WHERE id = $1`;

export const SESSION_UPSERT_LIFETIME_SQL = `INSERT INTO sessions (id, track_type, session_mode, expires_at, created_at, updated_at)
VALUES ($1, $2, $3, now() + ($4::integer * interval '1 hour'), now(), now())
ON CONFLICT (id)
DO UPDATE SET track_type = EXCLUDED.track_type, updated_at = now()
WHERE (sessions.expires_at IS NULL OR sessions.expires_at > now())
  AND (sessions.session_mode IS NULL OR sessions.session_mode = EXCLUDED.session_mode)`;

export const SESSION_UPSERT_LEGACY_SQL = `INSERT INTO sessions (id, track_type, created_at, updated_at)
VALUES ($1, $2, now(), now())
ON CONFLICT (id)
DO UPDATE SET track_type = EXCLUDED.track_type, updated_at = now()`;

export const SESSION_CONFLICT_SQL = `SELECT session_mode, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
FROM sessions
WHERE id = $1`;

export type SessionLiveness = "ok" | "missing" | "expired";

export function interpretSessionRow(
  rowCount: number,
  row: { expired?: unknown } | undefined
): SessionLiveness {
  if (rowCount <= 0 || !row) return "missing";
  if (row.expired === true) return "expired";
  return "ok";
}

export function sessionLifetimeHours(mode: "demo" | "own"): number {
  return mode === "demo" ? 24 : 24 * 7;
}
