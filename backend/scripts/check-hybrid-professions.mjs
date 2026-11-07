import fs from "node:fs/promises";

import pg from "pg";

import { loadLocalEnv } from "./load-env.mjs";
import { assessHybridProfessionState } from "./hybrid-profession-plan.mjs";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const hybrid = JSON.parse(
  await fs.readFile("data/navigator_full_graph.hybrid_v2.json", "utf8")
);
const legacy = JSON.parse(
  await fs.readFile("data/navigator_full_graph.json", "utf8")
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true"
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined,
});

try {
  const result = await pool.query(`
    SELECT id, external_id, title, graph_profession_id
    FROM professions
  `);
  const assessment = assessHybridProfessionState({
    professions: result.rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      title: row.title,
      graphProfessionId: row.graph_profession_id,
    })),
    graphProfessions: hybrid.professions.map((profession) => ({
      professionId: profession.profession_id,
      name: profession.name,
    })),
    legacyProfessions: legacy.map((profession) => ({
      professionId: profession.profession_id,
      name: profession.name,
    })),
  });
  const reported = {
    ok: assessment.ok,
    graphIds: result.rows.filter((row) => row.graph_profession_id).length,
    uuidBaseline: false,
    problems: assessment.problems,
  };
  console.log(JSON.stringify(reported, null, 2));
  if (!reported.ok) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
