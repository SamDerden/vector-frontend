export const MOCK_SESSION_PREFIX = "11111111-1111-4111-8111-";

export type MockStudentRecord = {
  studentId: number;
  grade: number;
  city: string;
  questionnaireName: string;
  answers: Array<{ questionId: string; answer: unknown }>;
};

export type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;

export type ExistingSnapshot = {
  questionnaireColumn: boolean;
  sessions: Array<{ id: string; trackType: string }>;
  profiles: Array<{
    sessionId: string;
    schoolGrade: number | null;
    municipality: string;
    preferences: unknown;
  }>;
  diagnostics: Array<{ id: string; sessionId: string }>;
  answers: Array<{
    diagnosticId: string;
    questionId: string;
    answer: unknown;
    questionnaire: string | null;
  }>;
};

export type StudentAction = {
  studentId: number;
  sessionId: string;
  grade: number;
  city: string;
  questionnaireName: string;
  answerCount: number;
  action: "create" | "unchanged" | "conflict";
  conflict: string | null;
  createSession: boolean;
  createProfile: boolean;
  createDiagnostic: boolean;
};

export type ImportPlan = {
  targetSessionIds: string[];
  actions: StudentAction[];
  creates: {
    sessions: number;
    profiles: number;
    diagnostics: number;
    diagnosticAnswers: number;
  };
  unchanged: number;
  conflicts: StudentAction[];
};

const SESSION_ID_PATTERN =
  /^11111111-1111-4111-8111-[0-9a-f]{12}$/i;

