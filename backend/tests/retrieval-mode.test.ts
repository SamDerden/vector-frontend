import assert from "node:assert/strict";
import test from "node:test";

import { clearCache, getFromCache, setCache, setCacheClock, shouldCachePipelineResult } from "../lib/ai/cache.ts";
import {
  cosineSimilarity,
  lexicalSimilarity,
  scoreCatalogEntries,
  selectRetrievalMode,
} from "../lib/ai/retrieval-mode.ts";

test("semantic mode is used only after embeddings succeed", () => {
  assert.equal(selectRetrievalMode({
    queryCount: 2,
    mockEmbeddings: false,
    vectorsUsable: true,
    semanticAvailable: true,
  }), "semantic");
  assert.equal(selectRetrievalMode({
    queryCount: 2,
    mockEmbeddings: false,
    vectorsUsable: true,
    semanticAvailable: false,
  }), "lexical");
  assert.equal(selectRetrievalMode({
    queryCount: 0,
    mockEmbeddings: false,
    vectorsUsable: false,
    semanticAvailable: false,
  }), "lexical");
  assert.equal(selectRetrievalMode({
    queryCount: 2,
    mockEmbeddings: true,
    vectorsUsable: true,
    semanticAvailable: false,
  }), "lexical");
  assert.equal(selectRetrievalMode({
    queryCount: 2,
    mockEmbeddings: true,
    vectorsUsable: true,
    semanticAvailable: true,
  }), "mock");
});

test("vector search prefers the matching profession and lexical search is the fallback", () => {
  const energy = [1, 0, 0];
  const design = [0, 1, 0];
  const entries = [
    { id: "prof_energy", vector: energy, text: "инженер энергетик электричество станция" },
    { id: "prof_design", vector: design, text: "дизайнер иллюстрация пространство" },
  ];
  const semantic = scoreCatalogEntries({
    entries,
    queryVector: [0.9, 0.1, 0],
    queryParts: ["энергетик"],
    minimum: 0.2,
  });
  assert.equal(semantic[0]?.id, "prof_energy");
  assert.ok(cosineSimilarity(energy, energy) > 0.99);

  const lexical = scoreCatalogEntries({
    entries,
    queryVector: null,
    queryParts: ["Мне интересна работа энергетика"],
    minimum: 0.05,
  });
  assert.equal(lexical[0]?.id, "prof_energy");
  assert.equal(lexical.some((item) => item.id === "prof_design"), false);
  assert.ok(lexicalSimilarity("энергетик", "инженер энергетик") > 0);
});

test("degraded retrieval is not cached and cached recommendations expire", () => {
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "semantic" }), true);
  assert.equal(shouldCachePipelineResult({ generationMode: "llm", retrievalMode: "lexical" }), false);
  assert.equal(shouldCachePipelineResult({ generationMode: "retrieval_only", retrievalMode: "semantic" }), false);

  let now = 1_000;
  setCacheClock(() => now);
  try {
    clearCache();
    setCache("key", { ok: true });
    assert.deepEqual(getFromCache("key"), { ok: true });
    now += 60 * 60 * 1000;
    assert.equal(getFromCache("key"), null);
  } finally {
    setCacheClock(() => Date.now());
    clearCache();
  }
});
