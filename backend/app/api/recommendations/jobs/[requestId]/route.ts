import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, query } from "@/lib/db";
import { parseIdempotencyKey, publicErrorCode, publicJobAccess, READ_JOB_SQL, recoverInactiveGenerationJob, type GenerationJob } from "@/lib/generation-jobs";
import { LINKED_RECOMMENDATION_SQL } from "@/lib/sofi-generate";
import { handleError, jsonError } from "@/lib/http";
import { savedRecommendationBody } from "@/lib/recommendation-view";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ requestId: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trialsFrom(hypotheses: unknown): unknown[] {
  if (!Array.isArray(hypotheses)) return [];
  const seen = new Set<string>();
  const trials: unknown[] = [];
  for (const item of hypotheses) {
    const list = isRecord(item) && Array.isArray(item.trials) ? item.trials : [];
    for (const trial of list) {
      const id = isRecord(trial) ? String(trial.id ?? "") : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      trials.push(trial);
    }
  }
  return trials;
}

function completedBody(row: Record<string, unknown>, job: GenerationJob) {
  const saved = savedRecommendationBody(row, trialsFrom(row.hypotheses));
  const payload = isRecord(row.ai_payload) ? row.ai_payload : {};
  return {
    ...saved,
    status: "generated",
    activities: Array.isArray(payload.activities) ? payload.activities : [],
    requestId: job.clientRequestId,
    jobStatus: "completed",
    replayed: true,
    stageTimings: job.stageTimings,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) return session.error;
    const { requestId: rawRequestId } = await context.params;
    const parsed = parseIdempotencyKey(rawRequestId);
    if (!parsed.ok || !parsed.key) return jsonError("Generation job not found", 404);

    const found = await query(READ_JOB_SQL, [session.sessionId, parsed.key]);
    const row = found.rows[0];
    if (!row || (row.status !== "pending" && row.status !== "running" && row.status !== "completed" && row.status !== "failed")) {
      return jsonError("Generation job not found", 404);
    }
    const job: GenerationJob = {
      id: String(row.id),
      sessionId: String(row.session_id),
      clientRequestId: String(row.client_request_id),
      inputHash: String(row.input_hash),
      status: row.status,
      recommendationId: row.recommendation_id == null ? null : String(row.recommendation_id),
      errorCode: typeof row.error_code === "string" ? row.error_code : null,
      stageTimings: isRecord(row.stage_timings) ? row.stage_timings : {},
      attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
      lockedBy: null,
      lockedUntil: null,
    };

    let recommendationId = job.recommendationId;
    if (!recommendationId) {
      const linked = await query(LINKED_RECOMMENDATION_SQL, [job.id, session.sessionId]);
      recommendationId = linked.rows[0]?.id == null ? null : String(linked.rows[0].id);
    }
    const access = publicJobAccess(job.status, recommendationId);
    if (access === "pending") {
      return NextResponse.json({
        requestId: job.clientRequestId,
        jobStatus: job.status,
        status: "in_progress",
        retryAfterMs: 2000,
        stageTimings: job.stageTimings,
      }, { status: 202 });
    }
    if (access === "failed") {
      return jsonError("AI service request failed", 502, {
        requestId: job.clientRequestId,
        jobStatus: "failed",
        errorCode: publicErrorCode(job.errorCode ?? "pipeline_failed"),
      });
    }
    if (access !== "saved" || !recommendationId) {
      return jsonError("AI service request failed", 502, {
        requestId: job.clientRequestId,
        jobStatus: "failed",
        errorCode: "incomplete_result",
      });
    }
    const saved = await query(
      `SELECT id, session_id, summary, hypotheses, trial_ids, next_step, pathways, model_name, created_at,
              ai_payload, generation_mode, prompt_version, catalog_version, config_version
       FROM recommendations
       WHERE id = $1 AND session_id = $2`,
      [recommendationId, session.sessionId]
    );
    if (!saved.rows[0]) return jsonError("Generation job not found", 404);
    if (job.status !== "completed") {
      await recoverInactiveGenerationJob(query, {
        jobId: job.id,
        sessionId: session.sessionId,
        recommendationId,
        stageTimings: job.stageTimings,
      }).catch((error: unknown) => {
        console.error("generation job completion was not recorded", error instanceof Error ? error.name : "unknown");
      });
    }
    return NextResponse.json(completedBody(saved.rows[0], { ...job, status: "completed", recommendationId }));
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return jsonError("Database schema is outdated. Run npm run db:migrate", 503);
    }
    return handleError(error);
  }
}
