import { z } from "zod";
import { Schema14, Schema58, Schema911 } from "./schemas";
import validationPatterns from "@/config/validation_patterns.json" with { type: "json" };
import agePolicy from "@/config/age_policy.json" with { type: "json" };
import promptManifest from "@/prompts/manifest.json" with { type: "json" };

export function extractJson(raw: string): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no_json");
  return withoutFence.slice(start, end + 1);
}

function getSchemaForTier(tier: ValidationContext["tier"]) {
  if (tier === "1-4") return Schema14;
  if (tier === "5-8") return Schema58;
  return Schema911;
}

function getSchemaVersion(tier: ValidationContext["tier"]): string {
  const schema = promptManifest[tier]?.schema;
  const version = schema?.split("@")[1];
  if (!version) throw new Error(`Не настроена версия схемы для тира ${tier}`);
  return version;
}

export interface ValidationContext {
  tier: "1-4" | "5-8" | "9-11";
  catalogProfessionIds: Set<string>;
  candidateProfessionIds: Set<string>;
  industryIds: Set<string>;
  answerRefs: Set<string>;
  activityTypes?: Set<string>;
  professionIndustryById?: Record<string, string>;
  candidateTrialIds?: Record<string, Set<string>>;
  candidateProgramIds?: Record<string, Set<string>>;
  candidateTrialFitLevels?: Record<string, Record<string, string | null>>;
  candidateProgramFitLevels?: Record<string, Record<string, string | null>>;
  digitWhitelist?: string[];
}

export type ValidationResult =
  | { success: true; data: z.infer<typeof Schema14> | z.infer<typeof Schema58> | z.infer<typeof Schema911> }
  | { success: false; errors: string[] };

export function extractDigitWhitelist(candidates: unknown[]): string[] {
  const names = new Set<string>();
  const addIfDigitBearing = (value: unknown) => {
    if (typeof value === "string" && /\d/.test(value.trim())) {
      names.add(value.trim());
    }
  };

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    addIfDigitBearing(record.name);

    for (const trial of Array.isArray(record.trials) ? record.trials : []) {
      if (trial && typeof trial === "object") {
        addIfDigitBearing((trial as Record<string, unknown>).title);
      }
    }
    for (const program of Array.isArray(record.programs) ? record.programs : []) {
      if (program && typeof program === "object") {
        const programRecord = program as Record<string, unknown>;
        addIfDigitBearing(programRecord.title ?? programRecord.name);
      }
    }
  }

  return [...names].sort((left, right) => right.length - left.length);
}

function stripWhitelistedDigitTerms(text: string, whitelist: string[]): string {
  return whitelist.reduce((remaining, term) => {
    if (!term) return remaining;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return remaining.replace(new RegExp(escaped, "giu"), "");
  }, text);
}

