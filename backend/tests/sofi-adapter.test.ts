import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MissingSchoolGradeError,
  adaptSofiResult,
  mapCatalogProfessionId,
  prepareSofiInput,
  tierForGrade,
} from "../lib/sofi-adapter.ts";

const ANALYST_ID = "ec5a249f-50a3-465d-ad12-c69c83b9180f";
const MECHANIC_ID = "6f9619ff-8b86-4011-a42d-00cf4fc964ff";
const WELDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENERGY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOURNALIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SAFETY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const professions = [
  { id: ANALYST_ID, graphProfessionId: "prof_001" },
  { id: MECHANIC_ID, graphProfessionId: "prof_002" },
];

test("tier follows age policy and does not invent grade 9", () => {
  assert.equal(tierForGrade(4), "1-4");
  assert.equal(tierForGrade(8), "5-8");
  assert.equal(tierForGrade(11), "9-11");

  const prepared = prepareSofiInput({
    profile: { schoolGrade: 8, municipality: "Екатеринбург" },
    diagnosticAnswers: [
      {
        questionId: "bilet_q1",
        answer: "техника",
        questionnaire: "Билет в будущее (8 класс)",
      },
    ],
  });

  assert.equal(prepared.tier, "5-8");
  assert.equal(prepared.student.school_grade, 8);
  assert.notEqual(prepared.student.school_grade, 9);
});

test("missing school grade is an explicit 409 and does not default to 9", () => {
  for (const schoolGrade of [null, undefined]) {
    assert.throws(
      () =>
        prepareSofiInput({
          profile: { schoolGrade },
          diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof MissingSchoolGradeError);
        assert.equal(error.httpStatus, 409);
        assert.equal(error.message.includes("9"), false);
        return true;
      }
    );
  }
});

test("clarification answers keep boolean, values, customText, lists and numbers", () => {
  const customText = "свой вариант про роботов";
  const prepared = prepareSofiInput({
    profile: { schoolGrade: 10, municipality: "" },
    diagnosticAnswers: [
      {
        questionId: "bilet_q1",
        answer: ["математика", "информатика"],
        questionnaire: "Билет в будущее (10 класс)",
      },
    ],
    clarificationAnswers: [
      { questionId: "agent_q_bool", answer: false },
      { questionId: "agent_q_text", answer: "в команде" },
      { questionId: "agent_q_number", answer: 2 },
      {
        questionId: "agent_q_values",
        answer: { values: ["data", "Другое"], customText },
      },
    ],
  });

  const byId = new Map(
    prepared.normalizedAnswers.map((item) => [item.questionId, item])
  );

  assert.deepEqual(byId.get("bilet_q1")?.selected, [
    "математика",
    "информатика",
  ]);
  assert.deepEqual(byId.get("bilet_q1")?.original, [
    "математика",
    "информатика",
  ]);

  assert.equal(byId.get("agent_q_bool")?.original, false);
  assert.deepEqual(byId.get("agent_q_bool")?.selected, ["false"]);
  assert.equal(byId.get("agent_q_bool")?.questionnaire, "agent_clarification");

  assert.deepEqual(byId.get("agent_q_text")?.selected, ["в команде"]);
  assert.equal(byId.get("agent_q_number")?.original, 2);
  assert.deepEqual(byId.get("agent_q_number")?.selected, ["2"]);

  const valuesAnswer = byId.get("agent_q_values");
  assert.deepEqual(valuesAnswer?.original, {
    values: ["data", "Другое"],
    customText,
  });
  assert.deepEqual(valuesAnswer?.selected, ["data", "Другое", customText]);

  const rawValues = prepared.rawAnswers.find(
    (item) => item.question_id === "agent_q_values"
  );
  assert.deepEqual(rawValues?.answer, ["data", "Другое", customText]);
  assert.equal(rawValues?.questionnaire, "agent_clarification");
});

test("catalog profession ids map to UUID and unknown ids stay unmapped", () => {
  assert.deepEqual(mapCatalogProfessionId("prof_001", professions), {
    status: "mapped",
    catalogProfessionId: "prof_001",
    professionId: ANALYST_ID,
  });
  assert.deepEqual(mapCatalogProfessionId("prof_999", professions), {
    status: "unmapped",
    catalogProfessionId: "prof_999",
    professionId: null,
  });
  assert.equal(
    mapCatalogProfessionId("prof_001", [
      ...professions,
      { id: MECHANIC_ID, graphProfessionId: "PROF_001" },
    ]).status,
    "ambiguous"
  );
});

test("prof_004 maps by graph id and never returns the welder uuid", () => {
  const rows = [
    {
      id: WELDER_ID,
      externalId: "prof_004",
      graphProfessionId: null,
    },
    {
      id: ENERGY_ID,
      externalId: "prof_008",
      graphProfessionId: "prof_004",
    },
  ];

  assert.deepEqual(mapCatalogProfessionId("prof_004", rows), {
    status: "mapped",
    catalogProfessionId: "prof_004",
    professionId: ENERGY_ID,
  });

  const adapted = adaptSofiResult(
    {
      hypotheses: [
        {
          profession_id: "prof_004",
          name: "Инженер-энергетик",
          why: "Интерес к энергии и технике.",
          match_strength: "strong",
        },
      ],
    },
    rows
  );

  assert.equal(adapted.hypotheses[0].professionId, ENERGY_ID);
  assert.equal(adapted.hypotheses[0].title, "Инженер-энергетик");
  assert.equal(adapted.hypotheses[0].fitScore, 3);
  assert.equal(adapted.hypotheses[0].scoreKind, "relative_ranking");
  assert.equal(
    adapted.hypotheses.some((item) => item.professionId === WELDER_ID),
    false
  );
  assert.equal(adapted.aiPayload.hypotheses[0].professionId, ENERGY_ID);
});

