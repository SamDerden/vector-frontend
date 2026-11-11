import { NextRequest, NextResponse } from "next/server";

import { pool, query } from "@/lib/db";
import { handleError, jsonError } from "@/lib/http";
import { authorizeSessionOwnership, readSessionId, sessionProofEnforced } from "@/lib/session";
import { issueSessionProof, sessionProofCookieName, sessionProofCookieOptions } from "@/lib/session-proof";
import { executeTrackSelect } from "@/lib/track-select";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const header = readSessionId(request);
    if ("error" in header) return header.error;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) return jsonError("Request body must be valid JSON");
      throw error;
    }

    // Legacy mode remains unchanged until the protected rollout is explicitly enabled.
    if (!sessionProofEnforced()) {
      const outcome = await executeTrackSelect({ sessionId: header.sessionId, body: rawBody, query });
      if (!outcome.ok) return jsonError(outcome.error, outcome.status, outcome.details);
      return NextResponse.json(outcome.body, { status: 200 });
    }

    // Fail closed if the deployment has no signing secret.
    const proof = issueSessionProof(header.sessionId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize first-time claims of the same UUID across app instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [header.sessionId]);
      const existing = await client.query("SELECT id FROM sessions WHERE id = $1", [header.sessionId]);
      if (existing.rowCount) {
        const denied = authorizeSessionOwnership(request, header.sessionId);
        if (denied) {
          await client.query("ROLLBACK");
          return denied;
        }
      }

      const outcome = await executeTrackSelect({
        sessionId: header.sessionId,
        body: rawBody,
        query: (sql, params) => client.query(sql, params),
      });
      if (!outcome.ok) {
        await client.query("ROLLBACK");
        return jsonError(outcome.error, outcome.status, outcome.details);
      }
      await client.query("COMMIT");
      const response = NextResponse.json(outcome.body, { status: 200 });
      if (!existing.rowCount) {
        response.cookies.set(
          sessionProofCookieName(header.sessionId),
          proof,
          sessionProofCookieOptions(process.env.NODE_ENV === "production")
        );
      }
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return handleError(error);
  }
}
