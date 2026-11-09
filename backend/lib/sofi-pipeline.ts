import fs from "node:fs/promises";
import path from "node:path";

import agePolicy from "@/config/age_policy.json";
import llmConfig from "@/config/llm.config.json";
import ragConfig from "@/config/rag.config.json";
import validationPatterns from "@/config/validation_patterns.json";
import promptManifest from "@/prompts/manifest.json";
import { estimateAgeFromGrade, isTrialEligibleForGrade } from "@/lib/ai/age";
import { getFromCache, makeCacheKey, setCache } from "@/lib/ai/cache";
import { type NormalizedCatalog, type NormalizedProfession } from "@/lib/ai/catalog";
import { buildDossier } from "@/lib/ai/dossier";
import { buildFallbackResponse } from "@/lib/ai/fallback";
import { generateValidatedResponse } from "@/lib/ai/generate";
import { OpenAICompatibleClient } from "@/lib/ai/llm/openaiCompatible";
import { postprocess, type PostprocessContext } from "@/lib/ai/postprocess";
import { buildPrompt } from "@/lib/ai/prompts";
import { retrieve } from "@/lib/ai/retrieval";
import { extractDigitWhitelist, type ValidationContext } from "@/lib/ai/validate";

import type { PreparedSofiInput, SofiModuleResult } from "./sofi-adapter.ts";

export type SofiPipelineInput = {
  prepared: PreparedSofiInput;
  professions: Array<{ id: string; graphProfessionId: string | null }>;
};

function buildCandidates(
  catalog: NormalizedCatalog,
  grade: number
): Record<string, NormalizedProfession> {
  return Object.fromEntries(
    catalog.professions.map((profession) => {
      const trials = profession.trials.filter((trial) =>
        isTrialEligibleForGrade(trial, grade)
      );
      return [
        profession.profession_id,
        {
          ...profession,
          trials,
          trial_ids: trials.map((trial) => trial.trial_id),
        },
      ];
    })
  );
}

function emptyRetrieval(reason: string) {
  return {
    industryIds: [] as string[],
    professionIds: [] as string[],
    evidence: {} as Record<string, string[]>,
    professionScores: {} as Record<string, number>,
    industryScores: {} as Record<string, number>,
    coverageGap: true,
    uncoveredAnswerRefs: [] as string[],
    mode: "semantic" as const,
    warnings: [reason],
  };
}

function isSofiResult(value: unknown): value is SofiModuleResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "summary" in value &&
      "generation" in value
  );
}

