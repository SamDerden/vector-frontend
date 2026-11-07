import { NextRequest, NextResponse } from "next/server";

import {
  saveClarificationAnswers,
  validateClarificationAnswers,
} from "@/lib/clarification";
import { pool, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { clarificationSubmitSchema } from "@/lib/schemas";
import { requireExistingSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await requireExistingSession(request);
    if ("error" in session) {
      return session.error;
    }

    const parsed = clarificationSubmitSchema.safeParse(await request.json());
    if (!parsed.success) {
      return handleError(parsed.error);
    }

    const errors = validateClarificationAnswers(parsed.data.answers);
    if (errors.length > 0) {
      return jsonError("Invalid clarification answers", 422, errors);
    }

    const latestDiagnostic = await query(
      `SELECT id
       FROM diagnostics
       WHERE session_id = $1
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [session.sessionId]
    );

    if (latestDiagnostic.rowCount === 0) {
      return jsonError(
        "Complete the diagnostic before submitting clarification answers",
        409
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const clarificationId = await saveClarificationAnswers(client, {
        sessionId: session.sessionId,
        diagnosticId: latestDiagnostic.rows[0]?.id ?? null,
        answers: parsed.data.answers,
      });
      await client.query("COMMIT");

      return NextResponse.json(
        {
          clarificationId,
          savedAnswers: parsed.data.answers.length,
          status: "submitted",
        },
        { status: 201 }
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError("Request body must be valid JSON");
    }
    return handleError(error);
  }
}
