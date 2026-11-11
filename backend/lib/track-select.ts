import { trackSchema } from "./schemas.ts";

export type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
}>;

export type TrackSelectOutcome =
  | { ok: true; status: 200; body: { sessionId: string; trackType: string; status: "selected" } }
  | { ok: false; status: number; error: string; details?: unknown };

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;
type ConfidenceLevel = keyof typeof CONFIDENCE_RANK;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return value === "low" || value === "medium" || value === "high";
}

export function mergeConfidenceBefore(
  current: unknown,
  confidenceBefore: ConfidenceLevel
): Record<string, unknown> {
  const preferences = isRecord(current) ? { ...current } : {};
  const confidence = isRecord(preferences.confidence) ? { ...preferences.confidence } : {};
  confidence.before = confidenceBefore;
  if (!("after" in confidence)) {
    confidence.after = null;
  }
  if (confidence.after == null) {
    confidence.delta = null;
  } else if (isConfidenceLevel(confidence.after)) {
    confidence.delta = CONFIDENCE_RANK[confidence.after] - CONFIDENCE_RANK[confidenceBefore];
  }
  preferences.confidence = confidence;
  return preferences;
}

export async function executeTrackSelect(input: {
  sessionId: string;
  body: unknown;
  query: DbQuery;
}): Promise<TrackSelectOutcome> {
  const parsed = trackSchema.omit({ sessionId: true }).safeParse(input.body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      error: "Validation failed",
      details: parsed.error.issues,
    };
  }

  const { trackType, schoolGrade, confidenceBefore } = parsed.data;
  const demoStudentId = isRecord(input.body) ? input.body.demoStudentId : undefined;
  if (demoStudentId !== undefined &&
      (typeof demoStudentId !== "number" || !Number.isInteger(demoStudentId) ||
       demoStudentId < 1 || demoStudentId > 15)) {
    return { ok: false, status: 422, error: "Invalid demo student id" };
  }
  const sessionMode = demoStudentId === undefined ? "own" : "demo";
  const lifetimeHours = sessionMode === "demo" ? 24 : 168;
  const inserted = await input.query(
    `INSERT INTO sessions (id, track_type, session_mode, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, now() + ($4::integer * interval '1 hour'), now(), now())
     ON CONFLICT (id)
     DO UPDATE SET track_type = EXCLUDED.track_type, updated_at = now()
     WHERE (sessions.expires_at IS NULL OR sessions.expires_at > now())
       AND (sessions.session_mode IS NULL OR sessions.session_mode = EXCLUDED.session_mode)`,
    [input.sessionId, trackType, sessionMode, lifetimeHours]
  );
  if (inserted.rowCount === 0) {
    const current = await input.query(
      "SELECT session_mode, expires_at <= now() AS expired FROM sessions WHERE id = $1",
      [input.sessionId]
    );
    if (current.rows[0]?.expired === true) {
      return { ok: false, status: 410, error: "Session expired. Start a new session." };
    }
    return { ok: false, status: 409, error: "Session mode conflict. Start a new session." };
  }

  if (schoolGrade === undefined && confidenceBefore === undefined) {
    return {
      ok: true,
      status: 200,
      body: { sessionId: input.sessionId, trackType, status: "selected" },
    };
  }

  const existing = await input.query(
    `SELECT school_grade, preferences
     FROM profiles
     WHERE session_id = $1`,
    [input.sessionId]
  );
  const row = existing.rows[0];
  const preferences = confidenceBefore
    ? mergeConfidenceBefore(row?.preferences, confidenceBefore)
    : null;

  if (!row) {
    await input.query(
      `INSERT INTO profiles (session_id, school_grade, preferences)
       VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb))`,
      [input.sessionId, schoolGrade ?? null, preferences ? JSON.stringify(preferences) : null]
    );
  } else {
    if (schoolGrade !== undefined) {
      await input.query(
        `UPDATE profiles
         SET school_grade = $2
         WHERE session_id = $1`,
        [input.sessionId, schoolGrade]
      );
    }
    if (preferences) {
      await input.query(
        `UPDATE profiles
         SET preferences = $2::jsonb
         WHERE session_id = $1`,
        [input.sessionId, JSON.stringify(preferences)]
      );
    }
  }

  return {
    ok: true,
    status: 200,
    body: { sessionId: input.sessionId, trackType, status: "selected" },
  };
}
