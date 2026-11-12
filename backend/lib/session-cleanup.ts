export const EXPIRED_SESSION_COUNT_SQL = `SELECT session_mode, count(*)::integer AS count
FROM sessions
WHERE expires_at IS NOT NULL AND expires_at <= now()
GROUP BY session_mode`;

export const EXPIRED_SESSION_DELETE_SQL = `DELETE FROM sessions
WHERE expires_at IS NOT NULL AND expires_at <= now()
RETURNING id`;

export function sessionCleanupPlan(apply: boolean) {
  return {
    dryRun: !apply,
    touchesLegacyNullExpiry: false,
    reads: [EXPIRED_SESSION_COUNT_SQL],
    writes: apply ? [EXPIRED_SESSION_DELETE_SQL] : [],
  };
}
