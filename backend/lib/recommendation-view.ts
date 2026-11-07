export type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
}>;

export const LATEST_RECOMMENDATION_SQL = `SELECT
  id,
  session_id,
  summary,
  hypotheses,
  trial_ids,
  next_step,
  pathways,
  model_name,
  created_at,
  ai_payload,
  generation_mode,
  prompt_version,
  catalog_version,
  config_version
FROM recommendations
WHERE session_id = $1
ORDER BY created_at DESC
LIMIT 1`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function hasSofiData(row: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return (
    Object.keys(payload).length > 0 ||
    row.generation_mode != null ||
    row.prompt_version != null ||
    row.catalog_version != null ||
    row.config_version != null
  );
}

function readGeneration(
  payload: Record<string, unknown>,
  row: Record<string, unknown>
): Record<string, unknown> | undefined {
  const stored = isRecord(payload.generation) ? payload.generation : null;
  const mode = stored?.mode ?? row.generation_mode;
  if (!stored && mode !== "llm" && mode !== "retrieval_only") {
    return undefined;
  }

  const generation: Record<string, unknown> = stored ? { ...stored } : {};
  if (mode === "llm" || mode === "retrieval_only") {
    generation.mode = mode;
  }
  if (!("promptVersion" in generation) || generation.promptVersion == null) {
    generation.promptVersion = row.prompt_version ?? null;
  }
  if (!("catalogVersion" in generation) || generation.catalogVersion == null) {
    generation.catalogVersion = row.catalog_version ?? null;
  }
  if (!("configVersion" in generation) || generation.configVersion == null) {
    generation.configVersion = row.config_version ?? null;
  }
  return generation;
}

function readInterestTags(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.interestTags)) return payload.interestTags;
  if (Array.isArray(payload.interest_tags)) return payload.interest_tags;
  return [];
}

export function sofiPublicFields(row: Record<string, unknown>): Record<string, unknown> {
  const payload = readPayload(row.ai_payload);
  if (!hasSofiData(row, payload)) {
    return {};
  }

  const hypotheses = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
  const unmappedHypotheses = hypotheses.filter((item) => {
    if (!isRecord(item)) return false;
    return item.mapping === "unmapped" || item.mapping === "ambiguous";
  });
  const generation = readGeneration(payload, row);
  const fields: Record<string, unknown> = {
    interestTags: readInterestTags(payload),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    disclaimer: typeof payload.disclaimer === "string" ? payload.disclaimer : null,
  };
  if (generation) {
    fields.generation = generation;
  }
  if (unmappedHypotheses.length > 0) {
    fields.unmappedHypotheses = unmappedHypotheses;
  }
  return fields;
}

export function savedRecommendationBody(
  row: Record<string, unknown>,
  trials: unknown[]
) {
  return {
    status: "saved" as const,
    recommendationId: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    hypotheses: row.hypotheses,
    trials,
    nextStep: row.next_step,
    nextStepOptions: row.pathways,
    model: row.model_name,
    createdAt: row.created_at,
    ...sofiPublicFields(row),
  };
}

export function sessionRecommendationBody(row: Record<string, unknown>) {
  return {
    recommendationId: row.id,
    summary: row.summary,
    hypotheses: row.hypotheses,
    nextStep: row.next_step,
    nextStepOptions: row.pathways,
    model: row.model_name,
    createdAt: row.created_at,
    ...sofiPublicFields(row),
  };
}

export async function fetchLatestRecommendation(
  query: DbQuery,
  sessionId: string
) {
  const saved = await query(LATEST_RECOMMENDATION_SQL, [sessionId]);
  return saved.rows[0] ?? null;
}
