import agePolicy from "@/config/age_policy.json";
import { Dossier } from "./dossier";
import { PostprocessContext, postprocess } from "./postprocess";
import { RetrievalResult } from "./retrieval";

export interface FallbackOptions {
  dossier: Dossier;
  retrieval: RetrievalResult;
  ctx: PostprocessContext;
  catalogVersion?: string;
}

function firstEvidence(refs: string[], ctx: PostprocessContext) {
  return refs.map((ref) => ctx.answersMap[ref]).find(Boolean);
}

export async function buildFallbackResponse(opts: FallbackOptions) {
  const { dossier, retrieval, ctx } = opts;
  const warnings = new Set(dossier.warnings);
  retrieval.warnings.forEach((warning) => warnings.add(warning));
  warnings.add("llm_fallback_used");
  if (retrieval.coverageGap || ctx.coverageGap) warnings.add("coverage_gap");

  if (dossier.answers.length < agePolicy.min_signal_answers) {
    return {
      status: "low_signal",
      generation: {
        mode: "retrieval_only" as const,
        tier: dossier.student.tier,
        promptVersion: null,
        catalogVersion: opts.catalogVersion ?? null,
        attempts: 0,
      },
      summary: "Пока мало ответов для рекомендаций. Ответь ещё на несколько вопросов.",
      industries: [],
      interest_tags: [],
      activity_ids: [],
      hypotheses: [],
      next_step: "Продолжи анкету, чтобы собрать больше подсказок.",
      warnings: [...warnings],
      disclaimer: "Это предварительная подсказка, а не диагностика.",
    };
  }

  if (dossier.student.tier === "1-4") {
    const interestTags = retrieval.industryIds.slice(0, 3).flatMap((industryId) => {
      const refs = retrieval.evidence[industryId] ?? [];
      const answer = firstEvidence(refs, ctx);
      if (!answer) return [];
      return [{
        industry_id: industryId,
        tag: ctx.industriesMap?.[industryId] ?? industryId,
        why: "Это направление связано с твоими ответами.",
        evidence_refs: refs,
      }];
    });

    return {
      status: interestTags.length ? "fallback" : "no_match",
      generation: {
        mode: "retrieval_only" as const,
        tier: dossier.student.tier,
        promptVersion: null,
        catalogVersion: opts.catalogVersion ?? null,
        attempts: 0,
      },
      summary: interestTags.length
        ? "Вот направления, которые можно исследовать."
        : "Пока не нашли близкое направление. Давай попробуем что-то новое.",
      industries: [],
      interest_tags: interestTags,
      activity_ids: [],
      hypotheses: [],
      next_step: "Обсуди с взрослым, что из этого хочется попробовать.",
      warnings: [...warnings],
      disclaimer: "Это предварительная подсказка, а не диагностика.",
    };
  }

  const rawHypotheses = retrieval.professionIds.slice(0, 5).flatMap((professionId) => {
    const candidate = ctx.candidatesMap[professionId];
    const refs = retrieval.evidence[professionId] ?? [];
    if (!candidate || refs.length === 0) return [];

    const answer = firstEvidence(refs, ctx);
    if (!answer || answer.selected.length === 0) return [];
    return [{
      profession_id: professionId,
      industry_id: candidate.industry_id,
      why: "Эта профессия связана с твоими ответами.",
      evidence_refs: refs,
      activity_links: [],
      match_strength: "moderate" as const,
      what_to_try: "Посмотри, чем занимаются в этой профессии, и выбери небольшую пробу.",
      trial_ids: (candidate.trial_ids ?? []).map((item: unknown) =>
        typeof item === "string" ? item : (item as { trial_id?: string })?.trial_id
      ).filter((item: unknown): item is string => typeof item === "string"),
      ...(dossier.student.tier === "9-11"
        ? {
            program_ids: candidate.program_ids ?? [],
            watch_out: "Проверь, подходит ли тебе повседневная работа в этой сфере.",
          }
        : {}),
    }];
  });

  const { hypotheses, warnings: postprocessWarnings } = await postprocess(rawHypotheses, {
    ...ctx,
    coverageGap: ctx.coverageGap || retrieval.coverageGap,
    retrievalScores: retrieval.professionScores,
  });
  postprocessWarnings.forEach((warning) => warnings.add(warning));

  return {
    status: hypotheses.length ? "fallback" : "no_match",
    generation: {
      mode: "retrieval_only" as const,
      tier: dossier.student.tier,
      promptVersion: null,
      catalogVersion: opts.catalogVersion ?? null,
      attempts: 0,
    },
    summary: hypotheses.length
      ? "Подсказки собраны по ответам и данным каталога."
      : "Пока не нашли близкие варианты в каталоге.",
    industries: retrieval.industryIds.slice(0, 3).map((id) => ({
      industryId: id,
      name: ctx.industriesMap?.[id] ?? id,
      why: "Это направление отмечено среди результатов подбора.",
    })),
    interest_tags: [],
    activity_ids: [],
    hypotheses,
    next_step: hypotheses.length
      ? "Выбери один вариант и узнай о нём больше."
      : "Попробуй ответить на уточняющие вопросы или вернуться позже.",
    warnings: [...warnings],
    disclaimer: "Это предварительная подсказка, а не диагностика.",
  };
}
