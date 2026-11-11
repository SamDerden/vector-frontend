import assert from "node:assert/strict";
import test from "node:test";

import {
  issueSessionProof,
  ownsAnonymousSession,
  sessionProofCookieName,
  sessionProofCookieOptions,
  sessionProofEnforced,
  verifySessionProof,
} from "../lib/session-proof.ts";
import { interpretSessionRow } from "../lib/session-lifetime.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const env = { SESSION_PROOF_SECRET: "test-only-secret-at-least-thirty-two-bytes-long" } as NodeJS.ProcessEnv;

test("session UUID alone never proves ownership", () => {
  assert.equal(ownsAnonymousSession(SESSION, null, env), false);
  assert.equal(ownsAnonymousSession(SESSION, SESSION, env), false);
});

test("a valid proof matches only its own session", () => {
  const proof = issueSessionProof(SESSION, env);
  assert.equal(verifySessionProof(SESSION, proof, env), true);
  assert.equal(ownsAnonymousSession(SESSION, proof, env), true);
  assert.equal(verifySessionProof(OTHER, proof, env), false);
  assert.equal(sessionProofCookieName(SESSION).includes(SESSION.replace(/-/g, "")), true);
  assert.notEqual(sessionProofCookieName(SESSION), sessionProofCookieName(OTHER));
  assert.equal(verifySessionProof(SESSION, proof.slice(0, 4) + (proof[4] === "A" ? "B" : "A") + proof.slice(5), env), false);
});

test("missing, forged and stale proofs are rejected", () => {
  const proof = issueSessionProof(SESSION, env);
  assert.equal(verifySessionProof(SESSION, undefined, env), false);
  assert.equal(verifySessionProof(SESSION, "", env), false);
  const [version, nonce, mac] = proof.split(".");
  const forged = `${version}.${nonce}.${"a".repeat(mac.length)}`;
  assert.equal(forged.length, proof.length);
  assert.equal(verifySessionProof(SESSION, forged, env), false);
  assert.equal(verifySessionProof(SESSION, `v0.${nonce}.${mac}`, env), false);
  const flipped = mac[0] === "A" ? "B" : "A";
  assert.equal(verifySessionProof(SESSION, `${version}.${nonce}.${flipped}${mac.slice(1)}`, env), false);
});

test("proof enforcement follows production or the explicit flag", () => {
  assert.equal(sessionProofEnforced({} as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ NODE_ENV: "test" } as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ SESSION_PROOF_ENFORCED: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ SESSION_PROOF_ENFORCED: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(sessionProofEnforced({ NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
});

test("legacy rows without an expiry flag stay usable", () => {
  assert.equal(interpretSessionRow(1, { id: SESSION } as { expired?: unknown }), "ok");
  assert.equal(interpretSessionRow(1, { expired: false }), "ok");
  assert.equal(interpretSessionRow(1, { expired: true }), "expired");
  assert.equal(interpretSessionRow(0, undefined), "missing");
});

test("a short signing secret fails closed", () => {
  assert.throws(() => issueSessionProof(SESSION, { SESSION_PROOF_SECRET: "short" } as NodeJS.ProcessEnv), /SESSION_PROOF_SECRET/);
  assert.throws(() => issueSessionProof(SESSION, {} as NodeJS.ProcessEnv), /SESSION_PROOF_SECRET/);
});

test("each demo session has an independent HttpOnly cookie", () => {
  const cookie = sessionProofCookieOptions(true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "strict");
});

test("demo proof is a browser-session cookie; own proof persists for seven days", () => {
  const demo = sessionProofCookieOptions(true, "demo");
  const ownCookie = sessionProofCookieOptions(true, "own");
  assert.equal("maxAge" in demo, false);
  assert.equal(ownCookie.maxAge, 7 * 24 * 60 * 60);
  assert.equal(demo.httpOnly, true);
  assert.equal(demo.secure, true);
});
