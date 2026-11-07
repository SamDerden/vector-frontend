import { z } from "zod";

export const ConfidenceLevelSchema = z.enum(["low", "medium", "high"]);

export const ConfidenceProfileSchema = z.object({
  before: ConfidenceLevelSchema,
  after: ConfidenceLevelSchema.nullable(),
  delta: z.number().int().min(-2).max(2).nullable(),
}).strict().superRefine((confidence, context) => {
  if (confidence.after === null && confidence.delta !== null) {
    context.addIssue({
      code: "custom",
      path: ["delta"],
      message: "delta должен быть null, пока after не задан",
    });
  }
  if (confidence.after !== null) {
    const levels = { low: 0, medium: 1, high: 2 } as const;
    const expectedDelta = levels[confidence.after] - levels[confidence.before];
    if (confidence.delta !== expectedDelta) {
      context.addIssue({
        code: "custom",
        path: ["delta"],
        message: `ожидалась delta ${expectedDelta}`,
      });
    }
  }
});

export const ProfilePreferencesSchema = z.object({
  confidence: ConfidenceProfileSchema.optional(),
}).passthrough();

const ScoreSchema = z.number().min(0).max(1);
const RiasecScoresSchema = z.object({
  R: ScoreSchema,
  I: ScoreSchema,
  A: ScoreSchema,
  S: ScoreSchema,
  E: ScoreSchema,
  C: ScoreSchema,
}).strict();
const ValueScoresSchema = z.object({
  V1: ScoreSchema,
  V2: ScoreSchema,
  V3: ScoreSchema,
  V4: ScoreSchema,
  V5: ScoreSchema,
  V6: ScoreSchema,
}).strict();
const ExperienceTagsSchema = z.array(z.string().min(1));
const ConstraintsSchema = z.object({
  format: z.enum(["offline", "online", "any"]).nullable().optional(),
  hours_per_week: z.enum(["до 2 часов", "2-5", "больше 5"]).nullable().optional(),
  municipality: z.string().nullable().optional(),
  budget: z.enum(["free_only", "paid_ok"]).nullable().optional(),
  helper_mode: z.boolean().nullable().optional(),
}).passthrough();

const TestExpectationsSchema = z.object({
  holland_code: z.string().regex(/^[RIASEC]{1,3}$/).nullable(),
  coverage_gap_interest: z.string().nullable(),
  coverage_gap_expected: z.boolean(),
  clarity_band: z.enum(["high", "low"]),
}).strict();

const ProfileBase = z.object({
  profile_id: z.string().min(1),
  grade: z.number().int().min(1).max(11),
  municipality: z.string().min(1),
  preferences: ProfilePreferencesSchema,
  experience_tags: ExperienceTagsSchema,
  test_expectations: TestExpectationsSchema.optional(),
});

const Profile14Schema = ProfileBase.extend({
  track: z.literal("1-4"),
  grade: z.number().int().min(1).max(4),
  directions: z.object({
    tech: ScoreSchema,
    creative: ScoreSchema,
    help: ScoreSchema,
    nature: ScoreSchema,
  }).strict(),
  riasec_scores: z.null(),
  work_style_scores: z.null(),
  values_scores: z.null(),
  constraints: z.null(),
  profile_clarity: z.null(),
}).strict().superRefine((profile, context) => {
  for (const [index, tag] of profile.experience_tags.entries()) {
    if (!/^(club_current|club_wanted|club_declined):(tech|creative|help|nature)$/.test(tag)) {
      context.addIssue({
        code: "custom",
        path: ["experience_tags", index],
        message: "Для трека 1-4 тег должен использовать направление из методологии",
      });
    }
  }
});

const WorkStyle58Schema = z.object({
  team: ScoreSchema,
  structure: ScoreSchema,
  pace: ScoreSchema,
  breadth: ScoreSchema,
}).strict();

const Profile58Schema = ProfileBase.extend({
  track: z.literal("5-8"),
  grade: z.number().int().min(5).max(8),
  directions: z.null(),
  riasec_scores: RiasecScoresSchema,
  work_style_scores: WorkStyle58Schema,
  values_scores: z.null(),
  constraints: ConstraintsSchema,
  profile_clarity: ScoreSchema,
}).strict();

const Profile911Schema = ProfileBase.extend({
  track: z.literal("9-11"),
  grade: z.number().int().min(9).max(11),
  directions: z.null(),
  riasec_scores: RiasecScoresSchema,
  work_style_scores: z.object({
    team: ScoreSchema,
    structure: ScoreSchema,
    pace: ScoreSchema,
    breadth: ScoreSchema,
  }).strict(),
  values_scores: ValueScoresSchema,
  constraints: ConstraintsSchema,
  profile_clarity: ScoreSchema,
}).strict();

export const InterestProfileSchema = z.discriminatedUnion("track", [
  Profile14Schema,
  Profile58Schema,
  Profile911Schema,
]);

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;
export type ConfidenceProfile = z.infer<typeof ConfidenceProfileSchema>;
export type ProfilePreferences = z.infer<typeof ProfilePreferencesSchema>;
export type InterestProfile = z.infer<typeof InterestProfileSchema>;

const confidenceRank: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function confidenceDelta(
  before: ConfidenceLevel,
  after: ConfidenceLevel
): number {
  return confidenceRank[after] - confidenceRank[before];
}

export function confidenceToneInstruction(before: ConfidenceLevel): string {
  const instructions: Record<ConfidenceLevel, string> = {
    low: "Будь особенно поддерживающим: не торопи ученика с выбором и предложи простой шаг для пробы.",
    medium: "Поддержи сравнение вариантов без давления и предложи проверить интерес на практике.",
    high: "Уважай выбранное направление, но предложи проверить его практикой и рассмотреть соседний вариант.",
  };
  return instructions[before];
}
