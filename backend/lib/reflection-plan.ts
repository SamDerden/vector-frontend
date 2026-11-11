import { z } from "zod";

import { reflectionSchema } from "./schemas.ts";

export const reflectionBodySchema = reflectionSchema.omit({ sessionId: true }).extend({
  journeyStep: z.number().int().min(1).max(4).optional(),
  stage: z.enum(["final"]).optional(),
});

export type ReflectionBody = z.infer<typeof reflectionBodySchema>;

export const REFLECTION_LEGACY_INSERT = `INSERT INTO reflections
       (session_id, recommendation_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, created_at`;

export const REFLECTION_JOURNEY_INSERT = `INSERT INTO reflections
       (session_id, recommendation_id, rating, comment, journey_step, created_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING id, created_at`;

export const REFLECTION_READ_SQL = `SELECT id, recommendation_id, rating, comment, created_at, journey_step
       FROM reflections
       WHERE session_id = $1
       ORDER BY created_at DESC`;

export const REFLECTION_READ_LEGACY_SQL = `SELECT id, recommendation_id, rating, comment, created_at
       FROM reflections
       WHERE session_id = $1
       ORDER BY created_at DESC`;

export type AgeTier = "1-4" | "5-8" | "9-11";

export function ageTierForGrade(grade: number | null): AgeTier | null {
  if (grade == null || !Number.isInteger(grade)) return null;
  if (grade >= 1 && grade <= 4) return "1-4";
  if (grade >= 5 && grade <= 8) return "5-8";
  if (grade >= 9 && grade <= 11) return "9-11";
  return null;
}

export function resolveJourneyStep(body: { journeyStep?: number; stage?: "final" }): number | undefined {
  if (body.stage === "final" && body.journeyStep !== undefined && body.journeyStep !== 4) return Number.NaN;
  if (body.journeyStep !== undefined) return body.journeyStep;
  if (body.stage === "final") return 4;
  return undefined;
}

export function presentReflection(row: Record<string, unknown>) {
  const base = {
    id: row.id,
    recommendation_id: row.recommendation_id,
    rating: row.rating,
    comment: row.comment,
    created_at: row.created_at,
  };
  if (typeof row.journey_step !== "number") return base;
  return {
    ...base,
    journeyStep: row.journey_step,
    stage: row.journey_step === 4 ? "final" as const : "progress" as const,
  };
}

export function reflectionWrite(input: {
  sessionId: string;
  body: ReflectionBody;
  schoolGrade: number | null;
}):
  | { ok: false; status: 409 | 422; error: string }
  | {
      ok: true;
      sql: string;
      params: unknown[];
      journeyStep?: number;
      ageTier: AgeTier | null;
    } {
  const step = resolveJourneyStep(input.body);
  if (Number.isNaN(step)) {
    return { ok: false, status: 422, error: "Final reflection must use journey step 4" };
  }
  const recommendationId = input.body.recommendationId ?? null;
  const comment = input.body.comment ?? null;
  if (step === undefined) {
    return {
      ok: true,
      sql: REFLECTION_LEGACY_INSERT,
      params: [input.sessionId, recommendationId, input.body.rating, comment],
      ageTier: ageTierForGrade(input.schoolGrade),
    };
  }
  if (input.schoolGrade != null && ageTierForGrade(input.schoolGrade) == null) {
    return { ok: false, status: 409, error: "School grade is outside the supported range" };
  }
  return {
    ok: true,
    sql: REFLECTION_JOURNEY_INSERT,
    params: [input.sessionId, recommendationId, input.body.rating, comment, step],
    journeyStep: step,
    ageTier: ageTierForGrade(input.schoolGrade),
  };
}
