import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getFromCache, setCache, setCacheClock, shouldCachePipelineResult } from "../lib/ai/cache.ts";
import { isTransportFailure } from "../lib/generation-jobs.ts";
import { sessionProofEnforced } from "../lib/session-proof.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("ownership stays off outside production unless the explicit flag is set", () => {
  assert.equal(sessionProofEnforced({ NODE_ENV: "development" } as NodeJS.ProcessEnv), false);
  assert.equal(sessionProofEnforced({ NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(sessionProofEnforced({ SESSION_PROOF_ENFORCED: "true", NODE_ENV: "development" } as NodeJS.ProcessEnv), true);
});

test("AI cache expires after one hour and skips degraded retrieval", () => {
  let now = 1_000;
  setCacheClock(() => now);
  setCache("semantic-hit", { ok: true });
  assert.deepEqual(getFromCache("semantic-hit"), { ok: true });
  now += 60 * 60 * 1000;
  assert.equal(getFromCache("semantic-hit"), null);
  setCacheClock(() => Date.now());
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "semantic" }), true);
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "lexical" }), false);
  assert.equal(shouldCachePipelineResult({ generationMode: "retrieval_only", retrievalMode: "semantic" }), false);
});

test("transport abort stays a retryable pipeline failure signal", () => {
  assert.equal(isTransportFailure({ code: "ECONNABORTED" }), true);
  assert.equal(isTransportFailure({ code: "ECONNRESET" }), true);
  assert.equal(isTransportFailure(new Error("model said no")), false);
});

test("migration numbers keep main 010 and move the unapplied reflection step to 011", () => {
  const budgets = source("../migrations/010_request_budgets.sql");
  const reflection = source("../migrations/011_reflection_journey.sql");
  const lifetime = source("../migrations/009_session_lifetime.sql");
  assert.match(budgets, /CREATE TABLE IF NOT EXISTS request_budgets/);
  assert.doesNotMatch(budgets, /\b(drop|delete|truncate)\b/i);
  assert.match(reflection, /journey_step/);
  assert.doesNotMatch(reflection, /\b(drop table|delete from)\b/i);
  assert.match(lifetime, /ADD COLUMN IF NOT EXISTS expires_at/);
  assert.doesNotMatch(lifetime, /\b(delete\s+from|drop\s+table)\b/i);
  assert.throws(() => source("../migrations/010_reflection_journey.sql"));
});

test("generate and track use database budgets without stacking the in-process guard", () => {
  const generate = source("../app/api/recommendations/generate/route.ts");
  const track = source("../app/api/track/select/route.ts");
  const diagnostic = source("../app/api/diagnostic/submit/route.ts");
  assert.match(generate, /consumeLimit\(query, "generate:global", 60, 30\)/);
  assert.match(generate, /consumeLimit\(query, "generate:session:"/);
  assert.match(generate, /pipeline: limitedPipeline/);
  assert.doesNotMatch(generate, /abuseGuard/);
  assert.match(track, /consumeLimit\(query, "sessions:global", 60, 120\)/);
  assert.match(track, /sessionProofEnforced\(\)/);
  assert.doesNotMatch(track, /abuseGuard/);
  assert.match(diagnostic, /requireExistingSession\(request\)/);
  assert.match(diagnostic, /Session not found\. Select a track first\./);
  assert.match(diagnostic, /abuseGuard\.guardWrite/);
});

test("failed retrieval is labeled lexical and only a semantic LLM result is cached", () => {
  const pipeline = source("../lib/sofi-pipeline.ts");
  assert.match(pipeline, /mode: "lexical"/);
  assert.match(pipeline, /if \(mode === "llm" && retrieval\.mode === "semantic"\) \{\s*setCache\(cacheKey, result\)/);
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "lexical" }), false);
});
