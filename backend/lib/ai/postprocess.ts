import agePolicy from "@/config/age_policy.json" with { type: "json" };
import ragConfig from "@/config/rag.config.json" with { type: "json" };
import riasecLabels from "@/config/riasec_labels.json" with { type: "json" };
import { computeConfidence } from "./confidence";

export interface RawHypothesis {
  profession_id: string;
  industry_id: string;
  why: string;
  evidence_refs: string[];
  activity_links?: { type: string; evidence_refs: string[] }[];
  match_strength: "strong" | "moderate" | "weak";
  what_to_try: string;
  trial_ids: string[];
  program_ids?: string[];
  watch_out?: string;
}

export interface CleanHypothesis extends RawHypothesis {
  rank: number;
  name: string;
  industry_name: string;
  catalogRefs: {
    catalog_version: string | null;
    salary_median_rub: number | null;
    source_id: string | null;
    trials: Record<string, unknown>[];
    programs: Record<string, unknown>[];
  };
  evidence: { question: string; questionId: string; selected: string[] }[];
  confidence?: { level: "high" | "medium" | "low"; signals: string[] };
  explainability?: { riasec_types: string[]; note: string };
}

export interface PostprocessResult {
  hypotheses: CleanHypothesis[];
  warnings: string[];
}

export interface PostprocessContext {
  tier: "1-4" | "5-8" | "9-11";
  dossierRefs: Set<string>;
  answersMap: Record<string, {
    question: string;
    questionId?: string;
    questionnaire?: string;
    selected: string[];
  }>;
  candidatesMap: Record<string, CandidateRecord>;
  industriesMap?: Record<string, string>;
  industryIds: Set<string>;
  retrievedIndustryIds?: Set<string>;
  retrievalScores?: Record<string, number>;
  emptyShare: number;
  coverageGap: boolean;
  inRegion: boolean;
  catalogVersion?: string | null;
  diversify?: boolean;
}

interface CandidateRecord {
  industry_id: string;
  industry_name?: string;
  name: string;
  salary_median_rub?: number | null;
  source_id?: string | null;
  trials?: unknown;
  fit_level?: string | null;
  trial_ids?: unknown[];
  programs?: unknown;
  program_ids?: string[];
  riasec_profile?: Record<string, unknown> | null;
}

function uniqueEvidenceCount(
  refs: string[],
  answersMap: PostprocessContext["answersMap"]
): number {
  return new Set(
    refs.flatMap((ref) => {
      const answer = answersMap[ref];
      if (!answer) return [];
      return [
        answer.questionnaire && answer.questionId
          ? `${answer.questionnaire}:${answer.questionId}`
          : ref,
      ];
    })
  ).size;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ trial_id: item }];
    return item && typeof item === "object" ? [item as Record<string, unknown>] : [];
  });
}

function riasecSimilarity(
  left: CandidateRecord | undefined,
  right: CandidateRecord | undefined
): number {
  const leftProfile = left?.riasec_profile;
  const rightProfile = right?.riasec_profile;
  if (!leftProfile || !rightProfile) return 0;

  const dimensions = new Set([...Object.keys(leftProfile), ...Object.keys(rightProfile)]);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const dimension of dimensions) {
    const leftValue = leftProfile[dimension];
    const rightValue = rightProfile[dimension];
    const a = typeof leftValue === "number" ? leftValue : 0;
    const b = typeof rightValue === "number" ? rightValue : 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

function diversifyWithMmr(
  ranked: CleanHypothesis[],
  limit: number,
  candidatesMap: PostprocessContext["candidatesMap"]
): CleanHypothesis[] {
  const lambda = ragConfig.mmr_lambda;
  const remaining = [...ranked];
  const selected: CleanHypothesis[] = [];
  const industryCounts = new Map<string, number>();

  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const [index, candidate] of remaining.entries()) {
      if ((industryCounts.get(candidate.industry_id) ?? 0) >= 2) continue;
      const relevance = 1 / (ranked.indexOf(candidate) + 1);
      const maxSimilarity = selected.reduce(
        (maximum, chosen) =>
          Math.max(
            maximum,
            riasecSimilarity(
              candidatesMap[candidate.profession_id],
              candidatesMap[chosen.profession_id]
            )
          ),
        0
      );
      if (maxSimilarity > 0.95) continue;
      const score = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    industryCounts.set(
      chosen.industry_id,
      (industryCounts.get(chosen.industry_id) ?? 0) + 1
    );
  }
  return selected;
}

