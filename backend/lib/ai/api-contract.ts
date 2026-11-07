import { CleanHypothesis } from "./postprocess";

export function buildApiHypothesis(hypothesis: CleanHypothesis) {
  return {
    rank: hypothesis.rank,
    professionId: hypothesis.profession_id,
    professionName: hypothesis.name,
    industry: {
      id: hypothesis.industry_id,
      name: hypothesis.industry_name,
    },
    explanation: hypothesis.why,
    evidence: hypothesis.evidence.map((item) => ({
      questionId: item.questionId,
      question: item.question,
      selected: item.selected,
    })),
    ...(hypothesis.confidence ? { confidence: hypothesis.confidence } : {}),
    ...(hypothesis.explainability
      ? {
          explainability: {
            professionActivityTypes: hypothesis.explainability.riasec_types,
            note: hypothesis.explainability.note,
          },
        }
      : {}),
    trialIds: hypothesis.trial_ids,
    trialFitLevels: Object.fromEntries(
      hypothesis.catalogRefs.trials.flatMap((trial) =>
        typeof trial.trial_id === "string" && typeof trial.fit_level === "string"
          ? [[trial.trial_id, trial.fit_level]]
          : []
      )
    ),
    programIds: hypothesis.program_ids ?? [],
    trials: hypothesis.catalogRefs.trials,
    programs: hypothesis.catalogRefs.programs,
    catalogRefs: {
      catalogVersion: hypothesis.catalogRefs.catalog_version,
      sourceId: hypothesis.catalogRefs.source_id,
      salaryMedianRub: hypothesis.catalogRefs.salary_median_rub,
      trialIds: hypothesis.trial_ids,
      programIds: hypothesis.program_ids ?? [],
      trials: hypothesis.catalogRefs.trials,
      programs: hypothesis.catalogRefs.programs,
    },
    ...(hypothesis.catalogRefs.salary_median_rub !== null
      ? {
          salary: {
            median_rub: hypothesis.catalogRefs.salary_median_rub,
            source_id: hypothesis.catalogRefs.source_id,
          },
        }
      : {}),
    ...(hypothesis.watch_out ? { watchOut: hypothesis.watch_out } : {}),
  };
}
