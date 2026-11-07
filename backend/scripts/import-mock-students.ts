import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  parseMockStudents,
  runMockStudentImport,
  type DbQuery,
} from "../lib/mock-student-import.ts";

function loadLocalEnv(projectRoot = process.cwd()) {
  const envPath = path.join(projectRoot, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply");
if (unknown.length > 0) {
  console.error(`Unknown arguments: ${unknown.join(", ")}`);
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const students = parseMockStudents(
  JSON.parse(fs.readFileSync(path.resolve("data/mock_students_data.json"), "utf8"))
);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(
    /postgres(?:ql)?:\/\/\S+/gi,
    "[redacted]"
  );
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  ssl:
    process.env.PGSSL === "true"
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
});

const client = await pool.connect();
try {
  const query: DbQuery = (sql, params = []) => client.query(sql, params);
  const result = await runMockStudentImport(query, students, { apply });
  const outsideTargetWrites = result.outsideTargetWrites;
  console.log(`mode: ${apply ? "apply" : "dry-run"}`);
  console.log(`file_students: ${students.length}`);
  console.log(`target_sessions: ${result.plan.targetSessionIds.length}`);
  console.log(`questionnaire_column: ${result.questionnaireColumn ? "yes" : "no"}`);
  console.log(`create_sessions: ${result.plan.creates.sessions}`);
  console.log(`create_profiles: ${result.plan.creates.profiles}`);
  console.log(`create_diagnostics: ${result.plan.creates.diagnostics}`);
  console.log(`create_diagnostic_answers: ${result.plan.creates.diagnosticAnswers}`);
  console.log(`unchanged: ${result.plan.unchanged}`);
  console.log(`conflicts: ${result.plan.conflicts.length}`);
  console.log(`committed: ${result.committed ? "yes" : "no"}`);
  console.log(`outside_target_writes: ${outsideTargetWrites}`);
  for (const action of result.plan.actions) {
    console.log(
      `student ${action.studentId} grade ${action.grade} answers ${action.answerCount} session ${action.sessionId} action ${action.action}${action.conflict ? ` conflict ${action.conflict}` : ""}`
    );
  }
  if (result.plan.conflicts.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Mock student import failed: ${safeError(error)}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
