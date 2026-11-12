import pg from "pg";

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();
const cleanup = await import(new URL("../lib/session-cleanup.ts", import.meta.url).href);
const apply = process.argv.includes("--apply");
if (apply && process.env.SESSION_CLEANUP_APPLY !== "yes") {
  console.error("Refusing to delete sessions. Dry-run is the default. Set SESSION_CLEANUP_APPLY=yes together with --apply.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. This script was not executed.");
  process.exit(2);
}

const plan = cleanup.sessionCleanupPlan(apply);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const count = await pool.query(plan.reads[0]);
  console.log(JSON.stringify({ dryRun: plan.dryRun, eligible: count.rows }));
  if (apply) {
    const deleted = await pool.query(plan.writes[0]);
    console.log(JSON.stringify({ deletedSessions: deleted.rowCount }));
  }
} finally {
  await pool.end();
}
