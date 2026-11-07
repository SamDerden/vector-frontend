import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  buildImportPlan,
  mockStudentSessionId,
  parseMockStudents,
  runMockStudentImport,
  type DbQuery,
  type ExistingSnapshot,
  type MockStudentRecord,
} from "../lib/mock-student-import.ts";

const emptySnapshot = (): ExistingSnapshot => ({
  questionnaireColumn: true,
  sessions: [],
  profiles: [],
  diagnostics: [],
  answers: [],
});

function sample(studentId: number, grade: number, answer: string): MockStudentRecord {
  return {
    studentId,
    grade,
    city: "Екатеринбург",
    questionnaireName: "Билет в будущее",
    answers: [{ questionId: "q1", answer: [answer] }],
  };
}

type Memory = {
  sessions: Map<string, { id: string; track_type: string }>;
  profiles: Map<string, { session_id: string; school_grade: number; municipality: string; preferences: unknown }>;
  diagnostics: Array<{ id: string; session_id: string }>;
  answers: Array<{ diagnostic_id: string; question_id: string; answer: unknown; questionnaire: string | null }>;
  sql: string[];
};

function createMemory(): Memory {
  return {
    sessions: new Map(),
    profiles: new Map(),
    diagnostics: [],
    answers: [],
    sql: [],
  };
}

