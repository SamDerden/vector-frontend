import path from "node:path";
import { pathToFileURL } from "node:url";

import { pool } from "../lib/db.ts";
import { startGenerationWorker } from "../lib/generation-worker.ts";
import { runSofiPipeline } from "../lib/sofi-pipeline.ts";

async function main() {
  const stop = startGenerationWorker({
    query: (sql, params) => pool.query(sql, params),
    connect: () => pool.connect(),
    pipeline: runSofiPipeline,
    modelName: process.env.LLM_MODEL ?? process.env.AI_MODEL ?? "sofi",
  });
  const shutdown = () => {
    void stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  void main();
}
