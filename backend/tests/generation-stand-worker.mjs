import pg from "pg";

import { completeGenerationJob } from "../lib/generation-jobs.ts";
import { runGenerationOnce } from "../lib/generation-worker.ts";
import { KEYED_RECOMMENDATION_INSERT_SQL } from "../lib/sofi-generate.ts";
import { assertStandInvocation } from "../scripts/generation-stand-lib.mjs";

if (process.env.DATABASE_URL) {
  console.error("worker refuses DATABASE_URL");
  process.exit(2);
}
for (const key of Object.keys(process.env)) {
  if (/^(AI_|LLM_|OPENAI|GIGACHAT)/i.test(key) && process.env[key]) {
    console.error("worker refuses AI configuration");
    process.exit(2);
  }
}

const standUrl = assertStandInvocation(process.env);
const pool = new pg.Pool({ connectionString: standUrl, max: 2 });
const identity = await pool.query("SELECT current_database() AS db, current_user AS usr");
if (identity.rows[0].db !== "vector_prof_generation_stand" || identity.rows[0].usr !== "generation_stand") {
  console.error("worker refuses a non-stand database");
  process.exit(2);
}

let aiCalls = 0;
const worked = await runGenerationOnce({
  workerId: "stand-worker",
  query: (sql, params) => pool.query(sql, params),
  connect: () => pool.connect(),
  pipeline: async () => {
    aiCalls += 1;
    throw new Error("AI blocked");
  },
  generate: async ({ job, deps }) => {
    const saved = await deps.query(KEYED_RECOMMENDATION_INSERT_SQL, [
      job.sessionId,
      "Синтетическая рекомендация стенда",
      "[]",
      [],
      "Дальше",
      "[]",
      "stand",
      null,
      null,
      null,
      "retrieval_only",
      "{}",
      job.id,
    ]);
    await completeGenerationJob(deps.query, {
      jobId: job.id,
      sessionId: job.sessionId,
      recommendationId: String(saved.rows[0].id),
      stageTimings: {},
    });
    return { ok: true, status: 201, body: {} };
  },
});
console.log(JSON.stringify({ worked, aiCalls, database: identity.rows[0].db }));
await pool.end();
process.exit(aiCalls === 0 ? 0 : 3);
