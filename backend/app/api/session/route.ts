import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import {
  fetchLatestRecommendation,
  sessionRecommendationBody,
} from "@/lib/recommendation-view";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }

    const sessionRow = await query(
      `SELECT id, track_type, created_at, updated_at
       FROM sessions
       WHERE id = $1`,
      [session.sessionId]
    );

    const profile = await query(
      `SELECT school_grade, municipality, preferences
       FROM profiles
       WHERE session_id = $1`,
      [session.sessionId]
    );

    const diagnostic = await query(
      `SELECT
         d.id,
         d.submitted_at,
         json_agg(
           json_build_object(
             'questionId', da.question_id,
             'answer', da.answer
           )
           ORDER BY da.created_at
         ) AS answers
       FROM diagnostics d
       JOIN diagnostic_answers da
         ON da.diagnostic_id = d.id
       WHERE d.session_id = $1
       GROUP BY d.id, d.submitted_at
       ORDER BY d.submitted_at DESC
       LIMIT 1`,
      [session.sessionId]
    );

    let clarification = null;
    try {
      const clarificationResult = await query(
        `SELECT
           c.id,
           c.submitted_at,
           json_agg(
             json_build_object(
               'questionId', ca.question_id,
               'answer', ca.answer
             )
             ORDER BY ca.created_at
           ) AS answers
         FROM clarifications c
         JOIN clarification_answers ca
           ON ca.clarification_id = c.id
         WHERE c.session_id = $1
         GROUP BY c.id, c.submitted_at
         ORDER BY c.submitted_at DESC
         LIMIT 1`,
        [session.sessionId]
      );
      clarification = clarificationResult.rows[0] ?? null;
    } catch (error) {
      if (!isMissingSchemaError(error)) {
        throw error;
      }
    }

    const recommendationRow = await fetchLatestRecommendation(
      query,
      session.sessionId
    );

    const reflections = await query(
      `SELECT id, recommendation_id, rating, comment, created_at
       FROM reflections
       WHERE session_id = $1
       ORDER BY created_at DESC`,
      [session.sessionId]
    );

    const diagnosticRow = diagnostic.rows[0] ?? null;
    const profileRow = profile.rows[0] ?? null;

    return NextResponse.json({
      sessionId: sessionRow.rows[0].id,
      trackType: sessionRow.rows[0].track_type,
      createdAt: sessionRow.rows[0].created_at,
      updatedAt: sessionRow.rows[0].updated_at,
      profile: profileRow
        ? {
            schoolGrade: profileRow.school_grade,
            municipality: profileRow.municipality,
          }
        : null,
      diagnostic: diagnosticRow
        ? {
            diagnosticId: diagnosticRow.id,
            submittedAt: diagnosticRow.submitted_at,
            answers: diagnosticRow.answers,
            clarification: clarification
              ? {
                  clarificationId: clarification.id,
                  submittedAt: clarification.submitted_at,
                  answers: clarification.answers,
                }
              : null,
          }
        : null,
      recommendation: recommendationRow
        ? sessionRecommendationBody(recommendationRow)
        : null,
      reflections: reflections.rows,
    });
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
