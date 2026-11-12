import assert from "node:assert/strict";
import test from "node:test";
import { savedRecommendationBody, sessionRecommendationBody, sofiPublicFields } from "../lib/recommendation-view.ts";
import { shouldCachePipelineResult } from "../lib/ai/cache.ts";

const base = {
  id: "rec-test",
  session_id: "session-test",
  summary: "Подходящие направления",
  hypotheses: [{ professionId: "prof_001", trials: [{ trial_id: "trial_001" }] }],
  trial_ids: [],
  next_step: "Попробовать профессиональную пробу",
  pathways: [],
  model_name: "fallback",
  created_at: "2026-11-12T00:00:00Z",
  prompt_version: null,
  catalog_version: "catalog-v3",
  config_version: "config-v1",
};

test("retrieval_only remains explicit in saved and session API views", () => {
  const row = {
    ...base,
    generation_mode: "retrieval_only",
    ai_payload: {
      generation: { mode: "retrieval_only", tier: "9-11", attempts: 2 },
      warnings: ["llm_unavailable"],
      hypotheses: base.hypotheses,
    },
  };
  const saved = savedRecommendationBody(row, [{ id: "trial-uuid", title: "Проба" }]);
  const session = sessionRecommendationBody(row);
  assert.equal((saved.generation as { mode: string }).mode, "retrieval_only");
  assert.equal((session.generation as { mode: string }).mode, "retrieval_only");
  assert.deepEqual(saved.hypotheses, base.hypotheses);
  assert.equal(saved.trials.length, 1);
  assert.deepEqual(saved.warnings, ["llm_unavailable"]);
});

test("legacy payload without generation object still reports DB generation_mode", () => {
  const fields = sofiPublicFields({
    ...base,
    generation_mode: "retrieval_only",
    ai_payload: {},
  });
  assert.equal((fields.generation as { mode: string }).mode, "retrieval_only");
});

test("saved LLM result retains llm label rather than fallback label", () => {
  const row = {
    ...base,
    generation_mode: "llm",
    ai_payload: { generation: { mode: "llm", attempts: 1 } },
  };
  assert.equal((savedRecommendationBody(row, []).generation as { mode: string }).mode, "llm");
});

test("fallback and lexical retrieval results are not cached as healthy semantic LLM responses", () => {
  assert.equal(shouldCachePipelineResult({ generationMode: "retrieval_only", retrievalMode: "semantic" }), false);
  assert.equal(shouldCachePipelineResult({ generationMode: "retrieval_only", retrievalMode: "lexical" }), false);
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "lexical" }), false);
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "semantic" }), true);
});
