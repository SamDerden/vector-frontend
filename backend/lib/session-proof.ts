import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server-only session ownership proof for anonymous demo visitors.
 * The public UUID is a locator, never an authorization credential.
 * Do not put this proof in localStorage, URLs, logs, or JSON responses.
 *
 * The proof is deliberately not wired to API routes until issuance,
 * cookie scope, migration and end-to-end tests are implemented.
 */
const PROOF_VERSION = "v1";
const PROOF_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function secretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.SESSION_PROOF_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_PROOF_SECRET must be configured with at least 32 UTF-8 bytes");
  }
  return Buffer.from(secret, "utf8");
}

function signature(sessionId: string, nonce: string, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update(`${PROOF_VERSION}:session:${sessionId.toLowerCase()}:${nonce}`)
    .digest();
}

export function issueSessionProof(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!UUID.test(sessionId)) throw new Error("Invalid session UUID");
  const key = secretKey(env);
  const nonce = randomBytes(PROOF_BYTES).toString("base64url");
  return `${PROOF_VERSION}.${nonce}.${signature(sessionId, nonce, key).toString("base64url")}`;
}

export function verifySessionProof(
  sessionId: string,
  proof: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!UUID.test(sessionId) || typeof proof !== "string") return false;
  const parts = proof.split(".");
  if (parts.length !== 3 || parts[0] !== PROOF_VERSION) return false;
  const [, nonce, mac] = parts;
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return false;
  const key = secretKey(env);
  const received = Buffer.from(mac, "base64url");
  const expected = signature(sessionId, nonce, key);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * A distinct HttpOnly cookie per session supports switching between demo pupils
 * without overwriting another pupil's proof. Never trust a client-supplied UUID
 * alone as evidence of ownership.
 */
export function sessionProofCookieName(sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error("Invalid session UUID");
  return `vector_session_proof_${sessionId.toLowerCase().replace(/-/g, "")}`;
}

export function sessionProofCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true as const,
    secure: isProduction,
    sameSite: "strict" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

/**
 * Authorization check for the eventual authenticated session gate.
 * Fail closed on a missing or invalid proof; never silently fall back to UUID.
 */
export function ownsAnonymousSession(
  sessionId: string,
  cookieValue: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return verifySessionProof(sessionId, cookieValue, env);
}
