import assert from "node:assert/strict";
import { test } from "node:test";

import { savedRecommendationBody, sessionRecommendationBody } from "../lib/recommendation-view.ts";
import {
  executeGenerate,
  type DbQuery,
  type DbQueryResult,
  type GenerateDeps,
} from "../lib/sofi-generate.ts";
import type { SofiModuleResult } from "../lib/sofi-adapter.ts";
import type { SofiPipelineInput } from "../lib/sofi-pipeline.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const WELDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENERGY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOURNALIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SAFETY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REC_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TRIAL_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const COLLEGE_ID = "99999999-9999-4999-8999-999999999999";
const UNIVERSITY_ID = "88888888-8888-4888-8888-888888888888";

const professions = [
  { id: WELDER_ID, title: "Сварщик", graph_profession_id: null },
  { id: ENERGY_ID, title: "Инженер-энергетик", graph_profession_id: "prof_004" },
  { id: JOURNALIST_ID, title: "Журналист / Медиа-специалист", graph_profession_id: "prof_029" },
  { id: SAFETY_ID, title: "Специалист по охране труда", graph_profession_id: "prof_030" },
];

type SessionFixture = {
  grade: number | null;
  municipality?: string | null;
  diagnostic?: Array<Record<string, unknown>>;
  clarifications?: Array<Record<string, unknown>>;
};

function result(rows: Array<Record<string, unknown>>): DbQueryResult {
  return { rowCount: rows.length, rows };
}

