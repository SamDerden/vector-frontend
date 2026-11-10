import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { assessEmbeddingIndex } from "../lib/ai/index-contract.ts";

const catalog = JSON.parse(await fs.readFile("data/catalog.normalized.json", "utf8"));
const configuredModel = (process.env.LLM_EMBEDDINGS_MODEL || "").trim();
const chunkCount = Array.isArray(catalog.chunks) ? catalog.chunks.length : 0;

let index = null;
try {
  index = JSON.parse(await fs.readFile("data/catalog.index.json", "utf8"));
} catch (error) {
  console.error("[RAG ensure] Existing index unavailable:", error instanceof Error ? error.name : "unknown");
}

function rebuild() {
  console.log("[RAG ensure] Rebuilding index using", configuredModel, "for", chunkCount, "catalog chunks");
  const result = spawnSync(process.execPath, ["scripts/build-embedding-index.mjs"], {
    stdio: "inherit",
    timeout: 180000,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error("RAG index rebuild failed; refusing to start with unverified index");
  }
}

let decision = assessEmbeddingIndex({
  index,
  catalogVersion: catalog.version,
  chunkCount,
  configuredModel,
});

if (decision.action === "rebuild") {
  rebuild();
  const rebuilt = JSON.parse(await fs.readFile("data/catalog.index.json", "utf8"));
  decision = assessEmbeddingIndex({
    index: rebuilt,
    catalogVersion: catalog.version,
    chunkCount,
    configuredModel,
  });
  if (decision.action !== "use") {
    throw new Error(decision.reason || "RAG index verification failed");
  }
}

if (decision.action === "use") {
  console.log("[RAG ensure] verified semantic index:", JSON.stringify({
    model: decision.model,
    field: decision.field,
    indexEntries: decision.entries,
    dimensions: decision.dimensions,
    catalogVersion: catalog.version,
  }));
} else if (decision.action === "use-structural") {
  console.warn("[RAG ensure]", decision.reason);
} else {
  throw new Error(decision.reason);
}
