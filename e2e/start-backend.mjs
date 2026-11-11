import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { assertStandInvocation } from "../backend/scripts/generation-stand-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const require = createRequire(path.join(backend, "package.json"));
const { Client } = require("pg");

for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (fs.existsSync(path.join(backend, name))) {
    console.error("Refusing to start the E2E backend: an env file is present.");
    process.exit(2);
  }
}

const standUrl = assertStandInvocation({
  ...process.env,
  GENERATION_STAND: "isolated",
  GENERATION_STAND_DATABASE_URL: process.env.GENERATION_STAND_DATABASE_URL,
});

const client = new Client({ connectionString: standUrl });
await client.connect();
try {
  const identity = await client.query("SELECT current_database() AS database, current_user AS user");
  const row = identity.rows[0];
  if (row.database !== "vector_prof_generation_stand" || row.user !== "generation_stand") {
    console.error("Refusing to start: the connection is not the isolated stand.");
    process.exit(2);
  }
} finally {
  await client.end();
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AI_|LLM_|OPENAI|GIGACHAT|AZURE_OPENAI)/i.test(key) || key === "DATABASE_URL") delete env[key];
}
env.GENERATION_STAND = "isolated";
env.GENERATION_STAND_DATABASE_URL = standUrl;
env.DATABASE_URL = standUrl;
env.SESSION_PROOF_ENFORCED = "true";
env.SESSION_PROOF_SECRET = "local-stand-e2e-proof-secret-32b";
env.NODE_ENV = "development";
env.PORT = "3100";
delete env.GENERATION_WORKER_ENABLED;

const nextBin = path.join(backend, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", "3100"], {
  cwd: backend,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const logDir = path.join(root, "e2e", "logs");
fs.mkdirSync(logDir, { recursive: true });
const log = fs.createWriteStream(path.join(logDir, "backend.log"), { flags: "w" });
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
}
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