export function validateResponse(rawText: string, ctx: ValidationContext): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_json";
    return {
      success: false,
      errors: [message === "no_json" ? "no_json: В ответе нет валидного JSON" : `invalid_json: ${message}`],
    };
  }

  const zodResult = getSchemaForTier(ctx.tier).safeParse(parsed);
  if (!zodResult.success) {
    return {
      success: false,
      errors: zodResult.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      ),
    };
  }

  const data = zodResult.data;
  const errors: string[] = [];
  const forbidden = validationPatterns.forbidden_words_by_tier[ctx.tier];
  const caseInsensitive = validationPatterns.forbidden_words_case_insensitive;
  const tierConfig = agePolicy.tiers.find((tier) => tier.id === ctx.tier);
  if (!tierConfig) throw new Error(`Тир ${ctx.tier} не найден в age_policy.json`);
  const maxSentenceWords = tierConfig.max_sentence_words;
  const minItems = tierConfig.min_items;
  const maxItems = tierConfig.max_items;

  if (data.schema_version !== getSchemaVersion(ctx.tier)) {
    errors.push(
      `schema_version: ожидалась ${getSchemaVersion(ctx.tier)}, получена ${data.schema_version}`
    );
  }

  function checkText(text: string, field: string) {
    const normalized = caseInsensitive ? text.toLocaleLowerCase("ru") : text;
    for (const word of forbidden) {
      const forbiddenWord = caseInsensitive ? word.toLocaleLowerCase("ru") : word;
      if (normalized.includes(forbiddenWord)) {
        errors.push(`${field}: запрещенное слово "${word}"`);
      }
    }
    if (/\d/.test(stripWhitelistedDigitTerms(text, ctx.digitWhitelist ?? []))) {
      errors.push(`${field}: содержит цифры, запрещенные в тексте рекомендаций`);
    }
    const sentences = text.match(/[^.!?]+/g) ?? [];
    for (const sentence of sentences) {
      const wordCount = sentence.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount > maxSentenceWords) {
        errors.push(`${field}: предложение превышает ${maxSentenceWords} слов`);
      }
    }
  }

  function checkRefs(refs: string[], field: string) {
    for (const ref of refs) {
      if (!ctx.answerRefs.has(ref)) errors.push(`${field}: выдуманный ref ${ref}`);
    }
  }

  checkText(data.summary, "summary");
  checkText(data.next_step, "next_step");
  data.warnings.forEach((warning, index) => checkText(warning, `warnings[${index}]`));

  if (data.status !== "ok") {
    const hasSuggestions = "hypotheses" in data
      ? data.hypotheses.length > 0
      : data.interest_tags.length > 0;
    if (hasSuggestions) {
      errors.push(`${data.status}: списки рекомендаций должны быть пустыми`);
    }
  } else {
    const suggestionCount = "hypotheses" in data
      ? data.hypotheses.length
      : data.interest_tags.length;
    if (suggestionCount < minItems) {
      errors.push(`status: ok требует минимум ${minItems} рекомендацию`);
    }
    if (suggestionCount > maxItems) {
      errors.push(`status: превышен возрастной лимит ${maxItems} рекомендаций`);
    }
  }

  if ("path_note" in data && typeof data.path_note === "string") {
    checkText(data.path_note, "path_note");
  }

  if ("industries" in data) {
    data.industries.forEach((industry, index) => {
      const field = `industries[${index}]`;
      if (!ctx.industryIds.has(industry.industry_id)) {
        errors.push(`${field}: отрасли ${industry.industry_id} нет в реестре`);
      }
      checkText(industry.why, `${field}.why`);
      checkRefs(industry.evidence_refs, `${field}.evidence_refs`);
    });
  }

  if ("hypotheses" in data) {
    let relatedPathSelected = false;
    data.hypotheses.forEach((hypothesis, index) => {
      const field = `hypotheses[${index}]`;
      if (!ctx.catalogProfessionIds.has(hypothesis.profession_id)) {
        errors.push(`${field}: профессии ${hypothesis.profession_id} нет в каталоге`);
      }
      if (!ctx.candidateProfessionIds.has(hypothesis.profession_id)) {
        errors.push(`${field}: профессии ${hypothesis.profession_id} нет среди кандидатов`);
      }
      if (!ctx.industryIds.has(hypothesis.industry_id)) {
        errors.push(`${field}: отрасли ${hypothesis.industry_id} нет в реестре`);
      }
      const expectedIndustry = ctx.professionIndustryById?.[hypothesis.profession_id];
      if (expectedIndustry && expectedIndustry !== hypothesis.industry_id) {
        errors.push(`${field}: отрасль не соответствует профессии в каталоге`);
      }

      checkText(hypothesis.why, `${field}.why`);
      checkText(hypothesis.what_to_try, `${field}.what_to_try`);
      if ("watch_out" in hypothesis && typeof hypothesis.watch_out === "string") {
        checkText(hypothesis.watch_out, `${field}.watch_out`);
      }
      checkRefs(hypothesis.evidence_refs, `${field}.evidence_refs`);

      const allowedTrials = ctx.candidateTrialIds?.[hypothesis.profession_id];
      if (allowedTrials) {
        for (const id of hypothesis.trial_ids) {
          if (!allowedTrials.has(id)) errors.push(`${field}: проба ${id} отсутствует в каталоге профессии`);
          if (ctx.candidateTrialFitLevels?.[hypothesis.profession_id]?.[id] === "смежная") {
            relatedPathSelected = true;
          }
        }
      }
      if ("program_ids" in hypothesis && Array.isArray(hypothesis.program_ids)) {
        const allowedPrograms = ctx.candidateProgramIds?.[hypothesis.profession_id];
        if (allowedPrograms) {
          for (const id of hypothesis.program_ids) {
            if (!allowedPrograms.has(id)) errors.push(`${field}: программа ${id} отсутствует в каталоге профессии`);
            if (ctx.candidateProgramFitLevels?.[hypothesis.profession_id]?.[id] === "смежная") {
              relatedPathSelected = true;
            }
          }
        }
      }

      hypothesis.activity_links.forEach((link, linkIndex) => {
        const linkField = `${field}.activity_links[${linkIndex}]`;
        if (ctx.activityTypes && !ctx.activityTypes.has(link.type)) {
          errors.push(`${linkField}: вид деятельности ${link.type} отсутствует в каталоге`);
        }
        checkRefs(link.evidence_refs, `${linkField}.evidence_refs`);
      });
    });
    if (relatedPathSelected && !data.warnings.includes("related_trial_warning")) {
      data.warnings.push("related_trial_warning");
    }
  }

  if ("interest_tags" in data) {
    data.interest_tags.forEach((tag, index) => {
      const field = `interest_tags[${index}]`;
      if (!ctx.industryIds.has(tag.industry_id)) {
        errors.push(`${field}: отрасли ${tag.industry_id} нет в реестре`);
      }
      checkText(tag.tag, `${field}.tag`);
      checkText(tag.why, `${field}.why`);
      checkRefs(tag.evidence_refs, `${field}.evidence_refs`);
    });
    data.activity_ids.forEach((id, index) => {
      if (ctx.activityTypes && !ctx.activityTypes.has(id)) {
        errors.push(`activity_ids[${index}]: активность ${id} отсутствует в каталоге`);
      }
    });
  }

  return errors.length > 0
    ? { success: false, errors }
    : { success: true, data };
}
