import { NextRequest } from "next/server";
import { z } from "zod";

import { query } from "./db";
import { jsonError } from "./http";

export const sessionIdSchema = z.string().uuid();

export function readSessionId(request: NextRequest) {
  const sessionId = request.headers.get("X-Session-ID");

  if (!sessionId) {
    return { error: jsonError("X-Session-ID header is required", 401) };
  }

  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    return { error: jsonError("X-Session-ID must be a valid UUID", 400) };
  }

  return { sessionId: parsed.data };
}

export async function requireExistingSession(request: NextRequest) {
  const header = readSessionId(request);
  if ("error" in header) {
    return header;
  }

  const session = await query("SELECT id FROM sessions WHERE id = $1", [
    header.sessionId,
  ]);

  if (session.rowCount === 0) {
    return { error: jsonError("Session not found", 404) };
  }

  return { sessionId: header.sessionId };
}
