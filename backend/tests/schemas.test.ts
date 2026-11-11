import assert from "node:assert/strict";
import { test } from "node:test";

import { validateClarificationAnswers } from "../lib/clarification.ts";
import {
  getClarificationQuestions,
  getPrimaryClarificationQuestions,
  getBiletQuestionnaires,
  getMockStudents,
  getNavigatorGraph,
  lookupQuestionText,
  questionnaireForGrade,
} from "../lib/catalog-data.ts";
import { buildPathwayOptions, classifyOpportunity } from "../lib/pathways.ts";
import { parseAIResponse, summarizeAiParseFailure } from "../lib/legacy-ai.ts";
import {
  clarificationSubmitSchema,
  diagnosticSchema,
  generateRecommendationsSchema,
} from "../lib/schemas.ts";

test("clarification catalog has six questions with options", () => {
  const questions = getClarificationQuestions();
  assert.equal(questions.length, 6);
  for (const question of questions) {
    assert.ok(question.question_id.startsWith("agent_q"));
    assert.ok(question.options.length >= 2);
  }
});

test("primary clarification uses six child-friendly questions and preserves canonical IDs", () => {
  const adult = getClarificationQuestions();
  const primary = getPrimaryClarificationQuestions();
  assert.equal(primary.length, 6);
  assert.deepEqual(primary.map(q => q.question_id), adult.map(q => q.question_id));
  for (let i = 0; i < primary.length; i++) {
    assert.deepEqual(primary[i].options.map(o => o.value), adult[i].options.map(o => o.value));
    assert.notEqual(primary[i].text, adult[i].text);
  }
  assert.ok(primary[0].text.includes("нравится"));
  assert.equal(validateClarificationAnswers(
    primary.map(q => ({questionId: q.question_id, answer: [q.options[0].value]})),
    primary
  ).length, 0);
});

test("bilet questionnaires cover grades 1-11", () => {
  const questionnaires = getBiletQuestionnaires();
  assert.equal(questionnaires.length, 7);
  assert.ok(questionnaireForGrade(3)?.questionnaire_name.includes("1-5"));
  assert.ok(questionnaireForGrade(11)?.questionnaire_name.includes("11"));
});

test("mock students file has 15 records with answers", () => {
  const students = getMockStudents();
  assert.equal(students.length, 15);
  for (const student of students) {
    assert.ok(student.student_id >= 1 && student.student_id <= 15);
    assert.ok(Object.keys(student.answers).length > 0);
  }
});

test("navigator graph is available as an extensible catalog overlay", () => {
  const graph = getNavigatorGraph();
  assert.ok(graph);
  assert.ok(graph.length > 0);
  assert.ok(graph[0].profession_id);
});

test("legacy diagnostic payload remains valid", () => {
  const parsed = diagnosticSchema.parse({
    sessionId: "6f9619ff-8b86-4011-a42d-00cf4fc964ff",
    answers: [
      { questionId: "q1", answer: "technology" },
      { questionId: "q2", answer: true },
    ],
  });
  assert.equal(parsed.answers.length, 2);
  assert.equal(parsed.clarificationAnswers, undefined);
});

test("diagnostic payload accepts optional clarification answers", () => {
  const parsed = diagnosticSchema.parse({
    sessionId: "6f9619ff-8b86-4011-a42d-00cf4fc964ff",
    answers: [{ questionId: "q1", answer: ["Математика"] }],
    clarificationAnswers: [
      { questionId: "agent_q2_work_style", answer: "team" },
    ],
  });
  assert.equal(parsed.clarificationAnswers?.length, 1);
});

test("clarification answers are checked against catalog options", () => {
  const errors = validateClarificationAnswers([
    { questionId: "agent_q2_work_style", answer: "team" },
    { questionId: "unknown", answer: "x" },
  ]);
  assert.ok(errors.some((item) => item.includes("unknown")));
});

test("clarification submit schema rejects extra questions beyond six", () => {
  const answers = Array.from({ length: 7 }, (_, index) => ({
    questionId: `agent_q${index}`,
    answer: "x",
  }));
  const result = clarificationSubmitSchema.safeParse({ answers });
  assert.equal(result.success, false);
});

test("empty generate body remains valid", () => {
  assert.deepEqual(generateRecommendationsSchema.parse({}), {});
});

