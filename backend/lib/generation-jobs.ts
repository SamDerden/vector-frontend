import { createHash } from "node:crypto";

type DbQueryResult = {
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
};

type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<DbQueryResult>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([
  "pipeline_failed",
  "persist_failed",
  "incomplete_result",
  "attempts_exhausted",
  "input_unavailable",
  "input_mismatch",
]);

export const RETRYABLE_ERROR_CODES = new Set(["pipeline_failed"]);
export const MAX_GENERATION_ATTEMPTS = 3;
export const INPUT_SCHEMA_VERSION = 1;

export const JOB_LOCK = "3 minutes";

export const CLAIM_JOB_SQL = `INSERT INTO generation_jobs (
  session_id,
  client_request_id,
  input_hash,
  input_schema_version,
  input_snapshot,
  status,
  attempt_count,
  locked_by,
  locked_until,
  stage_timings
)
VALUES (
  $1, $2, $3, ${INPUT_SCHEMA_VERSION}, $4::jsonb, 'running', 1, 'api-request', now() + interval '${JOB_LOCK}', '{}'::jsonb
)
ON CONFLICT (session_id, client_request_id) DO NOTHING
RETURNING
  id, session_id, client_request_id, input_hash, status, recommendation_id,
  error_code, stage_timings, attempt_count, locked_by, locked_until,
  created_at, updated_at, completed_at`;

export const READ_JOB_SQL = `SELECT
  id, session_id, client_request_id, input_hash, status, recommendation_id,
  error_code, stage_timings, attempt_count, locked_by, locked_until,
  created_at, updated_at, completed_at
FROM generation_jobs
WHERE session_id = $1 AND client_request_id = $2`;

export const KEEP_LEASE_SQL = `UPDATE generation_jobs
SET locked_until = now() + interval '${JOB_LOCK}',
    updated_at = now()
WHERE id = $1 AND session_id = $2 AND locked_by = $3 AND status = 'running'
RETURNING id`;

export const FAIL_JOB_SQL = `UPDATE generation_jobs
SET status = 'failed',
    error_code = $3,
    stage_timings = $4::jsonb,
    updated_at = now(),
    locked_by = NULL,
    locked_until = NULL
WHERE id = $1 AND session_id = $2 AND status = 'running' AND locked_by = $5`;

export const COMPLETE_JOB_SQL = `UPDATE generation_jobs
SET status = 'completed',
    recommendation_id = $3,
    stage_timings = $4::jsonb,
    completed_at = now(),
    updated_at = now(),
    error_code = NULL,
    locked_by = NULL,
    locked_until = NULL
WHERE id = $1 AND session_id = $2 AND status IN ('pending', 'running')`;

export const COMPLETE_OWNED_SQL = `UPDATE generation_jobs
SET status = 'completed',
    recommendation_id = $3,
    stage_timings = $4::jsonb,
    completed_at = now(),
    updated_at = now(),
    error_code = NULL,
    locked_by = NULL,
    locked_until = NULL
WHERE id = $1 AND session_id = $2 AND status IN ('pending', 'running') AND locked_by = $5`;

export const RECOVER_JOB_SQL = `UPDATE generation_jobs
SET status = 'completed',
    recommendation_id = $3,
    stage_timings = $4::jsonb,
    completed_at = now(),
    updated_at = now(),
    error_code = NULL,
    locked_by = NULL,
    locked_until = NULL
WHERE id = $1 AND session_id = $2
  AND status IN ('pending', 'running', 'failed')
  AND (recommendation_id IS NULL OR recommendation_id = $3)`;

// A read may attach an already stored recommendation only after PostgreSQL
// confirms that no running owner still holds an unexpired lease.
export const RECOVER_INACTIVE_JOB_SQL = `UPDATE generation_jobs
SET status = 'completed',
    recommendation_id = $3,
    stage_timings = $4::jsonb,
    completed_at = COALESCE(completed_at, now()),
    updated_at = now(),
    error_code = NULL,
    locked_by = NULL,
    locked_until = NULL
WHERE id = $1
  AND session_id = $2
  AND status IN ('pending', 'running', 'failed')
  AND (recommendation_id IS NULL OR recommendation_id = $3)
  AND NOT (
    status = 'running'
    AND locked_by IS NOT NULL
    AND locked_until IS NOT NULL
    AND locked_until >= now()
  )`;

export const OWNED_RECOMMENDATION_SQL = `SELECT
  id,
  session_id,
  summary,
  hypotheses,
  trial_ids,
  next_step,
  pathways,
  model_name,
  created_at,
  ai_payload,
  generation_mode,
  prompt_version,
  catalog_version,
  config_version
FROM recommendations
WHERE id = $1 AND session_id = $2`;

export const TRACK_SQL = `SELECT track_type FROM sessions WHERE id = $1`;

export const DIAGNOSTIC_VERSION_SQL = `SELECT d.submitted_at
FROM diagnostics d
WHERE d.id = $1 AND d.session_id = $2`;