function createHarness(sessions: Record<string, SessionFixture>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const inserts: unknown[][] = [];
  let pipelineCalls = 0;
  let pipelineInput: SofiPipelineInput | null = null;

  const query: DbQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    const sessionId = String(params[0] ?? "");
    const session = sessions[sessionId];
    if (sql.includes("FROM diagnostics")) {
      if (!session?.diagnostic) return result([]);
      return result([{ id: `diagnostic-${sessionId}`, answers: session.diagnostic }]);
    }
    if (sql.includes("FROM clarifications")) {
      return result(session?.clarifications?.length
        ? [{ answers: session.clarifications }]
        : []);
    }
    if (sql.includes("FROM profiles")) {
      if (!session) return result([]);
      return result([{
        school_grade: session.grade,
        municipality: session.municipality ?? null,
      }]);
    }
    if (sql.includes("FROM professions")) {
      return result(professions);
    }
    if (sql.includes("FROM education_programs")) {
      return result([
        {
          id: COLLEGE_ID,
          title: "Колледж энергетики",
          institution: "Колледж",
          level: "СПО",
          url: "https://example.test/college",
          organization_name: "Колледж",
          organization_type: "spo",
          website: null,
          contact_email: null,
          profession_ids: [JOURNALIST_ID, ENERGY_ID],
        },
        {
          id: UNIVERSITY_ID,
          title: "Прикладная информатика",
          institution: "УрФУ",
          level: "бакалавриат",
          url: "https://example.test/university",
          organization_name: "УрФУ",
          organization_type: "вуз",
          website: null,
          contact_email: null,
          profession_ids: [JOURNALIST_ID, ENERGY_ID],
        },
      ]);
    }
    if (sql.includes("FROM professional_trials")) {
      const requested = Array.isArray(params[0]) ? params[0].map(String) : [];
      if (!requested.includes(TRIAL_ID)) return result([]);
      return result([{
        id: TRIAL_ID,
        title: "Пробное занятие по алгоритмам",
        description: "Короткое занятие без образовательной программы.",
        format: "очно",
        duration_minutes: 60,
        municipality: "Екатеринбург",
        cost: "бесплатно",
        profession_id: ENERGY_ID,
        source_url: null,
      }]);
    }
    if (sql.includes("INSERT INTO recommendations")) {
      inserts.push(params);
      return result([{ id: REC_ID, created_at: "2026-11-05T00:00:00.000Z" }]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const deps: GenerateDeps = {
    query,
    connect: async () => ({
      query,
      release() {},
    }),
    pipeline: async (pipeline) => {
      pipelineCalls += 1;
      pipelineInput = pipeline;
      return pipelineResult(pipeline);
    },
    modelName: "test-model",
  };

  return {
    deps,
    calls,
    inserts,
    pipelineCalls: () => pipelineCalls,
    pipelineInput: () => pipelineInput,
  };
}

function pipelineResult(input: SofiPipelineInput): SofiModuleResult {
  const grade = input.prepared.student.school_grade;
  const tier = input.prepared.tier;
  if (grade === 3) {
    return {
      status: "ok",
      summary: "Есть интерес к энергии.",
      next_step: "Расскажи взрослому, что понравилось.",
      warnings: [],
      interest_tags: [{
        industry_id: "ind_008",
        tag: "Энергетика",
        why: "Тебе интересны машины и свет.",
      }],
      hypotheses: [{
        profession_id: "prof_004",
        name: "Инженер-энергетик",
        why: "Эту профессию младшим не показываем.",
        match_strength: "strong",
      }],
      generation: {
        mode: "llm",
        tier,
        promptVersion: "nav-1-4@1.0.2",
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 1,
      },
    };
  }
  if (grade === 8 && input.prepared.student.municipality === "fallback") {
    return {
      status: "fallback",
      summary: "Подсказки собраны по каталогу.",
      next_step: "Выбери один вариант.",
      warnings: ["llm_fallback_used"],
      hypotheses: [{
        profession_id: "prof_004",
        name: "Чужое имя модели",
        why: "Связано с ответами.",
        match_strength: "moderate",
        trial_ids: ["trial_011"],
      }],
      generation: {
        mode: "retrieval_only",
        tier,
        promptVersion: null,
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 0,
      },
    };
  }
  if (grade === 7) {
    return {
      status: "ok",
      summary: "Интерес к алгоритмам.",
      next_step: "Посмотри профессию.",
      interest_tags: [{
        industry_id: "ind_003",
        tag: "Информатика",
        why: "Нравятся алгоритмы.",
      }],
      hypotheses: [{
        profession_id: "prof_004",
        name: "Чужое имя модели",
        why: "Интерес к технике.",
        match_strength: "strong",
        trial_ids: [TRIAL_ID],
      }],
      generation: {
        mode: "llm",
        tier,
        promptVersion: "nav-5-8@1.0.2",
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 1,
      },
    };
  }
  if (grade === 10 || grade === 11) {
    return {
      status: "ok",
      summary: "Есть два направления.",
      next_step: "Сравни варианты.",
      hypotheses: [
        {
          profession_id: "prof_029",
          name: "Не журналист",
          why: "Интерес к текстам.",
          match_strength: "strong",
          trial_ids: ["trial_001"],
          program_ids: ["prog_001"],
        },
        {
          profession_id: "prof_030",
          name: "Охрана труда",
          why: "Интерес к безопасности.",
          match_strength: "weak",
        },
        {
          profession_id: "prof_404",
          name: "Неизвестная профессия",
          why: "Этого ключа нет.",
          match_strength: "moderate",
        },
      ],
      generation: {
        mode: "llm",
        tier,
        promptVersion: "nav-9-11@1.0.2",
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 1,
      },
    };
  }
  return {
    status: "ok",
    summary: "Технический интерес.",
    next_step: "Посмотри профессию.",
    hypotheses: [{
      profession_id: "prof_004",
      name: "Чужое имя модели",
      why: "Интерес к энергии.",
      match_strength: "strong",
      trial_ids: ["trial_004"],
    }],
    generation: {
      mode: "llm",
      tier,
      promptVersion: "nav-5-8@1.0.2",
      catalogVersion: "hybrid_v2",
      configVersion: "age-1",
      attempts: 1,
    },
  };
}

test("missing school grade returns 409 and does not call the model", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: null,
      diagnostic: [{ questionId: "q1", answer: "техника", questionnaire: "Билет" }],
    },
  });

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 409);
    assert.equal(outcome.error.includes("9"), false);
  }
  assert.equal(harness.pipelineCalls(), 0);
  assert.equal(harness.inserts.length, 0);
});

test("grades 1-4 save interest tags without professions or colleges", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: 3,
      diagnostic: [{ questionId: "q1", answer: false, questionnaire: null }],
    },
  });

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.status, "generated");
  assert.deepEqual(outcome.body.hypotheses, []);
  assert.deepEqual(outcome.body.interestTags, [{
    industry_id: "ind_008",
    tag: "Энергетика",
    why: "Тебе интересны машины и свет.",
  }]);
  const options = outcome.body.nextStepOptions as Array<{ available: boolean; title?: string }>;
  assert.equal(options.length, 3);
  assert.equal(options.every((item) => item.available === false), true);
  assert.equal(options.some((item) => item.title), false);
  assert.equal(
    harness.calls.some((call) => call.sql.includes("FROM education_programs")),
    false
  );
  const payload = JSON.parse(String(harness.inserts[0][11]));
  assert.deepEqual(payload.hypotheses, []);
  assert.equal(JSON.stringify(payload).includes(WELDER_ID), false);
  assert.equal(JSON.stringify(payload).includes(ENERGY_ID), false);
  assert.equal(harness.inserts[0][3], harness.inserts[0][3]);
  assert.deepEqual(harness.inserts[0][3], []);
  assert.equal(harness.pipelineInput()?.prepared.normalizedAnswers[0]?.original, false);
});

