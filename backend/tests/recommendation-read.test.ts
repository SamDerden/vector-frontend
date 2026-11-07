import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LATEST_RECOMMENDATION_SQL,
  fetchLatestRecommendation,
  savedRecommendationBody,
  sessionRecommendationBody,
  type DbQuery,
} from "../lib/recommendation-view.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const ENERGY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const legacyKeys = [
  "recommendationId",
  "summary",
  "hypotheses",
  "nextStep",
  "nextStepOptions",
  "model",
  "createdAt",
];

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    session_id: SESSION_A,
    summary: "Старое резюме",
    hypotheses: [{
      professionId: ENERGY_ID,
      title: "Инженер-энергетик",
      reason: "Интерес к технике.",
      fitScore: 3,
      scoreKind: "relative_ranking",
    }],
    trial_ids: [],
    next_step: "Посмотри профессию.",
    pathways: [{ type: "college", available: false, note: "Нет колледжа." }],
    model_name: "old-model",
    created_at: "2026-11-01T00:00:00.000Z",
    ai_payload: {},
    generation_mode: null,
    prompt_version: null,
    catalog_version: null,
    config_version: null,
    ...overrides,
  };
}

const generation = {
  mode: "llm",
  tier: "9-11",
  promptVersion: "nav-9-11@1.0.2",
  catalogVersion: "hybrid_v2",
  configVersion: "age-1",
  attempts: 1,
};

test("an old recommendation keeps the previous fields", () => {
  const row = baseRow();
  const saved = savedRecommendationBody(row, []);
  const session = sessionRecommendationBody(row);

  assert.deepEqual(Object.keys(saved).sort(), ["sessionId", "status", "trials", ...legacyKeys].sort());
  assert.equal(saved.status, "saved");
  assert.equal(saved.hypotheses, row.hypotheses);
  assert.equal(saved.nextStepOptions, row.pathways);
  assert.deepEqual(Object.keys(session).sort(), [...legacyKeys].sort());
  assert.equal(session.summary, "Старое резюме");
  assert.equal("interestTags" in saved, false);
  assert.equal("generation" in session, false);
  assert.equal("unmappedHypotheses" in saved, false);
});

test("an LLM recommendation returns Sofi fields from ai_payload", () => {
  const unmapped = {
    catalogProfessionId: "prof_404",
    professionId: null,
    mapping: "unmapped",
    title: "Неизвестная профессия",
    reason: "Этого ключа нет.",
    matchStrength: "moderate",
    fitScore: 2,
    scoreKind: "relative_ranking",
    evidenceRefs: ["A3"],
    trialIds: ["trial_001"],
    programIds: [],
    legacyCompatible: false,
  };
  const row = baseRow({
    model_name: "test-model",
    generation_mode: "llm",
    prompt_version: "nav-9-11@1.0.2",
    catalog_version: "hybrid_v2",
    config_version: "age-1",
    ai_payload: {
      disclaimer: "Это предварительная подсказка, а не диагностика.",
      warnings: ["coverage_gap"],
      interestTags: [],
      generation,
      hypotheses: [
        {
          catalogProfessionId: "prof_004",
          professionId: ENERGY_ID,
          mapping: "mapped",
          title: "Инженер-энергетик",
          reason: "Интерес к энергии.",
          matchStrength: "strong",
          fitScore: 3,
          scoreKind: "relative_ranking",
          evidenceRefs: [],
          trialIds: [],
          programIds: [],
          legacyCompatible: true,
        },
        unmapped,
      ],
    },
  });

  const saved = savedRecommendationBody(row, []);
  const session = sessionRecommendationBody(row);
  assert.equal(saved.hypotheses, row.hypotheses);
  assert.deepEqual(saved.generation, generation);
  assert.deepEqual(saved.warnings, ["coverage_gap"]);
  assert.equal(saved.disclaimer, "Это предварительная подсказка, а не диагностика.");
  assert.deepEqual(saved.unmappedHypotheses, [unmapped]);
  assert.deepEqual(session.unmappedHypotheses, [unmapped]);
  assert.deepEqual(session.generation, saved.generation);
});