export const CLARIFICATION_VERSION_SQL = `SELECT c.id, c.submitted_at
FROM clarifications c
WHERE c.session_id = $1 AND c.diagnostic_id = $2
ORDER BY c.submitted_at DESC
LIMIT 1`;

export type GenerationInputSnapshot = {
  schemaVersion: 1;
  schoolGrade: number;
  municipality: string;
  trackType: string;
  diagnosticId: string;
  diagnosticSubmittedAt: string;
  clarificationId: string;
  clarificationSubmittedAt: string;
  diagnosticAnswers: Array<{ questionId: string; answer: unknown; questionnaire?: string }>;
  clarificationAnswers: Array<{ questionId: string; answer: unknown }>;
  professionIds: string[];
};

export type JobStatus = "pending" | "running" | "completed" | "failed";

export type GenerationJob = {
  id: string;
  sessionId: string;
  clientRequestId: string;
  inputHash: string;
  status: JobStatus;
  recommendationId: string | null;
  errorCode: string | null;
  stageTimings: Record<string, unknown>;
  attemptCount: number;
  lockedBy: string | null;
  lockedUntil: unknown;
};

export type ClaimResult =
  | { kind: "owned"; job: GenerationJob }
  | { kind: "replay"; job: GenerationJob }
  | { kind: "in_progress"; job: GenerationJob }
  | { kind: "failed"; job: GenerationJob }
  | { kind: "conflict"; job: GenerationJob }
  | { kind: "unavailable" };

export function parseIdempotencyKey(value: string | null): { ok: true; key: string | null } | { ok: false } {
  if (value == null || value.trim() === "") return { ok: true, key: null };
  const key = value.trim();
  if (key.length > 36 || !UUID_PATTERN.test(key)) return { ok: false };
  return { ok: true, key: key.toLowerCase() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = stable(value[key]);
    return sorted;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function stamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

export function generationInputHash(input: {
  schoolGrade: number;
  municipality: string;
  trackType: string;
  diagnosticId: string;
  diagnosticSubmittedAt: unknown;
  clarificationId: string;
  clarificationSubmittedAt: unknown;
  diagnosticAnswers: Array<{ questionId: string; answer: unknown; questionnaire?: string }>;
  clarificationAnswers: Array<{ questionId: string; answer: unknown }>;
  professionIds: string[];
}): string {
  const diagnosticAnswers = [...input.diagnosticAnswers]
    .map((item) => ({
      questionId: item.questionId,
      answer: item.answer,
      questionnaire: item.questionnaire ?? "",
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  const clarificationAnswers = [...input.clarificationAnswers]
    .map((item) => ({ questionId: item.questionId, answer: item.answer }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  return digest({
    schoolGrade: input.schoolGrade,
    municipality: input.municipality,
    trackType: input.trackType,
    diagnosticId: input.diagnosticId,
    diagnosticSubmittedAt: stamp(input.diagnosticSubmittedAt),
    clarificationId: input.clarificationId,
    clarificationSubmittedAt: stamp(input.clarificationSubmittedAt),
    diagnosticAnswers: digest(diagnosticAnswers),
    clarificationAnswers: digest(clarificationAnswers),
    professionIds: [...input.professionIds].sort(),
  });
}

function mapJob(row: Record<string, unknown>): GenerationJob | null {
  const status = row.status;
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "failed") {
    return null;
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    clientRequestId: String(row.client_request_id),
    inputHash: String(row.input_hash),
    status,
    recommendationId: row.recommendation_id == null ? null : String(row.recommendation_id),
    errorCode: typeof row.error_code === "string" ? row.error_code : null,
    stageTimings: isRecord(row.stage_timings) ? row.stage_timings : {},
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 1,
    lockedBy: typeof row.locked_by === "string" ? row.locked_by : null,
    lockedUntil: row.locked_until ?? null,
  };
}

function decideExisting(job: GenerationJob, inputHash: string): ClaimResult {
  if (job.inputHash !== inputHash) return { kind: "conflict", job };
  if (job.status === "completed" && job.recommendationId) return { kind: "replay", job };
  if (job.status === "failed" || job.status === "completed") return { kind: "failed", job };
  return { kind: "in_progress", job };
}

export function parseGenerationSnapshot(value: unknown): GenerationInputSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== INPUT_SCHEMA_VERSION) return null;
  if (typeof value.schoolGrade !== "number" || !Number.isFinite(value.schoolGrade)) return null;
  if (typeof value.municipality !== "string" || typeof value.trackType !== "string") return null;
  if (typeof value.diagnosticId !== "string" || typeof value.diagnosticSubmittedAt !== "string") return null;
  if (typeof value.clarificationId !== "string" || typeof value.clarificationSubmittedAt !== "string") return null;
  if (!Array.isArray(value.diagnosticAnswers) || !Array.isArray(value.clarificationAnswers)) return null;
  if (!Array.isArray(value.professionIds) || value.professionIds.some((id) => typeof id !== "string")) return null;
  return value as GenerationInputSnapshot;
}

export function snapshotMatchesJob(snapshot: GenerationInputSnapshot, inputHash: string): boolean {
  return generationInputHash(snapshot) === inputHash;
}

export async function claimGenerationJob(
  query: DbQuery,
  input: { sessionId: string; clientRequestId: string; inputHash: string; snapshot: GenerationInputSnapshot }
): Promise<ClaimResult> {
  const inserted = await query(CLAIM_JOB_SQL, [
    input.sessionId,
    input.clientRequestId,
    input.inputHash,
    JSON.stringify(input.snapshot),
  ]);
  const created = inserted.rows[0] ? mapJob(inserted.rows[0]) : null;
  if ((inserted.rowCount ?? inserted.rows.length) > 0 && created) {
    return { kind: "owned", job: created };
  }
  const existing = await query(READ_JOB_SQL, [input.sessionId, input.clientRequestId]);
  const job = existing.rows[0] ? mapJob(existing.rows[0]) : null;
  if (!job) return { kind: "unavailable" };
  return decideExisting(job, input.inputHash);
}

export function publicErrorCode(value: string): string {
  return ERROR_CODES.has(value) ? value : "pipeline_failed";
}

export function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code: unknown }).code) : "";
  const name = error instanceof Error ? error.name : "";
  return code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ECONNRESET" || name === "AbortError" || name === "TimeoutError";
}