test("grades 5-8 map prof_004 to the energy engineer and keep original answers", async () => {
  const custom = { values: ["data", "Другое"], customText: "свой текст" };
  const harness = createHarness({
    [SESSION_A]: {
      grade: 8,
      municipality: "Первоуральск",
      diagnostic: [{
        questionId: "bilet_q1",
        answer: ["техника"],
        questionnaire: "Билет в будущее (8 класс)",
      }],
      clarifications: [{ questionId: "agent_q_values", answer: custom }],
    },
  });

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: { sessionId: SESSION_B },
    deps: harness.deps,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const hypotheses = outcome.body.hypotheses as Array<Record<string, unknown>>;
  assert.equal(hypotheses.length, 1);
  assert.equal(hypotheses[0].professionId, ENERGY_ID);
  assert.equal(hypotheses[0].title, "Инженер-энергетик");
  assert.equal(hypotheses[0].fitScore, 3);
  assert.equal(hypotheses[0].scoreKind, "relative_ranking");
  assert.equal(hypotheses[0].professionId === WELDER_ID, false);
  assert.equal(outcome.body.sessionId, SESSION_A);
  assert.equal(
    harness.calls
      .filter((call) => call.params.length > 0)
      .every((call) => call.params[0] === SESSION_A),
    true
  );
  assert.equal(harness.inserts[0][0], SESSION_A);
  assert.deepEqual(harness.inserts[0][3], []);
  const prepared = harness.pipelineInput()?.prepared;
  assert.equal(prepared?.student.school_grade, 8);
  assert.equal(prepared?.student.municipality, "Первоуральск");
  assert.deepEqual(
    prepared?.normalizedAnswers.find((item) => item.questionId === "agent_q_values")?.original,
    custom
  );
});

test("grades 9-11 keep unmapped hypotheses in payload and ignore string trial ids", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: 11,
      diagnostic: [{ questionId: "q1", answer: "тексты", questionnaire: "Билет в будущее (11 класс)" }],
    },
  });

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const hypotheses = outcome.body.hypotheses as Array<{ professionId: string; fitScore: number }>;
  assert.deepEqual(hypotheses.map((item) => item.professionId), [JOURNALIST_ID, SAFETY_ID]);
  assert.deepEqual(hypotheses.map((item) => item.fitScore), [3, 1]);
  const payload = JSON.parse(String(harness.inserts[0][11]));
  assert.equal(payload.hypotheses[2].mapping, "unmapped");
  assert.equal(payload.hypotheses[2].catalogProfessionId, "prof_404");
  assert.equal(payload.hypotheses[2].professionId, null);
  assert.deepEqual(payload.hypotheses[0].trialIds, ["trial_001"]);
  assert.deepEqual(harness.inserts[0][3], []);
  assert.equal(String(harness.inserts[0][10]), "llm");
  const options = outcome.body.nextStepOptions as Array<{ type: string; available: boolean }>;
  assert.equal(options.find((item) => item.type === "college")?.available, true);
});

