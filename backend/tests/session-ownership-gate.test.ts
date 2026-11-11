import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { authorizeSessionOwnership } from "../lib/session.ts";
import { issueSessionProof, sessionProofCookieName } from "../lib/session-proof.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "test-only-secret-at-least-thirty-two-bytes-long";

test("protected mode rejects a known UUID without its ownership cookie", () => {
  const oldFlag = process.env.SESSION_PROOF_ENFORCED;
  const oldSecret = process.env.SESSION_PROOF_SECRET;
  try {
    process.env.SESSION_PROOF_ENFORCED = "true";
    process.env.SESSION_PROOF_SECRET = SECRET;
    const request = new NextRequest("https://example.test/api/session", { headers: { "X-Session-ID": ID } });
    assert.equal(authorizeSessionOwnership(request, ID)?.status, 403);
    const wrong = new NextRequest("https://example.test/api/session", {
      headers: { cookie: `${sessionProofCookieName(ID)}=${issueSessionProof(OTHER)}` },
    });
    assert.equal(authorizeSessionOwnership(wrong, ID)?.status, 403);
    const own = new NextRequest("https://example.test/api/session", {
      headers: { cookie: `${sessionProofCookieName(ID)}=${issueSessionProof(ID)}` },
    });
    assert.equal(authorizeSessionOwnership(own, ID), null);
  } finally {
    if (oldFlag === undefined) delete process.env.SESSION_PROOF_ENFORCED;
    else process.env.SESSION_PROOF_ENFORCED = oldFlag;
    if (oldSecret === undefined) delete process.env.SESSION_PROOF_SECRET;
    else process.env.SESSION_PROOF_SECRET = oldSecret;
  }
});
