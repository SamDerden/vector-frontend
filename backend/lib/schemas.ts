import { z } from "zod";

export const sessionIdSchema = z.string().uuid();

export const trackSchema = z.object({
  sessionId: z.string().uuid(),
  trackType: z.enum(["explore", "interests", "known_direction"]),
  schoolGrade: z.number().int().min(1).max(11).optional(),
  confidenceBefore: z.enum(["low", "medium", "high"]).optional(),
});

const diagnosticAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(100),
  answer: z.union([
    z.string().trim().min(1).max(1000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  ]),
});

function uniqueQuestionIds<T extends { questionId: string }>(
  answers: T[],
  ctx: z.RefinementCtx
) {
  const seen = new Set<string>();

  answers.forEach((item, index) => {
    if (seen.has(item.questionId)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "questionId"],
        message: "Duplicate questionId",
      });
    }

    seen.add(item.questionId);
  });
}

export const diagnosticSchema = z.object({
  sessionId: z.string().uuid(),
  answers: z
    .array(diagnosticAnswerSchema)
    .min(1)
    .max(100)
    .superRefine(uniqueQuestionIds),
  clarificationAnswers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1).max(100),
        answer: z.union([
          z.string().trim().min(1).max(1000),
          z.number().finite(),
          z.boolean(),
          z.array(z.string().trim().min(1).max(200)).min(1).max(10),
          z.object({
            values: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
            customText: z.string().trim().min(1).max(500).optional(),
          }),
        ]),
      })
    )
    .min(1)
    .max(6)
    .superRefine(uniqueQuestionIds)
    .optional(),
});

export const clarificationAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(100),
  answer: z.union([
    z.string().trim().min(1).max(1000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().trim().min(1).max(200)).min(1).max(10),
    z.object({
      values: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
      customText: z.string().trim().min(1).max(500).optional(),
    }),
  ]),
});

export const clarificationSubmitSchema = z.object({
  answers: z
    .array(clarificationAnswerSchema)
    .min(1)
    .max(6)
    .superRefine(uniqueQuestionIds),
});

export const generateRecommendationsSchema = z.object({
  clarificationAnswers: clarificationSubmitSchema.shape.answers.optional(),
});

export const reflectionSchema = z.object({
  sessionId: z.string().uuid(),
  recommendationId: z.string().uuid().optional(),
  rating: z.enum(["useful", "unsure", "not_useful"]),
  comment: z.string().max(1000).optional(),
});

export const aiResponseSchema = z.object({
  summary: z.string().min(1).max(3000),
  hypotheses: z
    .array(
      z.object({
        professionId: z.string().uuid(),
        title: z.string().min(1).max(300),
        reason: z.string().min(1).max(1500),
        fitScore: z.coerce.number().min(0).max(100).optional().default(0),
      })
    )
    .min(1)
    .max(5),
  trialIds: z.array(z.string().uuid()).max(10).default([]),
  nextStep: z.string().trim().min(1).max(1500),
  pathways: z
    .object({
      clubProgramId: z.string().uuid().nullable().optional(),
      collegeProgramId: z.string().uuid().nullable().optional(),
      onlineCourseProgramId: z.string().uuid().nullable().optional(),
    })
    .optional(),
});
