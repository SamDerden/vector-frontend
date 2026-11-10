import pg from "pg";

import { applyStandMigrations, assertStandInvocation } from "./generation-stand-lib.mjs";

const help = `Isolated generation stand. This command never reads .env, .env.local, or DATABASE_URL.

From backend/:

  docker compose -f docker-compose.generation-stand.yml up -d
  $env:GENERATION_STAND='isolated'
  $env:GENERATION_STAND_DATABASE_URL='postgresql://generation_stand:generation_stand_local_only@127.0.0.1:55432/vector_prof_generation_stand'
  node scripts/generation-stand.mjs migrate
  npm run test:generation-stand

Remove only this stand:

  docker compose -f docker-compose.generation-stand.yml down -v --remove-orphans

Do not run docker compose down in the main docker-compose.yml and do not prune volumes.
If Docker is unavailable, create a throwaway PostgreSQL cluster on 127.0.0.1:55432
with the same database name and user. Do not point it at an existing data directory.
`;

const command = process.argv[2];
if (command !== "migrate" && command !== "checks") {
  process.stdout.write(help);
  process.exit(command ? 2 : 0);
}

const standUrl = assertStandInvocation(process.env);
const pool = new pg.Pool({ connectionString: standUrl, max: 2 });
try {
  if (command === "migrate") {
    const applied = await applyStandMigrations(pool);
    process.stdout.write(applied.length ? `Applied ${applied.join(", ")}\n` : "Migrations already applied\n");
  } else {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "sql", "generation-stand-checks.sql");
    const checks = await pool.query(await readFile(sqlPath, "utf8"));
    const failed = checks.rows.filter((row) => row.passed !== true);
    process.stdout.write(`${checks.rows.length - failed.length}/${checks.rows.length} schema checks passed\n`);
    if (failed.length) {
      process.stdout.write(`${failed.map((row) => row.check_name).join(", ")}\n`);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
