import { NextRequest, NextResponse } from "next/server";

import {
  saveClarificationAnswers,
  validateClarificationAnswers,
} from "@/lib/clarification";
import { isMissingSchemaError, pool, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { diagnosticSchema } from "@/lib/schemas";
import { readSessionId } from "@/lib/session";

export const runtime = "nodejs";

const requestBodySchema = diagnosticSchema.omit({
  sessionId: true,
});

export async function POST(request: NextRequest) {
  try {
    const header = readSessionId(request);
    if ("error" in header) {
      return header.error;
    }

    const parsed = requestBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return handleError(parsed.error);
    }

    const { answers, clarificationAnswers } = parsed.data;
    const validSessionId = header.sessionId;

    if (clarificationAnswers) {
      const clarificationErrors = validateClarificationAnswers(clarificationAnswers);
      if (clarificationErrors.length > 0) {
        return jsonError("Invalid clarification answers", 422, clarificationErrors);
      }
    }

    const session = await query("SELECT id FROM sessions WHERE id = $1", [
      validSessionId,
    ]);

    if (session.rowCount === 0) {
      return jsonError("Session not found. Select a track first.", 404);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO diagnostics (session_id, submitted_at)
         VALUES ($1, now())
         RETURNING id`,
        [validSessionId]
      );

      const diagnosticId = result.rows[0].id as string;

      for (const item of answers) {
        await client.query(
          `INSERT INTO diagnostic_answers
           (diagnostic_id, question_id, answer)
           VALUES ($1, $2, $3::jsonb)`,
          [diagnosticId, item.questionId, JSON.stringify(item.answer)]
        );
      }

      let clarificationId: string | null = null;
      if (clarificationAnswers) {
        clarificationId = await saveClarificationAnswers(client, {
          sessionId: validSessionId,
          diagnosticId,
          answers: clarificationAnswers,
        });
      }

      await client.query("COMMIT");

      return NextResponse.json(
        {
          diagnosticId,
          savedAnswers: answers.length,
          clarificationId,
          savedClarificationAnswers: clarificationAnswers?.length ?? 0,
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
    if (isMissingSchemaError(error)) {
      return jsonError(
        "Database schema is outdated. Run npm run db:migrate",
        503
      );
    }

    return handleError(error);
  }
}
