import { diagnosticSchema } from "./schemas.ts";
import { getMockStudents, type MockStudent } from "./catalog-data.ts";

export function toDiagnosticAnswers(student: MockStudent) {
  return Object.entries(student.answers ?? {}).map(([questionId, answer]) => ({
    questionId,
    answer,
  }));
}

export function mockStudentDiagnosticPayload(student: MockStudent) {
  return {
    sessionId: "11111111-1111-4111-8111-000000000001",
    answers: toDiagnosticAnswers(student),
  };
}

export function inspectMockStudentCompatibility(student: MockStudent) {
  const payload = mockStudentDiagnosticPayload(student);
  const parsed = diagnosticSchema.safeParse(payload);

  return {
    studentId: student.student_id,
    grade: student.grade,
    city: student.city,
    questionnaireName: student.questionnaire_name,
    answerCount: payload.answers.length,
    compatible: parsed.success,
    issues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
    hasClarificationAnswers: false,
  };
}

export function inspectAllMockStudents() {
  return getMockStudents().map(inspectMockStudentCompatibility);
}
