import { NextRequest } from "next/server";
import { z } from "zod";

import { query } from "./db";
import { jsonError } from "./http";
import { ownsAnonymousSession, sessionProofCookieName } from "./session-proof";

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

export function sessionProofEnforced(): boolean {
  return process.env.SESSION_PROOF_ENFORCED === "true";
}

export function authorizeSessionOwnership(request: NextRequest, sessionId: string) {
  if (!sessionProofEnforced()) return null;
  const proof = request.cookies.get(sessionProofCookieName(sessionId))?.value;
  if (!ownsAnonymousSession(sessionId, proof)) {
    return jsonError("Session ownership verification required", 403);
  }
  return null;
}

export async function requireExistingSession(request: NextRequest) {
  const header = readSessionId(request);
  if ("error" in header) {
    return header;
  }

  const denied = authorizeSessionOwnership(request, header.sessionId);
  if (denied) return { error: denied };

  const session = await query("SELECT id, expires_at <= now() AS expired FROM sessions WHERE id = $1", [
    header.sessionId,
  ]);

  if (session.rowCount === 0) {
    return { error: jsonError("Session not found", 404) };
  }

  if (session.rows[0]?.expired === true) {
    return { error: jsonError("Session expired. Start a new session.", 410) };
  }
  return { sessionId: header.sessionId };
}
