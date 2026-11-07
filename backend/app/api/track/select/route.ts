import { NextRequest, NextResponse } from "next/server";

import { query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { readSessionId } from "@/lib/session";
import { executeTrackSelect } from "@/lib/track-select";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const header = readSessionId(request);
    if ("error" in header) {
      return header.error;
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return jsonError("Request body must be valid JSON");
      }
      throw error;
    }

    const outcome = await executeTrackSelect({
      sessionId: header.sessionId,
      body: rawBody,
      query,
    });
    if (!outcome.ok) {
      return jsonError(outcome.error, outcome.status, outcome.details);
    }

    return NextResponse.json(outcome.body, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