test("college level maps to college pathway and missing types stay unavailable", () => {
  assert.equal(
    classifyOpportunity({ level: "СПО", title: "Технология машиностроения" }),
    "college"
  );
  const options = buildPathwayOptions({
    opportunities: [
      {
        id: "prog-1",
        title: "Технология машиностроения",
        institution: "Уральский политехнический колледж",
        level: "СПО",
        url: null,
        organizationName: "УПК-МЦК",
        organizationType: "колледж",
        website: "https://example.edu",
        contactEmail: null,
        professionIds: ["prof-1"],
      },
    ],
    professionIds: ["prof-1"],
  });
  const college = options.find((item) => item.type === "college");
  const club = options.find((item) => item.type === "club");
  const online = options.find((item) => item.type === "online_course");
  assert.equal(college?.available, true);
  assert.equal(college?.url, "https://example.edu");
  assert.equal(club?.available, false);
  assert.equal(online?.available, false);
});

test("lookupQuestionText maps bilet and clarification ids", () => {
  assert.ok(lookupQuestionText("agent_q2_work_style"));
  assert.ok(lookupQuestionText("bilet_q1_subjects"));
  assert.equal(lookupQuestionText("unknown_question"), null);
});

test("AI JSON parser accepts object payload without fitScore", () => {
  const parsed = parseAIResponse({
    summary: "Интерес к технике.",
    hypotheses: [
      {
        professionId: "ec5a249f-50a3-465d-ad12-c69c83b9180f",
        title: "Аналитик данных",
        reason: "Содержательные ответы про анализ данных.",
      },
    ],
    nextStep: "Посмотреть колледж из каталога.",
  });
  assert.equal(parsed.hypotheses[0].fitScore, 0);
  assert.equal(parsed.trialIds.length, 0);
});

test("AI JSON parser accepts GigaChat quirks without inventing catalog ids", () => {
  const parsed = parseAIResponse(
    `Конечно, вот результат:
\`\`\`json
{
  "summary": "Интерес к технике.",
  "hypotheses": [
    {
      "profession_id": "prof_001",
      "title": "Инженер-механик",
      "reason": "Нравится собирать технику.",
      "fit_score": "80%"
    }
  ],
  "trial_ids": null,
  "pathways": {
    "clubProgramId": "",
    "collegeProgramId": "prog_025",
    "onlineCourseProgramId": null
  }
}
\`\`\`
Удачи!`,
    {
      professionIdByExternalId: new Map([
        ["prof_001", "ec5a249f-50a3-465d-ad12-c69c83b9180f"],
      ]),
    }
  );
  assert.equal(parsed.hypotheses[0].professionId, "ec5a249f-50a3-465d-ad12-c69c83b9180f");
  assert.equal(parsed.hypotheses[0].fitScore, 80);
  assert.deepEqual(parsed.trialIds, []);
  assert.equal(parsed.pathways?.clubProgramId, null);
  assert.equal(parsed.pathways?.collegeProgramId, null);
  assert.ok(parsed.nextStep.length > 0);
});

test("AI parse failure summary omits model text and personal data", () => {
  try {
    parseAIResponse("это не json, секрет ученика и api-key");
    assert.fail("expected parse failure");
  } catch (error) {
    const report = summarizeAiParseFailure(error, "секрет ученика и полный ответ модели");
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("секрет"), false);
    assert.equal(serialized.includes("api-key"), false);
    assert.equal(serialized.includes("полный ответ"), false);
    assert.ok(report.stage);
  }
});

test("AI JSON parser rejects hypotheses that are not in the catalog", () => {
  assert.throws(() =>
    parseAIResponse({
      summary: "x",
      hypotheses: [
        {
          professionId: "unknown_profession",
          title: "Выдуманная",
          reason: "Нет в каталоге",
        },
      ],
      nextStep: "Шаг",
    })
  );
});

test("AI JSON parser accepts fenced responses and default trialIds", () => {
  const parsed = parseAIResponse(`\`\`\`json
{
  "summary": "Интерес к технике и данным.",
  "hypotheses": [
    {
      "professionId": "ec5a249f-50a3-465d-ad12-c69c83b9180f",
      "title": "Аналитик данных",
      "reason": "Содержательные ответы про анализ данных.",
      "fitScore": 70
    }
  ],
  "nextStep": "Посмотреть колледж из каталога."
}
\`\`\``);
  assert.equal(parsed.trialIds.length, 0);
  assert.equal(parsed.hypotheses[0].title, "Аналитик данных");
});
