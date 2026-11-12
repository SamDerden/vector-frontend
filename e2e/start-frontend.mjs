import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (fs.existsSync(path.join(root, name)) || fs.existsSync(path.join(root, "backend", name))) {
    console.error("Refusing to start the E2E frontend: an env file is present.");
    process.exit(2);
  }
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AI_|LLM_|OPENAI|GIGACHAT|AZURE_OPENAI)/i.test(key) || key === "DATABASE_URL") delete env[key];
}
env.BACKEND_INTERNAL_URL = "http://127.0.0.1:3100";
env.NEXT_PUBLIC_API_BASE_URL = "";
env.NODE_ENV = "development";
env.PORT = "3101";

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", "3101"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const logDir = path.join(root, "e2e", "logs");
fs.mkdirSync(logDir, { recursive: true });
const log = fs.createWriteStream(path.join(logDir, "frontend.log"), { flags: "w" });
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
