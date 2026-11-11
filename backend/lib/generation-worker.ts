import { randomUUID } from "node:crypto";

import {
  JOB_LOCK,
  MAX_GENERATION_ATTEMPTS,
  RETRYABLE_ERROR_CODES,
  completeGenerationJob,
  failGenerationJob,
  parseGenerationSnapshot,
  publicErrorCode,
  snapshotMatchesJob,
  type GenerationInputSnapshot,
  type GenerationJob,
} from "./generation-jobs.ts";
import {
  LINKED_RECOMMENDATION_SQL,
  runFrozenGeneration,
  type DbQuery,
  type GenerateDeps,
  type GenerateOutcome,
} from "./sofi-generate.ts";

const JOB_COLUMNS = `id, session_id, client_request_id, input_hash, input_snapshot,
  status, recommendation_id, error_code, stage_timings, attempt_count, locked_by, locked_until`;

export const WORKER_ATTACH_SQL = `SELECT ${JOB_COLUMNS.split(",").map(column => "j." + column.trim()).join(", ")},
  COALESCE(j.recommendation_id, r.id) AS saved_recommendation_id
FROM generation_jobs j
LEFT JOIN recommendations r
  ON r.generation_job_id = j.id AND r.session_id = j.session_id
WHERE j.status IN ('pending', 'running')
  AND (j.status = 'pending' OR j.locked_until < now())
  AND (j.recommendation_id IS NOT NULL OR r.id IS NOT NULL)
ORDER BY j.created_at
FOR UPDATE OF j SKIP LOCKED
LIMIT 1`;

export const WORKER_EXHAUST_SQL = `UPDATE generation_jobs
SET status = 'failed',
    error_code = 'attempts_exhausted',
    locked_by = NULL,
    locked_until = NULL,
    updated_at = now()
WHERE status IN ('pending', 'running')
  AND attempt_count >= $1
  AND recommendation_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM recommendations r
    WHERE r.generation_job_id = generation_jobs.id
  )
  AND (status = 'pending' OR locked_until < now())`;

export const WORKER_CLAIM_SQL = `SELECT ${JOB_COLUMNS}
FROM generation_jobs
WHERE attempt_count < $1
  AND recommendation_id IS NULL
  AND (
    status = 'pending'
    OR (status = 'running' AND locked_until < now())
  )
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1`;

export const WORKER_LOCK_SQL = `UPDATE generation_jobs
SET status = 'running',
    locked_by = $2,
    locked_until = now() + interval '${JOB_LOCK}',
    attempt_count = attempt_count + 1,
    updated_at = now()
WHERE id = $1
RETURNING ${JOB_COLUMNS}`;

export const WORKER_RENEW_SQL = `UPDATE generation_jobs
SET locked_until = now() + interval '${JOB_LOCK}', updated_at = now()
WHERE id = $1 AND locked_by = $2 AND status = 'running'`;

export const WORKER_REQUEUE_SQL = `UPDATE generation_jobs
SET status = 'pending',
    locked_by = NULL,
    locked_until = NULL,
    updated_at = now()
WHERE id = $1 AND session_id = $2 AND locked_by = $3 AND status = 'running'`;

export type WorkerDeps = GenerateDeps & {
  workerId?: string;
  renewEveryMs?: number;
  idleMs?: number;
  generate?: (input: {
    job: GenerationJob;
    snapshot: GenerationInputSnapshot;
    deps: GenerateDeps;
  }) => Promise<GenerateOutcome>;
};

const RENEW_EVERY_MS = 30 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapJob(row: Record<string, unknown>): GenerationJob | null {
  const status = row.status;
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "failed") return null;
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    clientRequestId: String(row.client_request_id),
    inputHash: String(row.input_hash),
    status,
    recommendationId: row.recommendation_id == null ? null : String(row.recommendation_id),
    errorCode: typeof row.error_code === "string" ? row.error_code : null,
    stageTimings: isRecord(row.stage_timings) ? row.stage_timings : {},
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
    lockedBy: typeof row.locked_by === "string" ? row.locked_by : null,
    lockedUntil: row.locked_until ?? null,
  };
}

function outcomeCode(outcome: GenerateOutcome): string {
  if (outcome.ok) return "";
  const details = outcome.details;
  if (isRecord(details) && typeof details.errorCode === "string") return publicErrorCode(details.errorCode);
  return "pipeline_failed";
}