test("grades 3, 7 and 10 save and reread age-specific nextStepOptions", async () => {
  const cases = [
    {
      grade: 3,
      expectProgramsQuery: false,
      expectHypotheses: 0,
      expectTrials: 0,
      collegeAvailable: false,
    },
    {
      grade: 7,
      expectProgramsQuery: false,
      expectHypotheses: 1,
      expectTrials: 1,
      collegeAvailable: false,
    },
    {
      grade: 10,
      expectProgramsQuery: true,
      expectHypotheses: 2,
      expectTrials: 0,
      collegeAvailable: true,
    },
  ];

  for (const item of cases) {
    const harness = createHarness({
      [SESSION_A]: {
        grade: item.grade,
        diagnostic: [{
          questionId: "q1",
          answer: "алгоритмы",
          questionnaire: `Билет в будущее (${item.grade} класс)`,
        }],
      },
    });
    const outcome = await executeGenerate({
      sessionId: SESSION_A,
      body: {},
      deps: harness.deps,
    });
    assert.equal(outcome.ok, true, `grade ${item.grade}`);
    if (!outcome.ok) continue;
    assert.equal(outcome.status, 201);
    assert.equal(outcome.body.status, "generated");
    assert.equal(
      (outcome.body.hypotheses as unknown[]).length,
      item.expectHypotheses,
      `grade ${item.grade} hypotheses`
    );
    assert.equal(
      (outcome.body.trials as unknown[]).length,
      item.expectTrials,
      `grade ${item.grade} trials`
    );
    if (item.grade === 7) {
      const hypotheses = outcome.body.hypotheses as Array<{ professionId: string }>;
      assert.equal(hypotheses[0]?.professionId, ENERGY_ID);
      assert.deepEqual(outcome.body.interestTags, [{
        industry_id: "ind_003",
        tag: "Информатика",
        why: "Нравятся алгоритмы.",
      }]);
      assert.equal((outcome.body.trials as Array<{ id: string }>)[0]?.id, TRIAL_ID);
      assert.deepEqual(harness.inserts[0][3], [TRIAL_ID]);
    }
    const options = outcome.body.nextStepOptions as Array<{
      type: string;
      available: boolean;
      title?: string;
      id?: string;
    }>;
    assert.deepEqual(options.map((option) => option.type), ["club", "college", "online_course"]);
    const college = options.find((option) => option.type === "college");
    assert.equal(college?.available, item.collegeAvailable, `grade ${item.grade} college`);
    if (!item.collegeAvailable) {
      assert.equal(options.every((option) => option.available === false && !option.title && !option.id), true);
      assert.equal(JSON.stringify(options).includes("Колледж"), false);
      assert.equal(JSON.stringify(options).includes("УрФУ"), false);
    }
    assert.equal(
      harness.calls.some((call) => call.sql.includes("FROM education_programs")),
      item.expectProgramsQuery,
      `grade ${item.grade} programs query`
    );
    const savedPathways = JSON.parse(String(harness.inserts[0][5]));
    assert.deepEqual(savedPathways, options);
    const saved = savedRecommendationBody({
      id: REC_ID,
      session_id: SESSION_A,
      summary: harness.inserts[0][1],
      hypotheses: JSON.parse(String(harness.inserts[0][2])),
      next_step: harness.inserts[0][4],
      pathways: savedPathways,
      model_name: harness.inserts[0][6],
      created_at: "2026-11-05T00:00:00.000Z",
      prompt_version: harness.inserts[0][7],
      catalog_version: harness.inserts[0][8],
      config_version: harness.inserts[0][9],
      generation_mode: harness.inserts[0][10],
      ai_payload: JSON.parse(String(harness.inserts[0][11])),
    }, outcome.body.trials as unknown[]);
    const session = sessionRecommendationBody({
      id: REC_ID,
      session_id: SESSION_A,
      summary: harness.inserts[0][1],
      hypotheses: JSON.parse(String(harness.inserts[0][2])),
      next_step: harness.inserts[0][4],
      pathways: savedPathways,
      model_name: harness.inserts[0][6],
      created_at: "2026-11-05T00:00:00.000Z",
      prompt_version: harness.inserts[0][7],
      catalog_version: harness.inserts[0][8],
      config_version: harness.inserts[0][9],
      generation_mode: harness.inserts[0][10],
      ai_payload: JSON.parse(String(harness.inserts[0][11])),
    });
    assert.deepEqual(saved.nextStepOptions, options);
    assert.deepEqual(session.nextStepOptions, options);
    assert.equal(saved.status, "saved");
  }
});

test("fallback is stored as retrieval_only", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: 8,
      municipality: "fallback",
      diagnostic: [{ questionId: "q1", answer: "техника", questionnaire: "Билет" }],
    },
  });

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const generation = outcome.body.generation as { mode: string };
  assert.equal(generation.mode, "retrieval_only");
  assert.equal(harness.inserts[0][6], "retrieval_only");
  assert.equal(harness.inserts[0][10], "retrieval_only");
  assert.equal(outcome.body.model, "retrieval_only");
});