test("retrieval_only keeps its generation mode", () => {
  const retrievalGeneration = {
    mode: "retrieval_only",
    tier: "5-8",
    promptVersion: null,
    catalogVersion: "hybrid_v2",
    configVersion: "age-1",
    attempts: 0,
  };
  const row = baseRow({
    model_name: "retrieval_only",
    generation_mode: "retrieval_only",
    prompt_version: null,
    catalog_version: "hybrid_v2",
    config_version: "age-1",
    ai_payload: {
      warnings: ["llm_fallback_used"],
      disclaimer: "Это предварительная подсказка, а не диагностика.",
      interestTags: [],
      generation: retrievalGeneration,
      hypotheses: [],
    },
  });

  const saved = savedRecommendationBody(row, []);
  assert.equal((saved.generation as { mode: string }).mode, "retrieval_only");
  assert.deepEqual(saved.warnings, ["llm_fallback_used"]);
  assert.equal(saved.model, "retrieval_only");
  assert.equal("unmappedHypotheses" in saved, false);
});

test("grades 1-4 return empty hypotheses and interest tags", () => {
  const interestTags = [{
    industry_id: "ind_008",
    tag: "Энергетика",
    why: "Тебе интересны машины и свет.",
    evidence_refs: ["A1"],
  }];
  const row = baseRow({
    hypotheses: [],
    pathways: [
      { type: "club", available: false, note: "Для 1–4 классов показываем направления интересов." },
      { type: "college", available: false, note: "Для 1–4 классов показываем направления интересов." },
      { type: "online_course", available: false, note: "Для 1–4 классов показываем направления интересов." },
    ],
    generation_mode: "llm",
    prompt_version: "nav-1-4@1.0.2",
    catalog_version: "hybrid_v2",
    config_version: "age-1",
    ai_payload: {
      warnings: [],
      disclaimer: "Это предварительная подсказка, а не диагностика.",
      interestTags,
      hypotheses: [],
      generation: {
        mode: "llm",
        tier: "1-4",
        promptVersion: "nav-1-4@1.0.2",
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 1,
      },
    },
  });

  const saved = savedRecommendationBody(row, []);
  const session = sessionRecommendationBody(row);
  assert.deepEqual(saved.hypotheses, []);
  assert.deepEqual(saved.interestTags, interestTags);
  assert.deepEqual(session.interestTags, interestTags);
  assert.equal(
    (saved.nextStepOptions as Array<{ available: boolean; title?: string }>)
      .every((item) => item.available === false && !item.title),
    true
  );
  assert.equal(JSON.stringify(saved).includes("Инженер-энергетик"), false);
});

test("missing recommendation is absent for the session", async () => {
  const seen: string[] = [];
  const query: DbQuery = async (sql, params = []) => {
    seen.push(String(params[0]));
    assert.equal(sql, LATEST_RECOMMENDATION_SQL);
    assert.match(sql, /WHERE session_id = \$1/);
    return { rowCount: 0, rows: [] };
  };

  const row = await fetchLatestRecommendation(query, SESSION_A);
  assert.equal(row, null);
  assert.deepEqual(seen, [SESSION_A]);
});

test("each session reads only its own recommendation", async () => {
  const rows = {
    [SESSION_A]: baseRow({ summary: "Сессия A", hypotheses: [] }),
    [SESSION_B]: baseRow({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      session_id: SESSION_B,
      summary: "Сессия B",
      generation_mode: "llm",
      prompt_version: "nav-9-11@1.0.2",
      catalog_version: "hybrid_v2",
      config_version: "age-1",
      ai_payload: {
        warnings: [],
        disclaimer: null,
        interestTags: [],
        generation,
        hypotheses: [],
      },
    }),
  };
  const query: DbQuery = async (sql, params = []) => {
    assert.equal(sql.includes("session_id = $1"), true);
    const sessionId = String(params[0]);
    return { rowCount: 1, rows: [rows[sessionId]] };
  };

  const first = await fetchLatestRecommendation(query, SESSION_A);
  const second = await fetchLatestRecommendation(query, SESSION_B);
  assert.equal(savedRecommendationBody(first!, []).summary, "Сессия A");
  assert.equal(sessionRecommendationBody(second!).summary, "Сессия B");
  assert.equal(savedRecommendationBody(first!, []).sessionId, SESSION_A);
  assert.equal("generation" in savedRecommendationBody(first!, []), false);
  assert.equal(
    (sessionRecommendationBody(second!).generation as { mode: string }).mode,
    "llm"
  );
});
