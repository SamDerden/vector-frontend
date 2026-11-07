import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, pool, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { executeGenerate } from "@/lib/sofi-generate";
import { runSofiPipeline } from "@/lib/sofi-pipeline";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
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

    const outcome = await executeGenerate({
      sessionId: session.sessionId,
      body: rawBody,
      deps: {
        query,
        connect: () => pool.connect(),
        pipeline: runSofiPipeline,
        modelName: process.env.LLM_MODEL ?? process.env.AI_MODEL ?? "sofi",
      },
    });
    if (!outcome.ok) {
      return jsonError(outcome.error, outcome.status, outcome.details);
    }

    return NextResponse.json(outcome.body, { status: 201 });
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
