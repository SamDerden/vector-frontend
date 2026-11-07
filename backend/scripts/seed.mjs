
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function runImport(args, description) {
  console.log(`\n=== ${description} ===`);

  const result = spawnSync(
    process.execPath,
    ["scripts/import-catalog.mjs", ...args],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${description}: завершилось с ошибкой (код ${result.status})`
    );
  }
}

try {
  console.log("=== PROFESSIONAL NAVIGATOR SEED ===");

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. Configure .env.local."
    );
  }

  // Сначала проверяем данные, ничего не записывая в БД
  runImport([], "Проверка исходных данных");

  // Импортируем каталог в существующую БД
  runImport(["--apply"], "Загрузка тестовых данных");

  console.log("\nSeed completed successfully.");
} catch (error) {
  console.error("\nSeed failed:", error.message);
  process.exitCode = 1;
}
