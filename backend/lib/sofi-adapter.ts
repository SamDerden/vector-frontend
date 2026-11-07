import agePolicy from "../config/age_policy.json" with { type: "json" };

import type { RawAnswer, StudentContext } from "./ai/dossier.ts";
import { isUuid } from "./legacy-ai.ts";
import { aiResponseSchema } from "./schemas.ts";

export const MATCH_STRENGTH_RANK = {
  strong: 3,
  moderate: 2,
  weak: 1,
} as const;

export type MatchStrength = keyof typeof MATCH_STRENGTH_RANK;
export type AgeTier = "1-4" | "5-8" | "9-11";

const legacyHypothesisSchema = aiResponseSchema.shape.hypotheses.element;

export class MissingSchoolGradeError extends Error {
  readonly httpStatus = 409;

  constructor() {
    super("School grade is required before Sofi recommendations");
    this.name = "MissingSchoolGradeError";
  }
}

export type AnswerValue =
  | string
  | number
  | boolean
  | string[]
  | { values: string[]; customText?: string };

export type BackendProfile = {
  schoolGrade: number | null | undefined;
  municipality?: string | null;
};

export type BackendDiagnosticAnswer = {
  questionId: string;
  answer: AnswerValue;
  questionnaire?: string | null;
};

export type BackendClarificationAnswer = {
  questionId: string;
  answer: AnswerValue;
};

export type NormalizedAnswer = {
  questionId: string;
  source: "diagnostic" | "clarification";
  questionnaire: string;
  original: AnswerValue;
  selected: string[];
};

export type PreparedSofiInput = {
  tier: AgeTier;
  student: StudentContext;
  rawAnswers: RawAnswer[];
  normalizedAnswers: NormalizedAnswer[];
};

export type ProfessionCatalogRow = {
  id: string;
  graphProfessionId: string | null;
};

export type ProfessionMapping =
  | {
      status: "mapped";
      catalogProfessionId: string;
      professionId: string;
    }
  | {
      status: "unmapped" | "ambiguous";
      catalogProfessionId: string;
      professionId: null;
    };

export type SofiHypothesisSource = {
  profession_id?: string;
  professionId?: string;
  name?: string;
  title?: string;
  professionName?: string;
  why?: string;
  reason?: string;
  explanation?: string;
  match_strength?: MatchStrength;
  matchStrength?: MatchStrength;
  evidence_refs?: string[];
  evidenceRefs?: string[];
  trial_ids?: string[];
  trialIds?: string[];
  program_ids?: string[];
  programIds?: string[];
  what_to_try?: string;
  whatToTry?: string;
};

export type SofiGenerationMeta = {
  mode: "llm" | "retrieval_only";
  tier: AgeTier;
  promptVersion: string | null;
  catalogVersion: string | null;
  configVersion?: string | null;
  attempts?: number;
};

export type SofiModuleResult = {
  status?: string;
  summary?: string;
  next_step?: string;
  nextStep?: string;
  warnings?: string[];
  disclaimer?: string;
  interest_tags?: unknown[];
  interestTags?: unknown[];
  activity_ids?: string[];
  activityIds?: string[];
  industries?: unknown[];
  hypotheses?: SofiHypothesisSource[];
  generation?: SofiGenerationMeta;
};

export type AdaptedHypothesis = {
  professionId: string;
  title: string;
  reason: string;
  fitScore: number;
  scoreKind: "relative_ranking";
};

export type SofiAiPayloadHypothesis = {
  catalogProfessionId: string;
  professionId: string | null;
  mapping: ProfessionMapping["status"];
  title: string;
  reason: string;
  matchStrength: MatchStrength | null;
  fitScore: number | null;
  scoreKind: "relative_ranking";
  evidenceRefs: string[];
  trialIds: string[];
  programIds: string[];
  legacyCompatible: boolean;
  whatToTry?: string;
};

export type SofiAiPayload = {
  status: string | null;
  summary: string | null;
  nextStep: string | null;
  disclaimer: string | null;
  warnings: string[];
  interestTags: unknown[];
  activityIds: string[];
  industries: unknown[];
  generation: {
    mode: "llm" | "retrieval_only";
    tier: AgeTier;
    promptVersion: string | null;
    catalogVersion: string | null;
    configVersion: string | null;
    attempts: number;
  } | null;
  hypotheses: SofiAiPayloadHypothesis[];
};

export type AdaptedSofiResult = {
  hypotheses: AdaptedHypothesis[];
  unmapped: ProfessionMapping[];
  fallback: boolean;
  aiPayload: SofiAiPayload;
};

export function tierForGrade(grade: number): AgeTier {
  for (const tier of agePolicy.tiers) {
    if (grade >= tier.grade[0] && grade <= tier.grade[1] && isAgeTier(tier.id)) {
      return tier.id;
    }
  }
  return "5-8";
}

function isAgeTier(value: string): value is AgeTier {
  return value === "1-4" || value === "5-8" || value === "9-11";
}

export function requireSchoolGrade(
  schoolGrade: number | null | undefined
): number {
  if (typeof schoolGrade !== "number" || !Number.isFinite(schoolGrade)) {
    throw new MissingSchoolGradeError();
  }
  return schoolGrade;
}

export function selectedStringsFromAnswer(answer: AnswerValue): string[] {
  if (typeof answer === "boolean") {
    return [answer ? "true" : "false"];
  }
  if (typeof answer === "number") {
    return [String(answer)];
  }
  if (typeof answer === "string") {
    return [answer];
  }
  if (Array.isArray(answer)) {
    return answer.map((item) => item.trim()).filter((item) => item.length > 0);
  }

  const selected = answer.values
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const customText = answer.customText?.trim();
  if (customText) {
    selected.push(customText);
  }
  return selected;
}

