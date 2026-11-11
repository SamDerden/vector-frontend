import { NextRequest } from "next/server";
import { z } from "zod";

import { isMissingSchemaError, query } from "./db";
import { jsonError } from "./http";
import { interpretSessionRow, SESSION_EXPIRY_SQL, SESSION_ID_SQL } from "./session-lifetime.ts";
import { ownsAnonymousSession, sessionProofCookieName, sessionProofEnforced } from "./session-proof.ts";

export { sessionProofEnforced };

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

export function authorizeSessionOwnership(request: NextRequest, sessionId: string) {
  if (!sessionProofEnforced()) return null;
  const proof = request.cookies.get(sessionProofCookieName(sessionId))?.value;
  if (!ownsAnonymousSession(sessionId, proof)) {
    return jsonError("Session ownership verification required", 403);
  }
  return null;
}

export async function loadLiveSession(sessionId: string) {
  let session;
  try {
    session = await query(SESSION_EXPIRY_SQL, [sessionId]);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    session = await query(SESSION_ID_SQL, [sessionId]);
  }
  const state = interpretSessionRow(session.rowCount ?? 0, session.rows[0]);
  if (state === "missing") return { error: jsonError("Session not found", 404) };
  if (state === "expired") return { error: jsonError("Session expired. Start a new session.", 410) };
  return { sessionId };
}

export async function requireExistingSession(request: NextRequest) {
  const header = readSessionId(request);
  if ("error" in header) {
    return header;
  }

  const denied = authorizeSessionOwnership(request, header.sessionId);
  if (denied) return { error: denied };

  return loadLiveSession(header.sessionId);
}
