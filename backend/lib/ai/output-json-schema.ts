import { JsonSchemaResponseFormat } from "./llm/client";
import promptManifest from "@/prompts/manifest.json";

type JsonSchema = Record<string, unknown>;

const stringSchema: JsonSchema = { type: "string" };
const stringArraySchema: JsonSchema = {
  type: "array",
  items: stringSchema,
};

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties)
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const evidenceRefsSchema: JsonSchema = {
  type: "array",
  items: stringSchema,
};

const industrySchema = objectSchema({
  industry_id: stringSchema,
  why: stringSchema,
  evidence_refs: evidenceRefsSchema,
});

const activityLinkSchema = objectSchema({
  type: stringSchema,
  evidence_refs: evidenceRefsSchema,
});

function hypothesisSchema(isSeniorTrack: boolean): JsonSchema {
  return objectSchema({
    profession_id: stringSchema,
    industry_id: stringSchema,
    why: stringSchema,
    evidence_refs: evidenceRefsSchema,
    activity_links: {
      type: "array",
      items: activityLinkSchema,
    },
    match_strength: {
      type: "string",
      enum: ["strong", "moderate", "weak"],
    },
    what_to_try: stringSchema,
    trial_ids: stringArraySchema,
    ...(isSeniorTrack
      ? {
          program_ids: stringArraySchema,
          watch_out: stringSchema,
        }
      : {}),
  });
}

function recommendationSchema(
  tier: "1-4" | "5-8" | "9-11",
  schemaVersion: string
): JsonSchema {
  const common = {
    schema_version: { type: "string", enum: [schemaVersion] },
    status: {
      type: "string",
      enum: ["ok", "low_signal", "no_match"],
    },
    summary: stringSchema,
    next_step: stringSchema,
    warnings: stringArraySchema,
  };

  if (tier === "1-4") {
    return objectSchema({
      ...common,
      interest_tags: {
        type: "array",
        items: objectSchema({
          industry_id: stringSchema,
          tag: stringSchema,
          why: stringSchema,
          evidence_refs: evidenceRefsSchema,
        }),
      },
      activity_ids: stringArraySchema,
    });
  }

  return objectSchema({
    ...common,
    industries: { type: "array", items: industrySchema },
    hypotheses: {
      type: "array",
      items: hypothesisSchema(tier === "9-11"),
    },
    ...(tier === "9-11" ? { path_note: stringSchema } : {}),
  });
}

export function getRecommendationResponseFormat(
  tier: "1-4" | "5-8" | "9-11"
): JsonSchemaResponseFormat {
  const schemaVersion = promptManifest[tier].schema.split("@")[1];
  if (!schemaVersion) throw new Error(`Не настроена версия схемы для тира ${tier}`);
  return {
    type: "json_schema",
    json_schema: {
      name: `navigator_${tier.replace("-", "_")}`,
      schema: recommendationSchema(tier, schemaVersion),
    },
  };
}
