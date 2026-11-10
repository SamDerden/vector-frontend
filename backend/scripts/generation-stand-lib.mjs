import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STAND_HOST = "127.0.0.1";
export const STAND_PORT = "55432";
export const STAND_DATABASE = "vector_prof_generation_stand";
export const STAND_USER = "generation_stand";
export const STAND_PASSWORD = "generation_stand_local_only";
export const STAND_URL = `postgresql://${STAND_USER}:${STAND_PASSWORD}@${STAND_HOST}:${STAND_PORT}/${STAND_DATABASE}`;

export function assertStandDatabaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("GENERATION_STAND_DATABASE_URL is required. DATABASE_URL is ignored.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("GENERATION_STAND_DATABASE_URL is not a valid URL.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  const port = url.port;
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Stand URL must use the postgresql protocol.");
  }
  if (url.hostname !== STAND_HOST) {
    throw new Error("Stand host must be 127.0.0.1.");
  }
  if (port !== STAND_PORT) {
    throw new Error("Stand port must be 55432.");
  }
  if (database !== STAND_DATABASE) {
    throw new Error("Stand database must be vector_prof_generation_stand.");
  }
  if (user !== STAND_USER) {
    throw new Error("Stand user must be generation_stand.");
  }
  if (decodeURIComponent(url.password) !== STAND_PASSWORD) {
    throw new Error("Stand password does not match the isolated stand.");
  }
  if (port === "5433" || database === "navigator" || user === "navigator") {
    throw new Error("Refusing the existing navigator database.");
  }
  return value.trim();
}

export function assertStandInvocation(env) {
  if (env.GENERATION_STAND !== "isolated") {
    throw new Error("Refusing to start without GENERATION_STAND=isolated. DATABASE_URL is ignored.");
  }
  return assertStandDatabaseUrl(env.GENERATION_STAND_DATABASE_URL);
}

export async function applyStandMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const dir = path.join(root, "migrations");
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    const applied = [];
    for (const filename of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
      if (existing.rowCount) continue;
      const sql = await fs.readFile(path.join(dir, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}
