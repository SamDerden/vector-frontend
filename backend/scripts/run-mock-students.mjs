import fs from "node:fs";
import path from "node:path";

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const file = path.resolve("data/mock_students_data.json");
const students = JSON.parse(fs.readFileSync(file, "utf8"));
const persist = process.argv.includes("--persist");
const aiLimit = Number(
  (process.argv.find((arg) => arg.startsWith("--ai=")) ?? "--ai=0").slice(5)
);

function toAnswers(student) {
  return Object.entries(student.answers ?? {}).map(([questionId, answer]) => ({
    questionId,
    answer,
  }));
}

function newSessionId(studentId) {
  const suffix = String(studentId).padStart(4, "0");
  const rand = crypto.randomUUID().slice(0, 8);
  return `22222222-2222-4222-8222-${rand}${suffix}`.slice(0, 36);
}

async function api(method, path, sessionId, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Session-ID": sessionId,
    },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

console.log(`Mock students file: ${students.length} records`);
console.log("Clarification answers are NOT in mock JSON and are not invented.");

if (!persist) {
  console.log("Compatibility-only mode. Use --persist to write new sessions via API.");
  console.log("Optional: --ai=3 to generate recommendations for 3 representative students.");
}

const summary = [];

if (persist) {
  const health = await api("GET", "/api/health", crypto.randomUUID());
  if (health.status !== 200) {
    console.error(`API is not healthy at ${BASE} (HTTP ${health.status})`);
    process.exit(1);
  }
}

const representative = new Set([2, 8, 15]);
let aiUsed = 0;

for (const student of students) {
  const answers = toAnswers(student);
  const row = {
    studentId: student.student_id,
    grade: student.grade,
    answerCount: answers.length,
    persist: "skipped",
    reload: "skipped",
    ai: "skipped",
  };

  if (persist) {
    const sessionId = newSessionId(student.student_id);
    const track = await api("POST", "/api/track/select", sessionId, {
      trackType: "explore",
    });
    const diagnostic = await api("POST", "/api/diagnostic/submit", sessionId, {
      answers,
    });
    const latest = await api("GET", "/api/diagnostic/latest", sessionId);
    const reloadedCount = latest.json?.answers?.length ?? 0;
    row.persist = track.status === 200 && diagnostic.status === 201 ? "saved" : `HTTP ${diagnostic.status}`;
    row.reload =
      latest.status === 200 && reloadedCount === answers.length
        ? `ok:${reloadedCount}`
        : `mismatch:${reloadedCount}/${answers.length}`;
    row.sessionId = sessionId;

    const wantAi = Number.isFinite(aiLimit) && aiLimit > 0 && representative.has(student.student_id) && aiUsed < aiLimit;
    if (wantAi && row.persist === "saved") {
      const generate = await api("POST", "/api/recommendations/generate", sessionId, {});
      if (generate.status === 201) {
        const stored = await api("GET", "/api/recommendations", sessionId);
        row.ai =
          stored.status === 200 && stored.json?.recommendationId === generate.json?.recommendationId
            ? "generated_and_reloaded"
            : "generated_reload_failed";
      } else {
        row.ai = `HTTP ${generate.status}`;
      }
      aiUsed += 1;
    }
  }

  summary.push(row);
  console.log(
    `student ${row.studentId} grade ${row.grade} answers ${row.answerCount} persist=${row.persist} reload=${row.reload} ai=${row.ai}`
  );
}

const persistOk = summary.filter((item) => item.persist === "saved").length;
const reloadOk = summary.filter((item) => String(item.reload).startsWith("ok:")).length;
const aiOk = summary.filter((item) => item.ai === "generated_and_reloaded").length;

console.log("");
console.log(`Persisted: ${persistOk}/${students.length}`);
console.log(`Reloaded from PostgreSQL: ${reloadOk}/${students.length}`);
console.log(`AI generated and reloaded: ${aiOk}`);

if (persist && reloadOk !== students.length) {
  process.exit(1);
}
