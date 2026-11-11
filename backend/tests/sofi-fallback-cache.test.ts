import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../lib/sofi-pipeline.ts", import.meta.url)), "utf8");

test("failed retrieval does not falsely report semantic search", () => {
  assert.match(source, /function emptyRetrieval\([\s\S]*?mode: "lexical" as const/);
});

test("degraded AI or lexical results are not written into recommendation cache", () => {
  assert.match(source, /if \(mode === "llm" && retrieval\.mode === "semantic"\) \{\s*setCache\(cacheKey, result\)/);
});