export function prepareSofiInput(input: {
  profile: BackendProfile;
  diagnosticAnswers: BackendDiagnosticAnswer[];
  clarificationAnswers?: BackendClarificationAnswer[];
}): PreparedSofiInput {
  const grade = requireSchoolGrade(input.profile.schoolGrade);
  const municipality = input.profile.municipality?.trim() ?? "";
  const normalizedAnswers: NormalizedAnswer[] = [
    ...input.diagnosticAnswers.map((item) => ({
      questionId: item.questionId,
      source: "diagnostic" as const,
      questionnaire: item.questionnaire?.trim() ?? "",
      original: item.answer,
      selected: selectedStringsFromAnswer(item.answer),
    })),
    ...(input.clarificationAnswers ?? []).map((item) => ({
      questionId: item.questionId,
      source: "clarification" as const,
      questionnaire: "agent_clarification",
      original: item.answer,
      selected: selectedStringsFromAnswer(item.answer),
    })),
  ];

  const rawAnswers: RawAnswer[] = normalizedAnswers.map((item) => ({
    questionnaire: item.questionnaire,
    question_id: item.questionId,
    answer: item.selected,
  }));

  return {
    tier: tierForGrade(grade),
    student: { school_grade: grade, municipality },
    rawAnswers,
    normalizedAnswers,
  };
}

export function mapCatalogProfessionId(
  catalogProfessionId: string,
  rows: ProfessionCatalogRow[]
): ProfessionMapping {
  const key = catalogProfessionId.trim().toLowerCase();
  const matches = rows.filter(
    (row) =>
      typeof row.graphProfessionId === "string" &&
      row.graphProfessionId.trim().toLowerCase() === key &&
      isUuid(row.id)
  );

  if (matches.length === 1) {
    return {
      status: "mapped",
      catalogProfessionId,
      professionId: matches[0].id,
    };
  }

  return {
    status: matches.length > 1 ? "ambiguous" : "unmapped",
    catalogProfessionId,
    professionId: null,
  };
}

function catalogProfessionIdOf(hypothesis: SofiHypothesisSource): string {
  return hypothesis.profession_id ?? hypothesis.professionId ?? "";
}

function titleOf(hypothesis: SofiHypothesisSource): string {
  return hypothesis.title ?? hypothesis.name ?? hypothesis.professionName ?? "";
}

function reasonOf(hypothesis: SofiHypothesisSource): string {
  return hypothesis.reason ?? hypothesis.why ?? hypothesis.explanation ?? "";
}

function matchStrengthOf(
  hypothesis: SofiHypothesisSource
): MatchStrength | null {
  return hypothesis.match_strength ?? hypothesis.matchStrength ?? null;
}

function evidenceRefsOf(hypothesis: SofiHypothesisSource): string[] {
  return hypothesis.evidence_refs ?? hypothesis.evidenceRefs ?? [];
}

function stringIds(value: string[] | undefined): string[] {
  return value ?? [];
}

export function adaptSofiResult(
  result: SofiModuleResult,
  professions: ProfessionCatalogRow[]
): AdaptedSofiResult {
  const hypotheses: AdaptedHypothesis[] = [];
  const unmapped: ProfessionMapping[] = [];
  const payloadHypotheses: SofiAiPayloadHypothesis[] = [];

  for (const source of result.hypotheses ?? []) {
    const catalogProfessionId = catalogProfessionIdOf(source);
    const mapping = mapCatalogProfessionId(catalogProfessionId, professions);
    const title = titleOf(source).trim();
    const reason = reasonOf(source).trim();
    const matchStrength = matchStrengthOf(source);
    const fitScore = matchStrength ? MATCH_STRENGTH_RANK[matchStrength] : null;
    const evidenceRefs = evidenceRefsOf(source);
    const trialIds = stringIds(source.trial_ids ?? source.trialIds);
    const programIds = stringIds(source.program_ids ?? source.programIds);

    let legacyCompatible = false;
    if (mapping.status === "mapped" && fitScore !== null) {
      const parsed = legacyHypothesisSchema.safeParse({
        professionId: mapping.professionId,
        title: title.slice(0, 300),
        reason: reason.slice(0, 1500),
        fitScore,
      });
      if (parsed.success) {
        hypotheses.push({
          ...parsed.data,
          scoreKind: "relative_ranking",
        });
        legacyCompatible = true;
      }
    } else if (mapping.status !== "mapped") {
      unmapped.push(mapping);
    }

    payloadHypotheses.push({
      catalogProfessionId,
      professionId: mapping.professionId,
      mapping: mapping.status,
      title,
      reason,
      matchStrength,
      fitScore,
      scoreKind: "relative_ranking",
      evidenceRefs,
      trialIds,
      programIds,
      whatToTry: source.whatToTry ?? source.what_to_try,
      legacyCompatible,
    });
  }

  const generation = result.generation
    ? {
        mode: result.generation.mode,
        tier: result.generation.tier,
        promptVersion: result.generation.promptVersion,
        catalogVersion: result.generation.catalogVersion,
        configVersion: result.generation.configVersion ?? null,
        attempts: result.generation.attempts ?? 0,
      }
    : null;

  return {
    hypotheses,
    unmapped,
    fallback: generation?.mode === "retrieval_only",
    aiPayload: {
      status: result.status ?? null,
      summary: result.summary ?? null,
      nextStep: result.nextStep ?? result.next_step ?? null,
      disclaimer: result.disclaimer ?? null,
      warnings: result.warnings ?? [],
      interestTags: result.interestTags ?? result.interest_tags ?? [],
      activityIds: result.activityIds ?? result.activity_ids ?? [],
      industries: result.industries ?? [],
      generation,
      hypotheses: payloadHypotheses,
    },
  };
}
