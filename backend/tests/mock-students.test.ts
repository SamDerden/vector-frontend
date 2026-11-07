import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectAllMockStudents, toDiagnosticAnswers } from "../lib/mock-students.ts";
import { diagnosticSchema } from "../lib/schemas.ts";

test("all 15 mock students map to the diagnostic API payload", () => {
  const report = inspectAllMockStudents();
  assert.equal(report.length, 15);
  for (const item of report) {
    assert.equal(item.compatible, true, JSON.stringify(item.issues));
    assert.equal(item.hasClarificationAnswers, false);
    assert.ok(item.answerCount >= 13);
  }
});

test("mock student answers keep source values and do not invent clarifications", () => {
  const report = inspectAllMockStudents();
  const first = report[0];
  const parsed = diagnosticSchema.parse({
    sessionId: "11111111-1111-4111-8111-000000000001",
    answers: toDiagnosticAnswers({
      student_id: first.studentId,
      grade: first.grade,
      city: "Екатеринбург",
      questionnaire_name: first.questionnaireName,
      answers: {
        elementary_q1_subjects: ["Окружающий мир", "Изобразительное искусство"],
      },
    }),
  });
  assert.deepEqual(parsed.answers[0].answer, [
    "Окружающий мир",
    "Изобразительное искусство",
  ]);
  assert.equal(parsed.clarificationAnswers, undefined);
});
