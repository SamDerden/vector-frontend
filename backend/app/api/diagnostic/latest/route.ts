import { NextRequest, NextResponse } from "next/server";

import { isMissingSchemaError, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }

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

    if (diagnostic.rowCount === 0) {
      return jsonError("Diagnostic not found for this session", 404);
    }

    const row = diagnostic.rows[0];
    let clarificationRow: {
      id: string;
      submitted_at: string;
      answers: unknown;
    } | null = null;

    try {
      const clarification = await query(
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
      if (clarification.rows[0]) {
        clarificationRow = clarification.rows[0] as {
          id: string;
          submitted_at: string;
          answers: unknown;
        };
      }
    } catch (error) {
      if (!isMissingSchemaError(error)) {
        throw error;
      }
    }

    return NextResponse.json({
      diagnosticId: row.id,
      submittedAt: row.submitted_at,
      answers: row.answers,
      clarification: clarificationRow
        ? {
            clarificationId: clarificationRow.id,
            submittedAt: clarificationRow.submitted_at,
            answers: clarificationRow.answers,
          }
        : null,
    });
  } catch (error) {
    return handleError(error);
  }
}