test("prof_029 and prof_030 map when only graph id is present", () => {
  const rows = [
    {
      id: JOURNALIST_ID,
      externalId: null,
      graphProfessionId: "prof_029",
    },
    {
      id: SAFETY_ID,
      externalId: null,
      graphProfessionId: "prof_030",
    },
    {
      id: WELDER_ID,
      externalId: "prof_029",
      graphProfessionId: null,
    },
  ];

  assert.equal(
    mapCatalogProfessionId("prof_029", rows).professionId,
    JOURNALIST_ID
  );
  assert.equal(
    mapCatalogProfessionId("prof_030", rows).professionId,
    SAFETY_ID
  );

  const adapted = adaptSofiResult(
    {
      hypotheses: [
        {
          profession_id: "prof_029",
          name: "Журналист / Медиа-специалист",
          why: "Интерес к текстам.",
          match_strength: "moderate",
        },
        {
          profession_id: "prof_030",
          name: "Специалист по охране труда",
          why: "Интерес к безопасности.",
          match_strength: "weak",
        },
      ],
    },
    rows
  );

  assert.deepEqual(
    adapted.hypotheses.map((item) => item.professionId),
    [JOURNALIST_ID, SAFETY_ID]
  );
  assert.deepEqual(
    adapted.hypotheses.map((item) => item.fitScore),
    [2, 1]
  );
  assert.equal(adapted.unmapped.length, 0);
});

test("Sofi hypotheses become relative ranks and never replace UUID with prof_001", () => {
  const adapted = adaptSofiResult(
    {
      status: "ok",
      summary: "Интерес к технике.",
      next_step: "Посмотреть одну пробу.",
      warnings: ["coverage_gap"],
      generation: {
        mode: "llm",
        tier: "9-11",
        promptVersion: "nav-9-11@1.0.2",
        catalogVersion: "sha256:catalog",
        configVersion: "age-1.0.0",
        attempts: 1,
      },
      hypotheses: [
        {
          profession_id: "prof_001",
          name: "Аналитик данных",
          why: "Ответы про анализ данных.",
          match_strength: "strong",
          evidence_refs: ["A1", "A2"],
          trial_ids: ["trial_001"],
          program_ids: ["prog_001"],
        },
        {
          profession_id: "prof_404",
          name: "Неизвестная профессия",
          why: "Этого id нет в PostgreSQL.",
          match_strength: "weak",
          evidence_refs: ["A3"],
        },
      ],
    },
    professions
  );

  assert.equal(adapted.hypotheses.length, 1);
  assert.deepEqual(adapted.hypotheses[0], {
    professionId: ANALYST_ID,
    title: "Аналитик данных",
    reason: "Ответы про анализ данных.",
    fitScore: 3,
    scoreKind: "relative_ranking",
  });
  assert.equal(adapted.hypotheses[0].professionId.includes("prof_"), false);
  assert.deepEqual(adapted.unmapped, [
    {
      status: "unmapped",
      catalogProfessionId: "prof_404",
      professionId: null,
    },
  ]);
  assert.equal(adapted.fallback, false);
  assert.equal(adapted.aiPayload.generation?.mode, "llm");
  assert.equal(adapted.aiPayload.generation?.promptVersion, "nav-9-11@1.0.2");
  assert.equal(adapted.aiPayload.generation?.catalogVersion, "sha256:catalog");
  assert.deepEqual(adapted.aiPayload.warnings, ["coverage_gap"]);
  assert.deepEqual(adapted.aiPayload.hypotheses[0].evidenceRefs, ["A1", "A2"]);
  assert.deepEqual(adapted.aiPayload.hypotheses[0].trialIds, ["trial_001"]);
  assert.equal(adapted.aiPayload.hypotheses[1].mapping, "unmapped");
  assert.equal(adapted.aiPayload.hypotheses[1].professionId, null);
});

test("retrieval-only fallback keeps mode and moderate rank", () => {
  const adapted = adaptSofiResult(
    {
      status: "fallback",
      summary: "Подсказки собраны по каталогу.",
      next_step: "Выбери один вариант.",
      warnings: ["llm_fallback_used"],
      generation: {
        mode: "retrieval_only",
        tier: "5-8",
        promptVersion: null,
        catalogVersion: "sha256:catalog",
        attempts: 0,
      },
      hypotheses: [
        {
          profession_id: "prof_002",
          name: "Инженер-механик",
          why: "Эта профессия связана с твоими ответами.",
          match_strength: "moderate",
          evidence_refs: ["A1"],
          trial_ids: ["trial_011"],
        },
      ],
    },
    professions
  );

  assert.equal(adapted.fallback, true);
  assert.equal(adapted.aiPayload.generation?.mode, "retrieval_only");
  assert.equal(adapted.aiPayload.generation?.promptVersion, null);
  assert.deepEqual(adapted.aiPayload.warnings, ["llm_fallback_used"]);
  assert.equal(adapted.hypotheses[0].professionId, MECHANIC_ID);
  assert.equal(adapted.hypotheses[0].fitScore, 2);
  assert.equal(adapted.hypotheses[0].scoreKind, "relative_ranking");
  assert.deepEqual(adapted.aiPayload.hypotheses[0].evidenceRefs, ["A1"]);
  assert.deepEqual(adapted.aiPayload.hypotheses[0].trialIds, ["trial_011"]);
});
