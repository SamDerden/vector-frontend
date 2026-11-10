export const EXPECTED_EMBEDDING_DIMENSIONS = 2560;

export type EmbeddingModelField = "embedding_model" | "model";

export type RecordedEmbeddingModel = {
  model: string | null;
  field: EmbeddingModelField | null;
  conflict: boolean;
};

export type EmbeddingIndexDecision =
  | {
      action: "use" | "use-structural";
      model: string;
      field: EmbeddingModelField;
      entries: number;
      dimensions: number;
      reason: string;
    }
  | { action: "rebuild" | "refuse"; reason: string };

type IndexShape = {
  catalog_version?: unknown;
  dimensions?: unknown;
  embedding_model?: unknown;
  model?: unknown;
  entries?: unknown;
};

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readRecordedEmbeddingModel(index: {
  embedding_model?: unknown;
  model?: unknown;
}): RecordedEmbeddingModel {
  const current = cleanName(index.embedding_model);
  const legacy = cleanName(index.model);
  if (current && legacy && current !== legacy) {
    return { model: null, field: null, conflict: true };
  }
  if (current) return { model: current, field: "embedding_model", conflict: false };
  if (legacy) return { model: legacy, field: "model", conflict: false };
  return { model: null, field: null, conflict: false };
}

function vectorProblem(entries: unknown, expectedDimensions: number): string | null {
  if (!Array.isArray(entries) || entries.length === 0) return "index has no entries";
  for (const entry of entries) {
    const vector = entry && typeof entry === "object" ? (entry as { vector?: unknown }).vector : null;
    if (
      !Array.isArray(vector) ||
      vector.length !== expectedDimensions ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      return `index vectors are missing or are not ${expectedDimensions}-dimensional finite numbers`;
    }
  }
  return null;
}

export function assessEmbeddingIndex(input: {
  index: IndexShape | null;
  catalogVersion: string;
  chunkCount: number;
  configuredModel: string;
  expectedDimensions?: number;
}): EmbeddingIndexDecision {
  const expectedDimensions = input.expectedDimensions ?? EXPECTED_EMBEDDING_DIMENSIONS;
  const configuredModel = input.configuredModel.trim();
  const index = input.index;

  if (!index) {
    return configuredModel
      ? { action: "rebuild", reason: "Embedding index file is missing or unreadable." }
      : {
          action: "refuse",
          reason: "Embedding index is unavailable and LLM_EMBEDDINGS_MODEL is not configured, so it cannot be rebuilt. Refusing to start.",
        };
  }

  const recorded = readRecordedEmbeddingModel(index);
  const problems: string[] = [];
  if (index.catalog_version !== input.catalogVersion) problems.push("catalog version does not match the index");
  if (!Array.isArray(index.entries) || index.entries.length !== input.chunkCount) {
    problems.push("index entry count does not match the catalog chunks");
  }
  if (typeof index.dimensions === "number" && index.dimensions !== expectedDimensions) {
    problems.push(`index dimensions ${index.dimensions} do not match ${expectedDimensions}`);
  }
  const vectors = vectorProblem(index.entries, expectedDimensions);
  if (vectors) problems.push(vectors);
  if (recorded.conflict) problems.push("embedding_model and model name different embedding models");
  else if (!recorded.model) problems.push("index does not name its embedding model");
  else if (configuredModel && recorded.model !== configuredModel) {
    problems.push("configured LLM_EMBEDDINGS_MODEL does not match the index model");
  }

  if (problems.length === 0 && recorded.model && recorded.field) {
    const ready = {
      model: recorded.model,
      field: recorded.field,
      entries: Array.isArray(index.entries) ? index.entries.length : 0,
      dimensions: expectedDimensions,
    };
    if (!configuredModel) {
      return {
        action: "use-structural",
        ...ready,
        reason: `LLM_EMBEDDINGS_MODEL is not set. The existing index records model ${recorded.model} in ${recorded.field}. Startup will not rebuild the index. Semantic retrieval stays disabled until that variable matches the recorded model.`,
      };
    }
    return {
      action: "use",
      ...ready,
      reason: `Index matches ${recorded.model} via ${recorded.field}.`,
    };
  }

  const reason = problems.join("; ");
  if (!configuredModel) {
    return {
      action: "refuse",
      reason: `Embedding index is not compatible (${reason}) and LLM_EMBEDDINGS_MODEL is not configured, so it cannot be rebuilt. Refusing to start.`,
    };
  }
  return { action: "rebuild", reason };
}

export function embeddingVectorsUsable(input: {
  catalogVersionMatches: boolean;
  recordedModel: string | null;
  configuredModel: string | null;
  allowMock: boolean;
  vectors: unknown[];
}): boolean {
  if (!input.catalogVersionMatches || input.vectors.length === 0) return false;
  const width = Array.isArray(input.vectors[0]) ? input.vectors[0].length : 0;
  const vectorsOk = width > 0 && input.vectors.every((vector) =>
    Array.isArray(vector) &&
    vector.length === width &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value))
  );
  if (!vectorsOk) return false;
  if (input.allowMock) return true;
  return Boolean(
    input.configuredModel &&
    input.recordedModel &&
    input.configuredModel === input.recordedModel
  );
}
