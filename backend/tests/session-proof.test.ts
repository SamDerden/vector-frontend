import assert from "node:assert/strict";
import test from "node:test";
import {
  issueSessionProof,
  ownsAnonymousSession,
  sessionProofCookieName,
  sessionProofCookieOptions,
  verifySessionProof,
} from "../lib/session-proof.ts";

const env = { SESSION_PROOF_SECRET: "test-only-secret-at-least-thirty-two-bytes-long" } as NodeJS.ProcessEnv;
const own = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

test("session UUID alone never proves ownership", () => {
  assert.equal(ownsAnonymousSession(own, null, env), false);
  assert.equal(ownsAnonymousSession(own, own, env), false);
});

test("valid proof is scoped to exactly one session", () => {
  const proof = issueSessionProof(own, env);
  assert.equal(verifySessionProof(own, proof, env), true);
  assert.equal(verifySessionProof(other, proof, env), false);
  assert.equal(verifySessionProof(own, proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A"), env), false);
});

test("each demo session has an independent HttpOnly cookie", () => {
  assert.notEqual(sessionProofCookieName(own), sessionProofCookieName(other));
  const cookie = sessionProofCookieOptions(true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "strict");
});

test("issuance fails closed without a configured server secret", () => {
  assert.throws(() => issueSessionProof(own, {} as NodeJS.ProcessEnv), /SESSION_PROOF_SECRET/);
});
