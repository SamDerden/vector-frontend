import { NextRequest, NextResponse } from "next/server";

import { query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import {
  fetchLatestRecommendation,
  savedRecommendationBody,
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

    const row = await fetchLatestRecommendation(query, session.sessionId);
    if (!row) {
      return jsonError("Recommendation not found for this session", 404);
    }
    const trialIds = (row.trial_ids as string[]) ?? [];
    const trials =
      trialIds.length === 0
        ? []
        : (
            await query(
              `SELECT
                 id,
                 title,
                 LEFT(COALESCE(description, ''), 220) AS description,
                 format,
                 duration_minutes,
                 municipality,
                 cost,
                 profession_id,
                 source_url
               FROM professional_trials
               WHERE id = ANY($1::uuid[])`,
              [trialIds]
            )
          ).rows;

    return NextResponse.json(savedRecommendationBody(row, trials));
  } catch (error) {
    return handleError(error);
  }
}