test("sessions do not read each other's diagnostics", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: 8,
      diagnostic: [{ questionId: "q-a", answer: "энергия", questionnaire: "Билет A" }],
    },
    [SESSION_B]: {
      grade: 11,
      diagnostic: [{ questionId: "q-b", answer: "тексты", questionnaire: "Билет B" }],
    },
  });

  const first = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });
  const firstCalls = harness.calls.length;
  const second = await executeGenerate({
    sessionId: SESSION_B,
    body: { sessionId: SESSION_A },
    deps: harness.deps,
  });

  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const firstIds = (first.body.hypotheses as Array<{ professionId: string }>).map((item) => item.professionId);
  const secondIds = (second.body.hypotheses as Array<{ professionId: string }>).map((item) => item.professionId);
  assert.deepEqual(firstIds, [ENERGY_ID]);
  assert.deepEqual(secondIds, [JOURNALIST_ID, SAFETY_ID]);
  const firstSessionCalls = harness.calls.slice(0, firstCalls);
  const secondSessionCalls = harness.calls.slice(firstCalls);
  assert.equal(
    firstSessionCalls
      .filter((call) => call.params.length > 0)
      .every((call) => call.params[0] === SESSION_A),
    true
  );
  assert.equal(
    secondSessionCalls
      .filter((call) => call.params.length > 0)
      .every((call) => call.params[0] === SESSION_B),
    true
  );
});

function savedBodyFromInsert(params: unknown[]) {
  return savedRecommendationBody({
    id: REC_ID,
    session_id: params[0],
    summary: params[1],
    hypotheses: JSON.parse(String(params[2])),
    next_step: params[4],
    pathways: JSON.parse(String(params[5])),
    model_name: params[6],
    created_at: "2026-11-05T00:00:00.000Z",
    prompt_version: params[7],
    catalog_version: params[8],
    config_version: params[9],
    generation_mode: params[10],
    ai_payload: JSON.parse(String(params[11])),
  }, []);
}

test("POST and GET return the same Sofi fields", async () => {
  const fields = ["warnings", "disclaimer", "interestTags", "generation", "unmappedHypotheses"] as const;
  const cases = [
    {
      name: "retrieval_only",
      session: {
        grade: 8,
        municipality: "fallback",
        diagnostic: [{ questionId: "q1", answer: "техника", questionnaire: "Билет" }],
      },
    },
    {
      name: "grades 1-4",
      session: {
        grade: 3,
        diagnostic: [{ questionId: "q1", answer: false, questionnaire: null }],
      },
    },
    {
      name: "unmapped",
      session: {
        grade: 11,
        diagnostic: [{ questionId: "q1", answer: "тексты", questionnaire: "Билет в будущее (11 класс)" }],
      },
    },
  ];

  for (const item of cases) {
    const harness = createHarness({ [SESSION_A]: item.session });
    const outcome = await executeGenerate({
      sessionId: SESSION_A,
      body: {},
      deps: harness.deps,
    });
    assert.equal(outcome.ok, true, item.name);
    if (!outcome.ok) continue;
    const saved = savedBodyFromInsert(harness.inserts[0]);
    const postedJson = JSON.parse(JSON.stringify(outcome.body));
    const savedJson = JSON.parse(JSON.stringify(saved));
    for (const field of fields) {
      assert.deepEqual(outcome.body[field], saved[field], `${item.name}:${field}`);
      assert.deepEqual(postedJson[field], savedJson[field], `${item.name}:${field}:http-json`);
    }
    assert.equal(outcome.body.status, "generated");
    assert.equal(saved.status, "saved");
  }

  const retrieval = createHarness({
    [SESSION_A]: cases[0].session,
  });
  const retrievalOutcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: retrieval.deps,
  });
  assert.equal(retrievalOutcome.ok, true);
  if (retrievalOutcome.ok) {
    assert.deepEqual(retrievalOutcome.body.warnings, ["llm_fallback_used"]);
    assert.equal(retrievalOutcome.body.disclaimer, null);
    assert.equal((retrievalOutcome.body.generation as { mode: string }).mode, "retrieval_only");
  }

  const junior = createHarness({ [SESSION_A]: cases[1].session });
  const juniorOutcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: junior.deps,
  });
  assert.equal(juniorOutcome.ok, true);
  if (juniorOutcome.ok) {
    assert.deepEqual(juniorOutcome.body.warnings, []);
    assert.deepEqual(juniorOutcome.body.hypotheses, []);
    assert.equal((juniorOutcome.body.interestTags as unknown[]).length, 1);
  }
});

test("pipeline failure returns 502 and does not save a recommendation", async () => {
  const harness = createHarness({
    [SESSION_A]: {
      grade: 9,
      diagnostic: [{ questionId: "q1", answer: "техника", questionnaire: "Билет" }],
    },
  });
  harness.deps.pipeline = async () => {
    throw new Error("model timeout");
  };

  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: harness.deps,
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.status, 502);
  assert.equal(harness.inserts.length, 0);
});