export async function runSofiPipeline(
  input: SofiPipelineInput
): Promise<SofiModuleResult> {
  const { prepared } = input;
  const grade = prepared.student.school_grade;
  const dossier = buildDossier(prepared.rawAnswers, prepared.student);
  const tier = dossier.student.tier;
  const catalogRaw = await fs.readFile(
    path.resolve(process.cwd(), "data/catalog.normalized.json"),
    "utf8"
  );
  const catalog = JSON.parse(catalogRaw) as NormalizedCatalog;
  if (catalog.schema_version !== "hybrid_v2") {
    throw new Error(`Ожидалась схема каталога hybrid_v2, получена ${catalog.schema_version}`);
  }

  const candidates = buildCandidates(catalog, grade);
  const industriesMap = Object.fromEntries(
    catalog.industries.map((industry) => [industry.slug, industry.name])
  );
  const answersMap = Object.fromEntries(
    dossier.answers.map((answer) => [
      answer.ref,
      {
        question: answer.question,
        questionId: answer.questionId,
        questionnaire: answer.questionnaire,
        selected: answer.selected,
      },
    ])
  );

  let retrieval;
  try {
    retrieval = await retrieve(dossier, {
      deadlineAt: Date.now() + ragConfig.embedding_timeout_ms,
    });
  } catch (error) {
    console.warn(
      "[AI] Подбор по каталогу не выполнен; включён retrieval-only fallback.",
      error instanceof Error ? error.message : "unknown error"
    );
    retrieval = emptyRetrieval("retrieval_failed");
  }

  const catalogVersion = catalog.version;
  const promptVersion = promptManifest[tier].prompt;
  const configVersion =
    `${agePolicy.version}+rag-${ragConfig.version}+llm-${llmConfig.version}` +
    `+validation-${validationPatterns.version}`;
  const cacheKey = makeCacheKey(
    [dossier, retrieval],
    promptVersion,
    catalogVersion,
    configVersion
  );
  const cached = getFromCache(cacheKey);
  if (isSofiResult(cached)) {
    return cached;
  }

  const postprocessContext: PostprocessContext = {
    tier,
    dossierRefs: new Set(dossier.answers.map((answer) => answer.ref)),
    answersMap,
    candidatesMap: candidates,
    industriesMap,
    industryIds: new Set(Object.keys(industriesMap)),
    retrievedIndustryIds: new Set(retrieval.industryIds),
    retrievalScores: retrieval.professionScores,
    emptyShare: dossier.emptyShare,
    coverageGap: retrieval.coverageGap,
    inRegion: dossier.student.in_region,
    catalogVersion,
  };

  let result: SofiModuleResult;
  let mode: "llm" | "retrieval_only" = "llm";
  let attempts = 0;

  if (dossier.answers.length < agePolicy.min_signal_answers) {
    mode = "retrieval_only";
    result = await buildFallbackResponse({
      dossier,
      retrieval,
      ctx: postprocessContext,
      catalogVersion,
    });
  } else {
    try {
      const fullCatalog = catalog.professions.length <= ragConfig.full_catalog_threshold;
      const candidateIds = fullCatalog
        ? catalog.professions.map((profession) => profession.profession_id)
        : retrieval.professionIds.slice(0, ragConfig.top_k_professions);
      const industryCandidateIds = fullCatalog
        ? Object.keys(industriesMap)
        : retrieval.industryIds.slice(0, ragConfig.top_k_industries);
      const candidateSet = new Set(candidateIds);
      const tierCandidates = tier === "1-4"
        ? []
        : candidateIds.flatMap((id) => {
            const candidate = candidates[id];
            if (!candidate) return [];
            return [{
              profession_id: candidate.profession_id,
              industry_id: candidate.industry_id,
              name: candidate.name,
              description: tier === "5-8"
                ? candidate.description_5_8
                : candidate.description_9_11,
              key_skills: candidate.key_skills,
              trials: candidate.trials.map((trial) => ({
                trial_id: trial.trial_id,
                title: trial.title,
                description: tier === "5-8"
                  ? trial.description_5_8
                  : trial.description_9_11,
                trial_type: trial.trial_type,
                fit_level: trial.fit_level,
                format: trial.format,
                age_min: trial.age_min,
                age_max: trial.age_max,
                municipality: trial.municipality,
                cost: trial.cost,
                organization: trial.organization,
                skills_checked: trial.skills_checked,
              })),
              programs: candidate.programs.map((program) => ({
                program_id: program.program_id,
                title: program.name,
                level: program.level ?? "",
                fit_level: program.fit_level,
                organization: program.organization,
              })),
            }];
          });
      const juniorActivities = tier === "1-4"
        ? catalog.trials.filter((trial) => isTrialEligibleForGrade({ ...trial, trial_type: trial.trial_type ?? null }, grade))
        : [];
      const validationContext: ValidationContext = {
        tier,
        catalogProfessionIds: new Set(Object.keys(candidates)),
        candidateProfessionIds: candidateSet,
        industryIds: new Set(industryCandidateIds),
        answerRefs: postprocessContext.dossierRefs,
        activityTypes: new Set(juniorActivities.map((trial) => trial.trial_id)),
        professionIndustryById: Object.fromEntries(
          catalog.professions.map((profession) => [
            profession.profession_id,
            profession.industry_id,
          ])
        ),
        candidateTrialIds: Object.fromEntries(
          [...candidateSet].map((id) => [id, new Set(candidates[id]?.trial_ids ?? [])])
        ),
        candidateProgramIds: Object.fromEntries(
          [...candidateSet].map((id) => [id, new Set(candidates[id]?.program_ids ?? [])])
        ),
        candidateTrialFitLevels: Object.fromEntries(
          [...candidateSet].map((id) => [
            id,
            Object.fromEntries(
              (candidates[id]?.trials ?? []).map((trial) => [
                trial.trial_id,
                trial.fit_level ?? null,
              ])
            ),
          ])
        ),
        candidateProgramFitLevels: Object.fromEntries(
          [...candidateSet].map((id) => [
            id,
            Object.fromEntries(
              (candidates[id]?.programs ?? []).map((program) => [
                program.program_id,
                program.fit_level ?? null,
              ])
            ),
          ])
        ),
        digitWhitelist: extractDigitWhitelist(tierCandidates),
      };
      const generated = await generateValidatedResponse(
        new OpenAICompatibleClient(),
        [
          { role: "system", content: await buildPrompt(tier) },
          {
            role: "user",
            content: JSON.stringify({
              student: {
                ...dossier.student,
                estimated_age: estimateAgeFromGrade(grade),
              },
              answers: dossier.answers.map(({ ref, source, question, selected }) => ({
                ref,
                source,
                question,
                selected,
              })),
              constraints: dossier.constraints,
              industries: industryCandidateIds.map((industryId) => ({
                industry_id: industryId,
                name: industriesMap[industryId] ?? industryId,
                hit_strength: retrieval.industryScores[industryId] ?? 0,
              })),
              candidates: tierCandidates,
              activity_types: juniorActivities.map((trial) => ({
                activity_id: trial.trial_id,
                title: trial.title,
                description: trial.description_1_4,
                format: trial.format,
                municipality: trial.municipality,
                cost: trial.cost,
              })),
            }),
          },
        ],
        validationContext,
        Date.now() + llmConfig.total_deadline_ms
      );
      attempts = generated.attempts;
      const data = generated.validation.data;

      if (tier === "1-4" && "interest_tags" in data) {
        result = {
          status: data.interest_tags.length === 0 && data.status === "ok"
            ? "no_match"
            : data.status,
          summary: data.summary,
          industries: [],
          interest_tags: data.interest_tags,
          activity_ids: data.activity_ids,
          hypotheses: [],
          next_step: data.next_step,
          warnings: [...new Set([
            ...dossier.warnings,
            ...retrieval.warnings,
            ...data.warnings,
          ])],
          disclaimer: "Это предварительная подсказка, а не диагностика.",
        };
      } else if ("hypotheses" in data && "industries" in data) {
        const processed = await postprocess(data.hypotheses, postprocessContext);
        const nextStep = "path_note" in data
          ? `${data.path_note} ${data.next_step}`.trim()
          : data.next_step;
        result = {
          status: processed.hypotheses.length === 0 && data.status === "ok"
            ? "no_match"
            : data.status,
          summary: data.summary,
          industries: data.industries.map((industry) => ({
            industryId: industry.industry_id,
            name: industriesMap[industry.industry_id] ?? industry.industry_id,
            why: industry.why,
          })),
          interest_tags: [],
          // Explain each recommendation using the exact answers referenced by the model.
          // Do not infer interests from the profession title or fabricate evidence.
          hypotheses: processed.hypotheses.map((hypothesis) => {
            const selected = [...new Set(hypothesis.evidence.flatMap((item) => item.selected)
              .map((answer) => answer.trim())
              .filter((answer) => answer.length > 2 && answer.length < 160))].slice(0, 3);
            const evidenceReason = selected.length
              ? `В твоих ответах: ${selected.map((answer) => `«${answer}»`).join(", ")}. Это одна из причин рассмотреть профессию «${hypothesis.name}» и проверить интерес на практике.`
              : "";
            return { ...hypothesis, why: evidenceReason || hypothesis.why };
          }),
          next_step: nextStep,
          warnings: [...new Set([
            ...dossier.warnings,
            ...retrieval.warnings,
            ...data.warnings,
            ...processed.warnings,
            ...(retrieval.coverageGap ? ["coverage_gap"] : []),
          ])],
          disclaimer: "Это предварительная подсказка, а не диагностика.",
        };
      } else {
        throw new Error("Ответ LLM не соответствует возрастной схеме");
      }
    } catch (error) {
      mode = "retrieval_only";
      console.warn(
        "[AI] Генерация не прошла; включён retrieval-only fallback.",
        error instanceof Error ? error.message : "unknown error"
      );
      result = await buildFallbackResponse({
        dossier,
        retrieval,
        ctx: postprocessContext,
        catalogVersion,
      });
    }
  }

  result.generation = {
    mode,
    tier,
    promptVersion: mode === "llm" ? promptVersion : result.generation?.promptVersion ?? null,
    catalogVersion,
    configVersion,
    attempts,
  };
  setCache(cacheKey, result);
  return result;
}
