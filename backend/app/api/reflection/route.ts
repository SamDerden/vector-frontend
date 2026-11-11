import { NextRequest, NextResponse } from "next/server";

import { abuseGuard } from "@/lib/abuse-guard";
import { isMissingSchemaError, query } from "@/lib/db";
import { handleError, jsonError, rateLimited } from "@/lib/http";
import {
  REFLECTION_READ_LEGACY_SQL,
  REFLECTION_READ_SQL,
  presentReflection,
  reflectionBodySchema,
  reflectionWrite,
  resolveJourneyStep,
} from "@/lib/reflection-plan";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readReflections(sessionId: string) {
  try {
    return await query(REFLECTION_READ_SQL, [sessionId]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    return query(REFLECTION_READ_LEGACY_SQL, [sessionId]);
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }
    const limited = await abuseGuard.guardRead(session.sessionId);
    if (!limited.ok) return rateLimited(limited.retryAfterMs);

    const result = await readReflections(session.sessionId);
    return NextResponse.json({
      data: result.rows.map((row) => presentReflection(row)),
      count: result.rowCount,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }
    const limited = await abuseGuard.guardWrite(session.sessionId);
    if (!limited.ok) return rateLimited(limited.retryAfterMs);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) return jsonError("Request body must be valid JSON");
      throw error;
    }
    const parsed = reflectionBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return handleError(parsed.error);
    }

    const { recommendationId } = parsed.data;
    const validSessionId = session.sessionId;
    if (recommendationId) {
      const recommendation = await query(
        `SELECT id
         FROM recommendations
         WHERE id = $1 AND session_id = $2`,
        [recommendationId, validSessionId]
      );
      if (recommendation.rowCount === 0) {
        return jsonError("Recommendation not found for this session", 404);
      }
    }

    const step = resolveJourneyStep(parsed.data);
    let schoolGrade: number | null = null;
    if (step !== undefined) {
      const profile = await query(
        `SELECT school_grade FROM profiles WHERE session_id = $1`,
        [validSessionId]
      );
      const grade = profile.rows[0]?.school_grade;
      schoolGrade = typeof grade === "number" ? grade : null;
    }
    const planned = reflectionWrite({
      sessionId: validSessionId,
      body: parsed.data,
      schoolGrade,
    });
    if (!planned.ok) return jsonError(planned.error, planned.status);

    let result;
    try {
      result = await query(planned.sql, planned.params);
    } catch (error) {
      if (isMissingSchemaError(error) && planned.journeyStep !== undefined) {
        return jsonError("Database schema is outdated. Run npm run db:migrate", 503);
      }
      throw error;
    }

    return NextResponse.json(
      {
        ...result.rows[0],
        status: "saved",
        ...(planned.journeyStep === undefined
          ? {}
          : { journeyStep: planned.journeyStep, ageTier: planned.ageTier, stage: planned.journeyStep === 4 ? "final" : "progress" }),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError("Request body must be valid JSON");
    }
    return handleError(error);
  }
}
