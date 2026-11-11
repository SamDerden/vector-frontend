import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import type { NextRequest } from "next/server";

register(new URL("./security-hooks.mjs", import.meta.url), import.meta.url);
const { authorizeSessionOwnership } = await import("../lib/session.ts");
import { issueSessionProof, sessionProofCookieName } from "../lib/session-proof.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-only-secret-at-least-thirty-two-bytes-long";

function requestWithProof(proof: string | null): NextRequest {
  return {
    cookies: { get: (name: string) => name === sessionProofCookieName(ID) && proof ? { value: proof } : undefined },
  } as unknown as NextRequest;
}

test("protected mode rejects a known UUID without its ownership cookie", () => {
  const oldFlag = process.env.SESSION_PROOF_ENFORCED;
  const oldSecret = process.env.SESSION_PROOF_SECRET;
  try {
    process.env.SESSION_PROOF_ENFORCED = "true";
    process.env.SESSION_PROOF_SECRET = SECRET;
    const request = requestWithProof(null);
    assert.equal(authorizeSessionOwnership(request, ID)?.status, 403);
    const wrong = requestWithProof(issueSessionProof(OTHER));
    assert.equal(authorizeSessionOwnership(wrong, ID)?.status, 403);
    const own = requestWithProof(issueSessionProof(ID));
    assert.equal(authorizeSessionOwnership(own, ID), null);
  } finally {
    if (oldFlag === undefined) delete process.env.SESSION_PROOF_ENFORCED;
    else process.env.SESSION_PROOF_ENFORCED = oldFlag;
    if (oldSecret === undefined) delete process.env.SESSION_PROOF_SECRET;
    else process.env.SESSION_PROOF_SECRET = oldSecret;
  }
});