function createQuery(memory: Memory): DbQuery {
  return async (sql, params = []) => {
    memory.sql.push(sql);
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "BEGIN READ ONLY" || text === "COMMIT" || text === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("information_schema.columns")) {
      return { rowCount: 1, rows: [{ ok: 1 }] };
    }
    if (text.startsWith("SELECT id, track_type")) {
      const ids = new Set(params[0] as string[]);
      const rows = [...memory.sessions.values()].filter((row) => ids.has(row.id));
      return { rowCount: rows.length, rows };
    }
    if (text.startsWith("SELECT session_id, school_grade")) {
      const ids = new Set(params[0] as string[]);
      const rows = [...memory.profiles.values()].filter((row) => ids.has(row.session_id));
      return { rowCount: rows.length, rows };
    }
    if (text.startsWith("SELECT id, session_id")) {
      const ids = new Set(params[0] as string[]);
      const rows = memory.diagnostics.filter((row) => ids.has(row.session_id));
      return { rowCount: rows.length, rows };
    }
    if (text.startsWith("SELECT diagnostic_id")) {
      const ids = new Set(params[0] as string[]);
      const rows = memory.answers.filter((row) => ids.has(row.diagnostic_id));
      return { rowCount: rows.length, rows };
    }
    if (text.startsWith("INSERT INTO sessions")) {
      memory.sessions.set(String(params[0]), { id: String(params[0]), track_type: "explore" });
      return { rowCount: 1, rows: [] };
    }
    if (text.startsWith("INSERT INTO profiles")) {
      memory.profiles.set(String(params[0]), {
        session_id: String(params[0]),
        school_grade: Number(params[1]),
        municipality: String(params[2]),
        preferences: JSON.parse(String(params[3])),
      });
      return { rowCount: 1, rows: [] };
    }
    if (text.startsWith("INSERT INTO diagnostics")) {
      const id = `diag-${String(params[0])}`;
      memory.diagnostics.push({ id, session_id: String(params[0]) });
      return { rowCount: 1, rows: [{ id }] };
    }
    if (text.startsWith("INSERT INTO diagnostic_answers")) {
      memory.answers.push({
        diagnostic_id: String(params[0]),
        question_id: String(params[1]),
        answer: JSON.parse(String(params[2])),
        questionnaire: params.length > 3 ? String(params[3]) : null,
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
}

test("stable session ids pad student_id to 12 digits", () => {
  assert.equal(mockStudentSessionId(1), "11111111-1111-4111-8111-000000000001");
  assert.equal(mockStudentSessionId(15), "11111111-1111-4111-8111-000000000015");
});

test("the mock file keeps 15 students, junior grades and original answers", () => {
  const students = parseMockStudents(
    JSON.parse(fs.readFileSync("data/mock_students_data.json", "utf8"))
  );
  assert.equal(students.length, 15);
  assert.equal(new Set(students.map((student) => student.studentId)).size, 15);

  const plan = buildImportPlan(students, emptySnapshot());
  assert.equal(plan.targetSessionIds.length, 15);
  assert.equal(plan.creates.sessions, 15);
  assert.equal(plan.creates.profiles, 15);
  assert.equal(plan.creates.diagnostics, 15);
  assert.equal(plan.creates.diagnosticAnswers, 460);
  assert.equal(plan.conflicts.length, 0);

  const junior = plan.actions.filter((action) => action.grade < 8);
  assert.deepEqual(
    junior.map((action) => action.grade),
    [2, 4, 6, 6, 7, 7]
  );
  assert.equal(junior.every((action) => action.grade !== null), true);

  const first = students[0];
  assert.equal(first.grade, 2);
  assert.equal(first.city, "Екатеринбург");
  assert.equal(first.questionnaireName.endsWith(" "), true);
  const dream = first.answers.find((item) => item.questionId === "elementary_q3_dream_profession");
  assert.deepEqual(dream?.answer, ["Ветеринаром"]);
});

test("a repeated apply does not create another diagnostic", async () => {
  const memory = createMemory();
  const students = [sample(1, 2, "природа"), sample(2, 4, "техника")];
  const query = createQuery(memory);

  const first = await runMockStudentImport(query, students, { apply: true });
  assert.equal(first.committed, true);
  assert.equal(first.plan.creates.sessions, 2);
  assert.equal(first.plan.creates.diagnostics, 2);
  assert.equal(memory.profiles.get(mockStudentSessionId(1))?.school_grade, 2);
  assert.equal(memory.profiles.get(mockStudentSessionId(2))?.school_grade, 4);
  assert.equal(memory.diagnostics.length, 2);
  assert.equal(memory.answers.length, 2);

  const second = await runMockStudentImport(query, students, { apply: true });
  assert.equal(second.committed, true);
  assert.equal(second.plan.unchanged, 2);
  assert.equal(second.plan.creates.sessions, 0);
  assert.equal(second.plan.creates.profiles, 0);
  assert.equal(second.plan.creates.diagnostics, 0);
  assert.equal(second.plan.creates.diagnosticAnswers, 0);
  assert.equal(memory.diagnostics.length, 2);
  assert.equal(memory.answers.length, 2);
  assert.equal(second.outsideTargetWrites, 0);
});

test("dry-run reads the target sessions and does not write", async () => {
  const memory = createMemory();
  memory.sessions.set("22222222-2222-4222-8222-222222222222", {
    id: "22222222-2222-4222-8222-222222222222",
    track_type: "interests",
  });
  const query = createQuery(memory);
  const result = await runMockStudentImport(query, [sample(1, 2, "природа")], { apply: false });

  assert.equal(result.committed, false);
  assert.equal(result.plan.creates.sessions, 1);
  assert.equal(result.outsideTargetWrites, 0);
  assert.equal(memory.sessions.size, 1);
  assert.equal(memory.diagnostics.length, 0);
  assert.equal(memory.sql.some((sql) => sql === "BEGIN READ ONLY"), true);
  assert.equal(memory.sql.some((sql) => sql.startsWith("INSERT")), false);
  assert.equal(memory.sql.some((sql) => /^\s*(UPDATE|DELETE)\b/i.test(sql)), false);
  assert.equal(
    memory.sessions.get("22222222-2222-4222-8222-222222222222")?.track_type,
    "interests"
  );
});

test("an existing diagnostic with different answers stops the import", async () => {
  const memory = createMemory();
  const student = sample(1, 2, "природа");
  const sessionId = mockStudentSessionId(1);
  memory.sessions.set(sessionId, { id: sessionId, track_type: "explore" });
  memory.profiles.set(sessionId, {
    session_id: sessionId,
    school_grade: 2,
    municipality: "Екатеринбург",
    preferences: {
      mock_student_id: 1,
      questionnaire_name: "Билет в будущее",
    },
  });
  memory.diagnostics.push({ id: "diag-existing", session_id: sessionId });
  memory.answers.push({
    diagnostic_id: "diag-existing",
    question_id: "q1",
    answer: ["другой ответ"],
    questionnaire: "Билет в будущее",
  });
  const before = JSON.stringify(memory.answers);

  const result = await runMockStudentImport(createQuery(memory), [student], { apply: true });
  assert.equal(result.committed, false);
  assert.equal(result.plan.conflicts.length, 1);
  assert.match(result.plan.conflicts[0].conflict ?? "", /diagnostic answers/);
  assert.equal(memory.answers.length, 1);
  assert.equal(JSON.stringify(memory.answers), before);
  assert.equal(memory.sql.some((sql) => sql.startsWith("INSERT")), false);
});

test("a different saved grade is a conflict and is not overwritten", () => {
  const student = sample(2, 4, "техника");
  const sessionId = mockStudentSessionId(2);
  const plan = buildImportPlan([student], {
    ...emptySnapshot(),
    sessions: [{ id: sessionId, trackType: "explore" }],
    profiles: [{
      sessionId,
      schoolGrade: null,
      municipality: "Екатеринбург",
      preferences: {
        mock_student_id: 2,
        questionnaire_name: "Билет в будущее",
      },
    }],
  });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.creates.profiles, 0);
  assert.equal(plan.creates.diagnostics, 0);
});
