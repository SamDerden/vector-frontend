import assert from "node:assert/strict";
import test from "node:test";
import {
  KEYED_RECOMMENDATION_INSERT_SQL,
  LINKED_RECOMMENDATION_SQL,
} from "../lib/sofi-generate.ts";
import { LATEST_RECOMMENDATION_SQL, fetchLatestRecommendation, savedRecommendationBody } from "../lib/recommendation-view.ts";

const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";
const recommendationId = "33333333-3333-4333-8333-333333333333";
const trialId = "44444444-4444-4444-8444-444444444444";

test("keyed insert links recommendation to job and persists mode, payload and trial UUIDs", () => {
  assert.match(KEYED_RECOMMENDATION_INSERT_SQL, /generation_job_id/);
  assert.match(KEYED_RECOMMENDATION_INSERT_SQL, /generation_mode/);
  assert.match(KEYED_RECOMMENDATION_INSERT_SQL, /ai_payload/);
  assert.match(KEYED_RECOMMENDATION_INSERT_SQL, /trial_ids/);
  assert.match(KEYED_RECOMMENDATION_INSERT_SQL, /\$4::uuid\[\]/);
  assert.match(LINKED_RECOMMENDATION_SQL, /generation_job_id = \$1 AND session_id = \$2/);
});

test("read-back retains trial UUID, profession mapping and fallback provenance", async () => {
  const row = {
    id: recommendationId,
    session_id: sessionA,
    summary: "Рекомендация",
    hypotheses: [{ professionId: "55555555-5555-4555-8555-555555555555", catalogProfessionId: "prof_001", trials: [{ id: trialId }] }],
    trial_ids: [trialId],
    next_step: "Пройти пробу",
    pathways: [],
    model_name: "retrieval_only",
    generation_mode: "retrieval_only",
    ai_payload: { generation: { mode: "retrieval_only", tier: "9-11" }, warnings: ["llm_fallback_used"] },
    created_at: "2026-11-12T00:00:00Z",
  };
  const seen: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    assert.equal(sql, LATEST_RECOMMENDATION_SQL);
    seen.push(params);
    return { rowCount: 1, rows: [row] };
  };
  const stored = await fetchLatestRecommendation(query, sessionA);
  assert.deepEqual(seen, [[sessionA]]);
  const result = savedRecommendationBody(stored!, [{ id: trialId, title: "Проба" }]);
  assert.equal(result.sessionId, sessionA);
  assert.equal((result.generation as { mode: string }).mode, "retrieval_only");
  assert.equal((result.hypotheses as Array<{ catalogProfessionId: string }>)[0].catalogProfessionId, "prof_001");
  assert.equal(result.trials[0].id, trialId);
  assert.deepEqual(result.warnings, ["llm_fallback_used"]);
});

test("latest recommendation query requires session ownership", () => {
  assert.match(LATEST_RECOMMENDATION_SQL, /WHERE session_id = \$1/);
  assert.notEqual(sessionA, sessionB);
});
