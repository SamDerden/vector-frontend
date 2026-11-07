import { NextRequest, NextResponse } from "next/server";

import { query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { reflectionSchema } from "@/lib/schemas";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = reflectionSchema.omit({ sessionId: true });

export async function GET(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }

    const result = await query(
      `SELECT id, recommendation_id, rating, comment, created_at
       FROM reflections
       WHERE session_id = $1
       ORDER BY created_at DESC`,
      [session.sessionId]
    );

    return NextResponse.json({
      data: result.rows,
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

    const parsed = bodySchema.safeParse(await request.json());

    if (!parsed.success) {
      return handleError(parsed.error);
    }

    const { recommendationId, rating, comment } = parsed.data;
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

    const result = await query(
      `INSERT INTO reflections
       (session_id, recommendation_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, created_at`,
      [
        validSessionId,
        recommendationId ?? null,
        rating,
        comment ?? null,
      ]
    );

    return NextResponse.json(
      {
        ...result.rows[0],
        status: "saved",
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
