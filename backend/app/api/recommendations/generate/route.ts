import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, pool, query } from "@/lib/db";
import { generationBudgetApplies, parseIdempotencyKey, readGenerationJob } from "@/lib/generation-jobs";
import { handleError, jsonError } from "@/lib/http";
import { countMetric, logEvent } from "@/lib/observe";
import { executeGenerate } from "@/lib/sofi-generate";
import { limitedPipeline } from "@/lib/limited-pipeline";
import { consumeLimit } from "@/lib/request-limits";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const idempotency = parseIdempotencyKey(request.headers.get("idempotency-key"));
    if (!idempotency.ok) {
      return jsonError("Idempotency-Key must be a UUID", 400);
    }

    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }
    let spendBudget = true;
    if (idempotency.key) {
      const existingJob = await readGenerationJob(query, session.sessionId, idempotency.key);
      spendBudget = generationBudgetApplies(existingJob?.status);
    }
    if (spendBudget) {
      await consumeLimit(query, "generate:global", 60, 30);
      await consumeLimit(query, "generate:session:" + session.sessionId, 60, 5);
    }
    let rawBody: unknown = {};
    try {
      const rawText = await request.text();
      rawBody = rawText.trim() ? JSON.parse(rawText) : {};
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonError("Request body must be valid JSON");
      }
      throw error;
    }

    const started = Date.now();
    const outcome = await executeGenerate({
      sessionId: session.sessionId,
      body: rawBody,
      idempotencyKey: idempotency.key,
      deps: {
        query,
        connect: () => pool.connect(),
        pipeline: limitedPipeline,
        modelName: process.env.LLM_MODEL ?? process.env.AI_MODEL ?? "sofi",
      },
    });
    if (!outcome.ok) {
      countMetric(`generation_${outcome.status}`);
      logEvent("generation_result", {
        requestId: idempotency.key,
        httpStatus: outcome.status,
        errorCode: outcome.details && typeof outcome.details === "object" && "errorCode" in outcome.details
          ? (outcome.details as { errorCode?: unknown }).errorCode
          : undefined,
        durationMs: Date.now() - started,
      });
      const response = jsonError(outcome.error, outcome.status, outcome.details);
      if (outcome.status === 429) response.headers.set("Retry-After", "60");
      return response;
    }

    logEvent("generation_result", {
      requestId: idempotency.key,
      httpStatus: outcome.status,
      durationMs: Date.now() - started,
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return jsonError(
        "Database schema is outdated. Run npm run db:migrate",
        503
      );
    }
    return handleError(error);
  }
}
