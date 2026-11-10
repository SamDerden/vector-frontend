import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { embeddingVectorsUsable, assessEmbeddingIndex, readRecordedEmbeddingModel } from "../lib/ai/index-contract.ts";
import { programsVisibleForTier, publicSkillName, resolveCatalogActivities } from "../lib/ai/presentation.ts";

const vector = [0.25, 0.5];

function indexWith(fields: Record<string, unknown>, entries = [{ vector }]) {
  return {
    catalog_version: "catalog-v",
    dimensions: 2,
    entries,
    ...fields,
  };
}

test("legacy model field is compatible and does not request a rebuild", () => {
  const decision = assessEmbeddingIndex({
    index: indexWith({ model: "EmbeddingsGigaR" }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "EmbeddingsGigaR",
    expectedDimensions: 2,
  });
  assert.equal(decision.action, "use");
  if (decision.action === "use") assert.equal(decision.field, "model");
});

test("embedding_model field is compatible", () => {
  const decision = assessEmbeddingIndex({
    index: indexWith({ embedding_model: "EmbeddingsGigaR" }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "EmbeddingsGigaR",
    expectedDimensions: 2,
  });
  assert.equal(decision.action, "use");
  if (decision.action === "use") assert.equal(decision.field, "embedding_model");
});

test("identical names in both fields stay compatible", () => {
  const recorded = readRecordedEmbeddingModel({ embedding_model: "same", model: "same" });
  assert.equal(recorded.conflict, false);
  assert.equal(recorded.model, "same");
  assert.equal(recorded.field, "embedding_model");
});

test("different model, dimensions, and non-finite vectors stay incompatible", () => {
  const wrongModel = assessEmbeddingIndex({
    index: indexWith({ model: "other-model" }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "EmbeddingsGigaR",
    expectedDimensions: 2,
  });
  assert.equal(wrongModel.action, "rebuild");

  const wrongDimensions = assessEmbeddingIndex({
    index: indexWith({ model: "EmbeddingsGigaR", dimensions: 3 }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "EmbeddingsGigaR",
    expectedDimensions: 2,
  });
  assert.equal(wrongDimensions.action, "rebuild");

  const badVector = assessEmbeddingIndex({
    index: indexWith({ embedding_model: "EmbeddingsGigaR" }, [{ vector: [1, Number.NaN] }]),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "EmbeddingsGigaR",
    expectedDimensions: 2,
  });
  assert.equal(badVector.action, "rebuild");
});

test("missing embedding configuration does not hide a broken index", () => {
  const broken = assessEmbeddingIndex({
    index: indexWith({ model: "EmbeddingsGigaR", dimensions: 4 }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "",
    expectedDimensions: 2,
  });
  assert.equal(broken.action, "refuse");
  if (broken.action === "refuse") assert.match(broken.reason, /LLM_EMBEDDINGS_MODEL/);
});

test("missing configuration keeps a structurally valid legacy index without rebuilding", () => {
  const decision = assessEmbeddingIndex({
    index: indexWith({ model: "EmbeddingsGigaR" }),
    catalogVersion: "catalog-v",
    chunkCount: 1,
    configuredModel: "",
    expectedDimensions: 2,
  });
  assert.equal(decision.action, "use-structural");
});

test("shipped catalog index is accepted through its legacy model field", () => {
  const index = JSON.parse(fs.readFileSync(new URL("../data/catalog.index.json", import.meta.url), "utf8")) as {
    model?: string;
    embedding_model?: string;
    entries: unknown[];
  };
  const catalog = JSON.parse(fs.readFileSync(new URL("../data/catalog.normalized.json", import.meta.url), "utf8")) as {
    version: string;
    chunks: unknown[];
  };
  assert.equal(typeof index.model, "string");
  assert.equal(index.embedding_model, undefined);
  const matched = assessEmbeddingIndex({
    index,
    catalogVersion: catalog.version,
    chunkCount: catalog.chunks.length,
    configuredModel: index.model ?? "",
  });
  assert.equal(matched.action, "use");
  const unconfigured = assessEmbeddingIndex({
    index,
    catalogVersion: catalog.version,
    chunkCount: catalog.chunks.length,
    configuredModel: "",
  });
  assert.equal(unconfigured.action, "use-structural");
});

test("retrieval accepts either model field and rejects a real mismatch", () => {
  const legacy = readRecordedEmbeddingModel({ model: "EmbeddingsGigaR" });
  const current = readRecordedEmbeddingModel({ embedding_model: "EmbeddingsGigaR" });
  assert.equal(embeddingVectorsUsable({
    catalogVersionMatches: true,
    recordedModel: legacy.model,
    configuredModel: "EmbeddingsGigaR",
    allowMock: false,
    vectors: [[0.1, 0.2]],
  }), true);
  assert.equal(embeddingVectorsUsable({
    catalogVersionMatches: true,
    recordedModel: current.model,
    configuredModel: "EmbeddingsGigaR",
    allowMock: false,
    vectors: [[0.1, 0.2]],
  }), true);
  assert.equal(embeddingVectorsUsable({
    catalogVersionMatches: true,
    recordedModel: "EmbeddingsGigaR",
    configuredModel: "other-model",
    allowMock: false,
    vectors: [[0.1, 0.2]],
  }), false);
  assert.equal(embeddingVectorsUsable({
    catalogVersionMatches: true,
    recordedModel: "EmbeddingsGigaR",
    configuredModel: "EmbeddingsGigaR",
    allowMock: false,
    vectors: [[0.1], [0.1, 0.2]],
  }), false);
});

test("public skill ids become catalog names", () => {
  const graph = JSON.parse(fs.readFileSync(new URL("../data/navigator_full_graph.json", import.meta.url), "utf8")) as {
    skills: Array<{ skill_id: string; name: string }>;
  };
  const names = new Map(graph.skills.map((skill) => [skill.skill_id, skill.name]));
  const resolved = publicSkillName("skill_001", names);
  assert.equal(resolved, names.get("skill_001"));
  assert.notEqual(resolved, "skill_001");
  assert.equal(resolved?.includes("skill_"), false);
  assert.equal(publicSkillName("skill_999", names), null);
  assert.equal(publicSkillName("Коммуникация", names), "Коммуникация");
});

test("education programs stay limited to grades 9-11", () => {
  assert.equal(programsVisibleForTier("1-4"), false);
  assert.equal(programsVisibleForTier("5-8"), false);
  assert.equal(programsVisibleForTier("9-11"), true);
});

test("catalog activities keep titles and drop unknown ids", () => {
  assert.deepEqual(resolveCatalogActivities([
    { trial_id: "act_1", title: "Кружок робототехники" },
    { trial_id: "act_2", title: " " },
  ], ["act_1", "missing", "act_2", "act_1"]), [
    { id: "act_1", title: "Кружок робототехники" },
  ]);
});
