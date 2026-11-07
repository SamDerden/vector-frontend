import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const file = path.resolve("data/mock_students_data.json");
const students = JSON.parse(fs.readFileSync(file, "utf8"));

if (!Array.isArray(students) || students.length === 0) {
  console.error("mock_students_data.json is empty or invalid");
  process.exit(1);
}

function sessionIdFor(studentId) {
  const suffix = String(studentId).padStart(12, "0");
  return `11111111-1111-4111-8111-${suffix}`;
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.PGSSL === "true"
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
});

const client = await pool.connect();

try {
  await client.query("BEGIN");

  for (const student of students) {
    const sessionId = sessionIdFor(student.student_id);
    await client.query(
      `INSERT INTO sessions (id, track_type, created_at, updated_at)
       VALUES ($1, 'explore', now(), now())
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [sessionId]
    );

    await client.query(
      `INSERT INTO profiles (session_id, school_grade, municipality, preferences)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         school_grade = EXCLUDED.school_grade,
         municipality = EXCLUDED.municipality,
         preferences = EXCLUDED.preferences`,
      [
        sessionId,
        Number.isInteger(student.grade) && student.grade >= 8 && student.grade <= 11
          ? student.grade
          : null,
        student.city || "Екатеринбург",
        JSON.stringify({
          mock_student_id: student.student_id,
          questionnaire_name: student.questionnaire_name,
        }),
      ]
    );

    const diagnostic = await client.query(
      `INSERT INTO diagnostics (session_id, submitted_at)
       VALUES ($1, now())
       RETURNING id`,
      [sessionId]
    );
    const diagnosticId = diagnostic.rows[0].id;

    for (const [questionId, answer] of Object.entries(student.answers ?? {})) {
      await client.query(
        `INSERT INTO diagnostic_answers (diagnostic_id, question_id, answer)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (diagnostic_id, question_id) DO UPDATE SET answer = EXCLUDED.answer`,
        [diagnosticId, questionId, JSON.stringify(answer)]
      );
    }
  }

  await client.query("COMMIT");
  console.log(`Seeded ${students.length} mock students as diagnostic sessions.`);
  console.log("Session UUID pattern: 11111111-1111-4111-8111-<student_id padded to 12>");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Mock student seed failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
