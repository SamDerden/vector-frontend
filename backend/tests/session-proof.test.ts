import assert from "node:assert/strict";
import test from "node:test";

import {
  issueSessionProof,
  ownsAnonymousSession,
  sessionProofCookieName,
  sessionProofEnforced,
  verifySessionProof,
} from "../lib/session-proof.ts";
import { interpretSessionRow } from "../lib/session-lifetime.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const env = { SESSION_PROOF_SECRET: "s".repeat(32) } as NodeJS.ProcessEnv;

test("a valid proof matches only its own session", () => {
  const proof = issueSessionProof(SESSION, env);
  assert.equal(verifySessionProof(SESSION, proof, env), true);
  assert.equal(ownsAnonymousSession(SESSION, proof, env), true);
  assert.equal(verifySessionProof(OTHER, proof, env), false);
  assert.equal(sessionProofCookieName(SESSION).includes(SESSION.replace(/-/g, "")), true);
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
  assert.equal(verifySessionProof(SESSION, `${version}.${nonce}.${mac.slice(0, -1)}b`, env), false);
});

test("proof enforcement stays off unless the explicit flag is true", () => {
  assert.equal(sessionProofEnforced({} as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ SESSION_PROOF_ENFORCED: "false" } as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ SESSION_PROOF_ENFORCED: "true" } as NodeJS.ProcessEnv), true);
});

test("legacy rows without an expiry flag stay usable", () => {
  assert.equal(interpretSessionRow(1, { id: SESSION } as { expired?: unknown }), "ok");
  assert.equal(interpretSessionRow(1, { expired: false }), "ok");
  assert.equal(interpretSessionRow(1, { expired: true }), "expired");
  assert.equal(interpretSessionRow(0, undefined), "missing");
});

test("a short signing secret fails closed", () => {
  assert.throws(() => issueSessionProof(SESSION, { SESSION_PROOF_SECRET: "short" } as NodeJS.ProcessEnv));
});
