import pg from "pg";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const apply = process.argv.includes("--apply");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  // Only explicitly expiring sessions are eligible. Legacy rows with NULL
  // expiry and the immutable demo-student seed catalog are untouched.
  const count = await pool.query(
    "SELECT session_mode, count(*)::integer AS count FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= now() GROUP BY session_mode"
  );
  console.log(JSON.stringify({ dryRun: !apply, eligible: count.rows }));
  if (apply) {
    const deleted = await pool.query(
      "DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id"
    );
    console.log(JSON.stringify({ deletedSessions: deleted.rowCount }));
  }
} finally {
  await pool.end();
}