export function generationBudgetApplies(status: string | null | undefined): boolean {
  return status == null || status === "failed";
}

export async function readGenerationJob(
  query: DbQuery,
  sessionId: string,
  requestId: string
): Promise<GenerationJob | null> {
  const existing = await query(READ_JOB_SQL, [sessionId, requestId]);
  return existing.rows[0] ? mapJob(existing.rows[0]) : null;
}

export function publicJobAccess(
  status: JobStatus,
  recommendationId: string | null
): "pending" | "failed" | "saved" | "incomplete" {
  if (recommendationId) return "saved";
  if (status === "pending" || status === "running") return "pending";
  if (status === "failed") return "failed";
  return "incomplete";
}

export async function failGenerationJob(
  query: DbQuery,
  input: {
    jobId: string;
    sessionId: string;
    errorCode: string;
    stageTimings: Record<string, unknown>;
    owner: string;
  }
): Promise<DbQueryResult> {
  return query(FAIL_JOB_SQL, [
    input.jobId,
    input.sessionId,
    publicErrorCode(input.errorCode),
    JSON.stringify(input.stageTimings),
    input.owner,
  ]);
}

export async function completeGenerationJob(
  query: DbQuery,
  input: {
    jobId: string;
    sessionId: string;
    recommendationId: string;
    stageTimings: Record<string, unknown>;
  }
): Promise<DbQueryResult> {
  return query(COMPLETE_JOB_SQL, [
    input.jobId,
    input.sessionId,
    input.recommendationId,
    JSON.stringify(input.stageTimings),
  ]);
}

export async function completeOwnedGenerationJob(
  query: DbQuery,
  input: {
    jobId: string;
    sessionId: string;
    recommendationId: string;
    stageTimings: Record<string, unknown>;
    owner: string;
  }
): Promise<DbQueryResult> {
  return query(COMPLETE_OWNED_SQL, [
    input.jobId,
    input.sessionId,
    input.recommendationId,
    JSON.stringify(input.stageTimings),
    input.owner,
  ]);
}

export async function recoverInactiveGenerationJob(
  query: DbQuery,
  input: {
    jobId: string;
    sessionId: string;
    recommendationId: string;
    stageTimings: Record<string, unknown>;
  }
): Promise<DbQueryResult> {
  return query(RECOVER_INACTIVE_JOB_SQL, [
    input.jobId,
    input.sessionId,
    input.recommendationId,
    JSON.stringify(input.stageTimings),
  ]);
}

export async function recoverSavedGenerationJob(
  query: DbQuery,
  input: {
    jobId: string;
    sessionId: string;
    recommendationId: string;
    stageTimings: Record<string, unknown>;
  }
): Promise<DbQueryResult> {
  return query(RECOVER_JOB_SQL, [
    input.jobId,
    input.sessionId,
    input.recommendationId,
    JSON.stringify(input.stageTimings),
  ]);
}

export async function loadOwnedRecommendation(
  query: DbQuery,
  recommendationId: string,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  const saved = await query(OWNED_RECOMMENDATION_SQL, [recommendationId, sessionId]);
  return saved.rows[0] ?? null;
}

export function inProgressBody(job: GenerationJob): Record<string, unknown> {
  return {
    requestId: job.clientRequestId,
    jobStatus: job.status === "pending" ? "pending" : "running",
    status: "in_progress",
    retryAfterMs: 2000,
  };
}