async function settleFailure(query: DbQuery, deps: WorkerDeps, job: GenerationJob, code: string) {
  const safe = publicErrorCode(code);
  if (RETRYABLE_ERROR_CODES.has(safe) && job.attemptCount < MAX_GENERATION_ATTEMPTS) {
    await query(WORKER_REQUEUE_SQL, [job.id, job.sessionId, deps.workerId]);
    return;
  }
  if (!deps.workerId) return;
  await failGenerationJob(query, {
    jobId: job.id,
    sessionId: job.sessionId,
    errorCode: job.attemptCount >= MAX_GENERATION_ATTEMPTS && RETRYABLE_ERROR_CODES.has(safe)
      ? "attempts_exhausted"
      : safe,
    stageTimings: job.stageTimings,
    owner: deps.workerId,
  });
}

function startLease(deps: WorkerDeps, jobId: string) {
  const renewEveryMs = deps.renewEveryMs ?? RENEW_EVERY_MS;
  const timer = setInterval(() => {
    void deps.query(WORKER_RENEW_SQL, [jobId, deps.workerId]).catch((error: unknown) => {
      console.error("generation lease was not renewed", error instanceof Error ? error.name : "unknown");
    });
  }, renewEveryMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function finishSaved(query: DbQuery, job: GenerationJob, recommendationId: string) {
  await completeGenerationJob(query, {
    jobId: job.id,
    sessionId: job.sessionId,
    recommendationId,
    stageTimings: job.stageTimings,
  });
}

async function executeClaimed(row: Record<string, unknown>, deps: WorkerDeps) {
  const job = mapJob(row);
  if (!job) return;
  const savedId = row.saved_recommendation_id ?? job.recommendationId;
  if (savedId) {
    await finishSaved(deps.query, job, String(savedId));
    return;
  }
  const linked = await deps.query(LINKED_RECOMMENDATION_SQL, [job.id, job.sessionId]);
  if (linked.rows[0]?.id) {
    await finishSaved(deps.query, job, String(linked.rows[0].id));
    return;
  }
  const snapshot = parseGenerationSnapshot(row.input_snapshot);
  if (!snapshot || !snapshotMatchesJob(snapshot, job.inputHash)) {
    if (!job.lockedBy) return;
    await failGenerationJob(deps.query, {
      jobId: job.id,
      sessionId: job.sessionId,
      errorCode: snapshot ? "input_mismatch" : "input_unavailable",
      stageTimings: job.stageTimings,
      owner: job.lockedBy,
    });
    return;
  }
  const stopLease = startLease(deps, job.id);
  try {
    const generate = deps.generate ?? ((input) => runFrozenGeneration({
      deps: input.deps,
      sessionId: input.job.sessionId,
      requestId: input.job.clientRequestId,
      snapshot: input.snapshot,
      job: input.job,
    }));
    const outcome = await generate({ job, snapshot, deps });
    if (!outcome.ok) await settleFailure(deps.query, deps, job, outcomeCode(outcome));
  } catch (error) {
    console.error("generation worker failed", error instanceof Error ? error.name : "unknown");
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "pipeline_failed";
    await settleFailure(deps.query, deps, job, code);
  } finally {
    stopLease();
  }
}

export async function runGenerationOnce(deps: WorkerDeps): Promise<boolean> {
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const client = await deps.connect();
  let claimed: Record<string, unknown> | null = null;
  try {
    await client.query("BEGIN");
    const attached = await client.query(WORKER_ATTACH_SQL);
    const saved = attached.rows[0];
    if (saved) {
      const job = mapJob(saved);
      if (job && saved.saved_recommendation_id) {
        await completeGenerationJob((sql, params) => client.query(sql, params), {
          jobId: job.id,
          sessionId: job.sessionId,
          recommendationId: String(saved.saved_recommendation_id),
          stageTimings: job.stageTimings,
        });
      }
      await client.query("COMMIT");
      return true;
    }
    await client.query(WORKER_EXHAUST_SQL, [MAX_GENERATION_ATTEMPTS]);
    const selected = await client.query(WORKER_CLAIM_SQL, [MAX_GENERATION_ATTEMPTS]);
    if (!selected.rows[0]) {
      await client.query("COMMIT");
      return false;
    }
    const locked = await client.query(WORKER_LOCK_SQL, [String(selected.rows[0].id), workerId]);
    claimed = locked.rows[0] ?? null;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!claimed) return false;
  await executeClaimed(claimed, { ...deps, workerId });
  return true;
}

export function startGenerationWorker(deps: WorkerDeps): () => Promise<void> {
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        const worked = await runGenerationOnce(deps);
        if (abort.signal.aborted) break;
        if (!worked) await sleep(deps.idleMs ?? 1000, abort.signal);
      } catch (error) {
        console.error("generation worker stopped a cycle", error instanceof Error ? error.name : "unknown");
        if (abort.signal.aborted) break;
        await sleep(deps.idleMs ?? 1000, abort.signal);
      }
    }
  })();
  return async () => {
    abort.abort();
    await loop;
  };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
