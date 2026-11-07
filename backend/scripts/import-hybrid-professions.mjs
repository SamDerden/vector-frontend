import fs from "node:fs/promises";

import pg from "pg";

import { loadLocalEnv } from "./load-env.mjs";
import { planHybridProfessionImport } from "./hybrid-profession-plan.mjs";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const graph = JSON.parse(
  await fs.readFile("data/navigator_full_graph.hybrid_v2.json", "utf8")
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true"
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined,
});
const client = await pool.connect();

try {
  const professions = await client.query(`
    SELECT id, external_id, title, graph_profession_id
    FROM professions
    ORDER BY external_id NULLS LAST, title
  `);
  const industries = await client.query(`
    SELECT id, external_id
    FROM industries
    WHERE external_id IS NOT NULL
  `);
  const industryUuidByExternalId = new Map(
    industries.rows.map((row) => [row.external_id, row.id])
  );
  const plan = planHybridProfessionImport({
    existingProfessions: professions.rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      title: row.title,
      graphProfessionId: row.graph_profession_id,
    })),
    industries: industries.rows.map((row) => ({ externalId: row.external_id })),
    graphProfessions: graph.professions.map((profession) => ({
      professionId: profession.profession_id,
      name: profession.name,
      industryId: profession.industry_id,
      description: profession.what_does_kid,
      riasec: profession.riasec ?? null,
    })),
  });

  console.log(JSON.stringify({
    ok: plan.ok,
    links: plan.links.length,
    inserts: plan.inserts.length,
    unchanged: plan.unchanged.length,
    blocked: plan.blocked,
  }, null, 2));

  if (!plan.ok) {
    process.exitCode = 2;
  } else {
    await client.query("BEGIN");
    try {
      for (const link of plan.links) {
        const updated = await client.query(
          `UPDATE professions
           SET graph_profession_id = $2
           WHERE id = $1
             AND title = $3
             AND (graph_profession_id IS NULL OR graph_profession_id = $2)`,
          [link.rowId, link.graphProfessionId, link.title]
        );
        if (updated.rowCount !== 1) {
          throw new Error(`Refusing to relink profession ${link.graphProfessionId}`);
        }
      }

      for (const insert of plan.inserts) {
        const industryId = industryUuidByExternalId.get(insert.industryExternalId);
        if (!industryId) {
          throw new Error(`Missing industry ${insert.industryExternalId}`);
        }
        const inserted = await client.query(
          `INSERT INTO professions (
             title,
             description,
             industry_id,
             riasec,
             graph_profession_id,
             external_id
           )
           SELECT $1, $2, $3, $4::jsonb, $5, $6
           WHERE NOT EXISTS (
             SELECT 1
             FROM professions
             WHERE graph_profession_id = $5
                OR title = $1
           )`,
          [
            insert.title,
            insert.description,
            industryId,
            insert.riasec ? JSON.stringify(insert.riasec) : null,
            insert.graphProfessionId,
            insert.externalId,
          ]
        );
        if (inserted.rowCount !== 1) {
          throw new Error(`Profession ${insert.graphProfessionId} was not inserted`);
        }
      }

      await client.query("COMMIT");
      console.log("Hybrid profession import committed");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