export function mockStudentSessionId(studentId: number): string {
  if (!Number.isInteger(studentId) || studentId < 0 || studentId > 999_999_999_999) {
    throw new Error(`student_id ${String(studentId)} does not fit the stable UUID`);
  }
  return `${MOCK_SESSION_PREFIX}${String(studentId).padStart(12, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseMockStudents(data: unknown): MockStudentRecord[] {
  if (!Array.isArray(data)) {
    throw new Error("mock_students_data.json must be an array");
  }
  if (data.length !== 15) {
    throw new Error(`expected exactly 15 mock students, received ${data.length}`);
  }

  const students = data.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`student at index ${index} is not an object`);
    }
    const studentId = item.student_id;
    const grade = item.grade;
    const city = item.city;
    const questionnaireName = item.questionnaire_name;
    const answers = item.answers;
    if (!Number.isInteger(studentId)) {
      throw new Error(`student at index ${index} has a non-integer student_id`);
    }
    if (!Number.isInteger(grade) || (grade as number) < 1 || (grade as number) > 11) {
      throw new Error(`student ${String(studentId)} has grade outside 1-11`);
    }
    if (typeof city !== "string" || city.length === 0) {
      throw new Error(`student ${String(studentId)} has an empty city`);
    }
    if (typeof questionnaireName !== "string" || questionnaireName.length === 0) {
      throw new Error(`student ${String(studentId)} has an empty questionnaire_name`);
    }
    if (!isRecord(answers) || Object.keys(answers).length === 0) {
      throw new Error(`student ${String(studentId)} has no diagnostic answers`);
    }
    const parsedAnswers = Object.entries(answers).map(([questionId, answer]) => {
      if (questionId.trim().length === 0) {
        throw new Error(`student ${String(studentId)} has an empty question id`);
      }
      if (typeof answer === "undefined" || typeof answer === "function") {
        throw new Error(`student ${String(studentId)} answer ${questionId} cannot be stored as JSON`);
      }
      return { questionId, answer };
    });
    return {
      studentId: studentId as number,
      grade: grade as number,
      city,
      questionnaireName,
      answers: parsedAnswers,
    };
  });

  const ids = new Set(students.map((student) => student.studentId));
  if (ids.size !== students.length) {
    throw new Error("mock student_id values must be unique");
  }
  const sessionIds = new Set(students.map((student) => mockStudentSessionId(student.studentId)));
  if (sessionIds.size !== students.length) {
    throw new Error("stable session ids must be unique");
  }
  for (const sessionId of sessionIds) {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`session id ${sessionId} is outside the mock prefix`);
    }
  }
  return students;
}

function preferenceValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function samePreferences(
  stored: unknown,
  student: MockStudentRecord
): boolean {
  const preferences = preferenceValue(stored);
  if (!preferences) return false;
  const keys = Object.keys(preferences).sort();
  if (keys.join(",") !== "mock_student_id,questionnaire_name") return false;
  return (
    preferences.mock_student_id === student.studentId &&
    preferences.questionnaire_name === student.questionnaireName
  );
}

function sameAnswers(
  stored: ExistingSnapshot["answers"],
  student: MockStudentRecord,
  questionnaireColumn: boolean
): boolean {
  if (stored.length !== student.answers.length) return false;
  const byId = new Map(stored.map((item) => [item.questionId, item]));
  return student.answers.every((item) => {
    const current = byId.get(item.questionId);
    if (!current) return false;
    if (canonicalJson(current.answer) !== canonicalJson(item.answer)) return false;
    if (!questionnaireColumn) return true;
    return current.questionnaire === student.questionnaireName;
  });
}

export function buildImportPlan(
  students: MockStudentRecord[],
  snapshot: ExistingSnapshot
): ImportPlan {
  const sessions = new Map(snapshot.sessions.map((row) => [row.id, row]));
  const profiles = new Map(snapshot.profiles.map((row) => [row.sessionId, row]));
  const diagnosticsBySession = new Map<string, ExistingSnapshot["diagnostics"]>();
  for (const row of snapshot.diagnostics) {
    const list = diagnosticsBySession.get(row.sessionId) ?? [];
    list.push(row);
    diagnosticsBySession.set(row.sessionId, list);
  }
  const answersByDiagnostic = new Map<string, ExistingSnapshot["answers"]>();
  for (const row of snapshot.answers) {
    const list = answersByDiagnostic.get(row.diagnosticId) ?? [];
    list.push(row);
    answersByDiagnostic.set(row.diagnosticId, list);
  }

  const actions = students.map((student) => {
    const sessionId = mockStudentSessionId(student.studentId);
    const base = {
      studentId: student.studentId,
      sessionId,
      grade: student.grade,
      city: student.city,
      questionnaireName: student.questionnaireName,
      answerCount: student.answers.length,
    };
    const session = sessions.get(sessionId);
    const profile = profiles.get(sessionId);
    const diagnostics = diagnosticsBySession.get(sessionId) ?? [];

    if (diagnostics.length > 1) {
      return {
        ...base,
        action: "conflict" as const,
        conflict: "multiple diagnostics already exist",
        createSession: false,
        createProfile: false,
        createDiagnostic: false,
      };
    }

    if (session && session.trackType !== "explore") {
      return {
        ...base,
        action: "conflict" as const,
        conflict: `track_type is ${session.trackType}`,
        createSession: false,
        createProfile: false,
        createDiagnostic: false,
      };
    }

    if (
      profile &&
      (profile.schoolGrade !== student.grade ||
        profile.municipality !== student.city ||
        !samePreferences(profile.preferences, student))
    ) {
      return {
        ...base,
        action: "conflict" as const,
        conflict: "profile does not match the mock student",
        createSession: false,
        createProfile: false,
        createDiagnostic: false,
      };
    }

    if (diagnostics.length === 1) {
      const answers = answersByDiagnostic.get(diagnostics[0].id) ?? [];
      if (!sameAnswers(answers, student, snapshot.questionnaireColumn)) {
        return {
          ...base,
          action: "conflict" as const,
          conflict: "diagnostic answers do not match the mock student",
          createSession: false,
          createProfile: false,
          createDiagnostic: false,
        };
      }
      return {
        ...base,
        action: "unchanged" as const,
        conflict: null,
        createSession: false,
        createProfile: false,
        createDiagnostic: false,
      };
    }

    return {
      ...base,
      action: "create" as const,
      conflict: null,
      createSession: !session,
      createProfile: !profile,
      createDiagnostic: true,
    };
  });

  const creates = {
    sessions: actions.filter((item) => item.createSession).length,
    profiles: actions.filter((item) => item.createProfile).length,
    diagnostics: actions.filter((item) => item.createDiagnostic).length,
    diagnosticAnswers: actions
      .filter((item) => item.createDiagnostic)
      .reduce((sum, item) => sum + item.answerCount, 0),
  };

  return {
    targetSessionIds: students.map((student) => mockStudentSessionId(student.studentId)),
    actions,
    creates,
    unchanged: actions.filter((item) => item.action === "unchanged").length,
    conflicts: actions.filter((item) => item.action === "conflict"),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function loadExistingSnapshot(
  query: DbQuery,
  sessionIds: string[],
  lock: boolean
): Promise<ExistingSnapshot> {
  const column = await query(
    `SELECT 1 AS ok
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'diagnostic_answers'
       AND column_name = 'questionnaire'`
  );
  const sessions = await query(
    `SELECT id, track_type
     FROM sessions
     WHERE id = ANY($1::uuid[])${lock ? " FOR UPDATE" : ""}`,
    [sessionIds]
  );
  const profiles = await query(
    `SELECT session_id, school_grade, municipality, preferences
     FROM profiles
     WHERE session_id = ANY($1::uuid[])`,
    [sessionIds]
  );
  const diagnostics = await query(
    `SELECT id, session_id
     FROM diagnostics
     WHERE session_id = ANY($1::uuid[])`,
    [sessionIds]
  );
  const diagnosticIds = diagnostics.rows.map((row) => String(row.id));
  const questionnaireColumn = column.rows.length > 0;
  const answers =
    diagnosticIds.length === 0
      ? { rows: [] as Array<Record<string, unknown>> }
      : await query(
          questionnaireColumn
            ? `SELECT diagnostic_id, question_id, answer, questionnaire
               FROM diagnostic_answers
               WHERE diagnostic_id = ANY($1::uuid[])`
            : `SELECT diagnostic_id, question_id, answer
               FROM diagnostic_answers
               WHERE diagnostic_id = ANY($1::uuid[])`,
          [diagnosticIds]
        );

  return {
    questionnaireColumn,
    sessions: sessions.rows.map((row) => ({
      id: String(row.id),
      trackType: String(row.track_type),
    })),
    profiles: profiles.rows.map((row) => ({
      sessionId: String(row.session_id),
      schoolGrade: numberOrNull(row.school_grade),
      municipality: String(row.municipality),
      preferences: row.preferences,
    })),
    diagnostics: diagnostics.rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
    })),
    answers: answers.rows.map((row) => ({
      diagnosticId: String(row.diagnostic_id),
      questionId: String(row.question_id),
      answer: row.answer,
      questionnaire: row.questionnaire == null ? null : String(row.questionnaire),
    })),
  };
}

async function insertStudent(
  query: DbQuery,
  student: MockStudentRecord,
  action: StudentAction,
  questionnaireColumn: boolean
): Promise<void> {
  if (action.createSession) {
    await query(
      `INSERT INTO sessions (id, track_type, created_at, updated_at)
       VALUES ($1, 'explore', now(), now())`,
      [action.sessionId]
    );
  }
  if (action.createProfile) {
    await query(
      `INSERT INTO profiles (session_id, school_grade, municipality, preferences)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        action.sessionId,
        student.grade,
        student.city,
        JSON.stringify({
          mock_student_id: student.studentId,
          questionnaire_name: student.questionnaireName,
        }),
      ]
    );
  }
  if (!action.createDiagnostic) return;

  const inserted = await query(
    `INSERT INTO diagnostics (session_id, submitted_at)
     VALUES ($1, now())
     RETURNING id`,
    [action.sessionId]
  );
  const diagnosticId = String(inserted.rows[0]?.id ?? "");
  if (!diagnosticId) {
    throw new Error(`diagnostic id was not returned for session ${action.sessionId}`);
  }
  for (const item of student.answers) {
    if (questionnaireColumn) {
      await query(
        `INSERT INTO diagnostic_answers
           (diagnostic_id, question_id, answer, questionnaire)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [diagnosticId, item.questionId, JSON.stringify(item.answer), student.questionnaireName]
      );
    } else {
      await query(
        `INSERT INTO diagnostic_answers (diagnostic_id, question_id, answer)
         VALUES ($1, $2, $3::jsonb)`,
        [diagnosticId, item.questionId, JSON.stringify(item.answer)]
      );
    }
  }
}

export type ImportRunResult = {
  apply: boolean;
  committed: boolean;
  plan: ImportPlan;
  questionnaireColumn: boolean;
  outsideTargetWrites: number;
};

export async function runMockStudentImport(
  query: DbQuery,
  students: MockStudentRecord[],
  options: { apply: boolean }
): Promise<ImportRunResult> {
  const targetIds = students.map((student) => mockStudentSessionId(student.studentId));
  const allowed = new Set(targetIds);
  let outsideTargetWrites = 0;
  const guarded: DbQuery = async (sql, params = []) => {
    if (/^\s*(insert|update|delete|alter|drop)\b/i.test(sql)) {
      for (const value of params) {
        if (typeof value === "string" && value.startsWith(MOCK_SESSION_PREFIX) && !allowed.has(value)) {
          outsideTargetWrites += 1;
        }
      }
    }
    return query(sql, params);
  };

  await guarded(options.apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    const snapshot = await loadExistingSnapshot(guarded, targetIds, options.apply);
    const plan = buildImportPlan(students, snapshot);
    if (!options.apply || plan.conflicts.length > 0) {
      await guarded("ROLLBACK");
      return {
        apply: options.apply,
        committed: false,
        plan,
        questionnaireColumn: snapshot.questionnaireColumn,
        outsideTargetWrites,
      };
    }

    const byId = new Map(students.map((student) => [student.studentId, student]));
    for (const action of plan.actions) {
      if (action.action !== "create") continue;
      if (!allowed.has(action.sessionId)) {
        outsideTargetWrites += 1;
        throw new Error(`refusing to write outside the 15 target sessions: ${action.sessionId}`);
      }
      const student = byId.get(action.studentId);
      if (!student) throw new Error(`missing student ${action.studentId}`);
      await insertStudent(guarded, student, action, snapshot.questionnaireColumn);
    }
    await guarded("COMMIT");
    return {
      apply: true,
      committed: true,
      plan,
      questionnaireColumn: snapshot.questionnaireColumn,
      outsideTargetWrites,
    };
  } catch (error) {
    await guarded("ROLLBACK");
    throw error;
  }
}