export async function postprocess(
  rawHypotheses: RawHypothesis[],
  ctx: PostprocessContext
): Promise<PostprocessResult> {
  const tierConfig = agePolicy.tiers.find((tier) => tier.id === ctx.tier);
  if (!tierConfig) throw new Error(`Тир ${ctx.tier} не найден`);
  if (tierConfig.show.professions === false) {
    return { hypotheses: [], warnings: rawHypotheses.length ? ["professions_hidden_by_age_policy"] : [] };
  }

  const warnings = new Set<string>();
  const enriched: CleanHypothesis[] = [];

  for (const hypothesis of rawHypotheses) {
    const candidate = ctx.candidatesMap[hypothesis.profession_id];
    if (
      !candidate ||
      candidate.industry_id !== hypothesis.industry_id ||
      !ctx.industryIds.has(hypothesis.industry_id) ||
      !hypothesis.evidence_refs.every((ref) => ctx.dossierRefs.has(ref))
    ) {
      continue;
    }

    const showSalary = tierConfig.show.salary === true;
    const showPrograms = tierConfig.show.programs === true;
    const allowedTrialIds = new Set(
      asRecords(candidate.trials ?? candidate.trial_ids)
        .map((trial) => trial.trial_id)
        .filter((id): id is string => typeof id === "string")
    );
    const allowedProgramIds = new Set(
      asRecords(candidate.programs ?? candidate.program_ids)
        .map((program) => program.program_id)
        .filter((id): id is string => typeof id === "string")
    );
    const trialIds = hypothesis.trial_ids.filter((id) => allowedTrialIds.has(id));
    const programIds = showPrograms
      ? (hypothesis.program_ids ?? []).filter((id) => allowedProgramIds.has(id))
      : [];
    const trials = asRecords(candidate.trials ?? candidate.trial_ids)
      .filter((trial) => trialIds.includes(String(trial.trial_id)));
    const programs = asRecords(candidate.programs ?? candidate.program_ids)
      .filter((program) => programIds.includes(String(program.program_id)));

    if (
      trials.some((trial) => trial.fit_level === "смежная") ||
      programs.some((program) => program.fit_level === "смежная")
    ) {
      warnings.add("related_trial_warning");
    }
    if (trials.some((trial) => trial.format === "очно")) {
      warnings.add("trials_offline_only");
      if (!ctx.inRegion) warnings.add("trials_only_offline_out_of_region");
    }

    const evidence = hypothesis.evidence_refs
      .map((ref) => ctx.answersMap[ref])
      .filter((answer): answer is NonNullable<typeof answer> => Boolean(answer))
      .map((answer) => ({
        question: answer.question,
        questionId: answer.questionId ?? "",
        selected: answer.selected,
      }));

    const confidenceLevel = computeConfidence({
      match_strength: hypothesis.match_strength,
      agreement_levels: (
        (ctx.retrievalScores?.[hypothesis.profession_id] !== undefined ? 1 : 0) +
          ((ctx.retrievedIndustryIds ?? ctx.industryIds).has(candidate.industry_id) ? 1 : 0)
      ) as 0 | 1 | 2,
      independent_answers: uniqueEvidenceCount(hypothesis.evidence_refs, ctx.answersMap),
      empty_share: ctx.emptyShare,
      coverage_gap: ctx.coverageGap,
    });

    const topTypes = Object.entries(candidate.riasec_profile ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code]) => {
        const label = riasecLabels.labels[code as keyof typeof riasecLabels.labels];
        if (!label) return code;
        return tierConfig.show.riasec === "letters+words"
          ? `${label.code} (${label.word})`
          : label.word;
      });

    const confidenceSignals = [
      `match_${hypothesis.match_strength}`,
      ...(ctx.retrievalScores?.[hypothesis.profession_id] !== undefined ? ["profession_retrieval_agreement"] : []),
      ...((ctx.retrievedIndustryIds ?? ctx.industryIds).has(candidate.industry_id)
        ? ["industry_retrieval_agreement"]
        : []),
      ...(uniqueEvidenceCount(hypothesis.evidence_refs, ctx.answersMap) >= 2 ? ["multiple_independent_answers"] : []),
      ...(ctx.emptyShare > 0.3 ? ["many_empty_answers"] : []),
      ...(ctx.coverageGap ? ["coverage_gap"] : []),
    ];

    enriched.push({
      ...hypothesis,
      trial_ids: trialIds,
      ...(showPrograms ? { program_ids: programIds } : {}),
      rank: 0,
      name: candidate.name,
      industry_name: candidate.industry_name ?? ctx.industriesMap?.[candidate.industry_id] ?? candidate.industry_id,
      catalogRefs: {
        catalog_version: ctx.catalogVersion ?? null,
        salary_median_rub: showSalary ? candidate.salary_median_rub ?? null : null,
        source_id: showSalary ? candidate.source_id ?? null : null,
        trials,
        programs,
      },
      evidence,
      ...(tierConfig.show.confidence === false
        ? {}
        : { confidence: { level: confidenceLevel, signals: confidenceSignals } }),
      ...(tierConfig.show.riasec === "none"
        ? {}
        : {
            explainability: {
              riasec_types: topTypes,
              note: "Это описание профессии, а не твой результат",
            },
          }),
    });
  }

  const strengthRank = { strong: 3, moderate: 2, weak: 1 };
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  enriched.sort((a, b) => {
    const strengthDiff = strengthRank[b.match_strength] - strengthRank[a.match_strength];
    if (strengthDiff !== 0) return strengthDiff;

    const scoreDiff =
      (ctx.retrievalScores?.[b.profession_id] ?? 0) -
      (ctx.retrievalScores?.[a.profession_id] ?? 0);
    if (Math.abs(scoreDiff) > ragConfig.epsilon) return scoreDiff;

    const confidenceDiff =
      confidenceRank[b.confidence?.level ?? "low"] -
      confidenceRank[a.confidence?.level ?? "low"];
    if (confidenceDiff !== 0) return confidenceDiff;
    return a.profession_id.localeCompare(b.profession_id);
  });

  const maxPerIndustry = 2;
  const ranked = ragConfig.enable_riasec_mmr && ctx.diversify !== false
    ? diversifyWithMmr(enriched, tierConfig.max_items, ctx.candidatesMap)
    : enriched.filter((hypothesis, index, list) =>
        list
          .slice(0, index + 1)
          .filter((prior) => prior.industry_id === hypothesis.industry_id)
          .length <= maxPerIndustry
      );
  const hypotheses = ranked.slice(0, tierConfig.max_items);
  hypotheses.forEach((hypothesis, index) => {
    hypothesis.rank = index + 1;
  });
  if (rawHypotheses.length > 0 && hypotheses.length === 0) warnings.add("no_valid_hypotheses");

  return { hypotheses, warnings: [...warnings] };
}
