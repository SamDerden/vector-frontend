import type { PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";

import questionnaireByGrade from "../config/questionnaire_by_grade.json" with { type: "json" };
import {
  saveClarificationAnswers,
  validateClarificationAnswers,
} from "./clarification.ts";
import { isUuid } from "./legacy-ai.ts";
import { sofiPublicFields } from "./recommendation-view.ts";
import {
  buildPathwayOptions,
  type CatalogOpportunity,
  type PathwayOption,
  type PathwayType,
} from "./pathways.ts";
import { generateRecommendationsSchema } from "./schemas.ts";
import {
  MissingSchoolGradeError,
  adaptSofiResult,
  prepareSofiInput,
  tierForGrade,
  type AnswerValue,
  type ProfessionCatalogRow,
  type SofiModuleResult,
} from "./sofi-adapter.ts";
import type { SofiPipelineInput } from "./sofi-pipeline.ts";

export type DbQueryResult = {
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
};

export type DbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<DbQueryResult>;

export type GenerateDeps = {
  query: DbQuery;
  connect: () => Promise<Pick<PoolClient, "query" | "release"> & {
    query: DbQuery;
  }>;
  pipeline: (input: SofiPipelineInput) => Promise<SofiModuleResult>;
  modelName?: string;
};

export type GenerateOutcome =
  | { ok: true; status: 201; body: Record<string, unknown> }
  | { ok: false; status: number; error: string; details?: unknown };

const JUNIOR_PATHWAYS: PathwayOption[] = (
  ["club", "college", "online_course"] as PathwayType[]
).map((type) => ({
  type,
  available: false,
  note: "Для 1–4 классов показываем направления интересов, без профессий, колледжей и курсов.",
}));

const MIDDLE_PATHWAYS: PathwayOption[] = (
  ["club", "college", "online_course"] as PathwayType[]
).map((type) => ({
  type,
  available: false,
  note: "Для 5–8 классов показываем профессии без колледжей, вузов и образовательных программ.",
}));

function questionnaireName(grade: number): string {
  const slug = questionnaireByGrade.by_grade[
    String(grade) as keyof typeof questionnaireByGrade.by_grade
  ];
  if (!slug) return "";
  return questionnaireByGrade.slug_to_name[
    slug as keyof typeof questionnaireByGrade.slug_to_name
  ] ?? "";
}

function asAnswerValue(value: unknown): AnswerValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "values" in value &&
    Array.isArray((value as { values?: unknown }).values)
  ) {
    return value as AnswerValue;
  }
  return "";
}

function asOpportunity(row: Record<string, unknown>): CatalogOpportunity {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    institution: (row.institution as string | null) ?? null,
    level: (row.level as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    organizationName: (row.organization_name as string | null) ?? null,
    organizationType: (row.organization_type as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    professionIds: Array.isArray(row.profession_ids)
      ? row.profession_ids.map(String)
      : [],
  };
}

export async function executeGenerate(input: {
  sessionId: string;
  body: unknown;
  deps: GenerateDeps;
}): Promise<GenerateOutcome> {
  const parsedBody = generateRecommendationsSchema.safeParse(input.body);
  if (!parsedBody.success) {
    return {
      ok: false,
      status: 422,
      error: "Validation failed",
      details: parsedBody.error.issues,
    };
  }

  const diagnostic = await input.deps.query(
    `SELECT
       d.id,
       json_agg(
         json_build_object(
           'questionId', da.question_id,
           'answer', da.answer,
           'questionnaire', da.questionnaire
         )
         ORDER BY da.created_at
       ) AS answers
     FROM diagnostics d
     JOIN diagnostic_answers da
       ON da.diagnostic_id = d.id
     WHERE d.session_id = $1
     GROUP BY d.id, d.submitted_at
     ORDER BY d.submitted_at DESC
     LIMIT 1`,
    [input.sessionId]
  );
  if (!diagnostic.rowCount) {
    return {
      ok: false,
      status: 409,
      error: "Complete the diagnostic before generating recommendations",
    };
  }

  const diagnosticRow = diagnostic.rows[0];
  if (parsedBody.data.clarificationAnswers) {
    const clarificationErrors = validateClarificationAnswers(
      parsedBody.data.clarificationAnswers
    );
    if (clarificationErrors.length > 0) {
      return {
        ok: false,
        status: 422,
        error: "Invalid clarification answers",
        details: clarificationErrors,
      };
    }

    const client = await input.deps.connect();
    try {
      await client.query("BEGIN");
      await saveClarificationAnswers(client as PoolClient, {
        sessionId: input.sessionId,
        diagnosticId: String(diagnosticRow.id),
        answers: parsedBody.data.clarificationAnswers,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const clarification = await input.deps.query(
    `SELECT
       json_agg(
         json_build_object(
           'questionId', ca.question_id,
           'answer', ca.answer
         )
         ORDER BY ca.created_at
       ) AS answers
     FROM clarifications c
     JOIN clarification_answers ca
       ON ca.clarification_id = c.id
     WHERE c.session_id = $1
     GROUP BY c.id, c.submitted_at
     ORDER BY c.submitted_at DESC
     LIMIT 1`,
    [input.sessionId]
  );

  const profileResult = await input.deps.query(
    `SELECT school_grade, municipality
     FROM profiles
     WHERE session_id = $1`,
    [input.sessionId]
  );
  const profile = profileResult.rows[0];
  const schoolGrade = profile?.school_grade;
  if (typeof schoolGrade !== "number" || !Number.isFinite(schoolGrade)) {
    return {
      ok: false,
      status: 409,
      error: new MissingSchoolGradeError().message,
    };
  }

  const professionsResult = await input.deps.query(
    `SELECT id, title, graph_profession_id
     FROM professions
     WHERE is_active = TRUE
     ORDER BY title ASC`
  );
  if (!professionsResult.rowCount) {
    return { ok: false, status: 503, error: "Profession catalog is empty" };
  }

  const tier = tierForGrade(schoolGrade);
  const diagnosticAnswers = (Array.isArray(diagnosticRow.answers)
    ? diagnosticRow.answers
    : []
  ).map((item) => {
    const answer = item as Record<string, unknown>;
    const storedQuestionnaire = typeof answer.questionnaire === "string"
      ? answer.questionnaire.trim()
      : "";
    return {
      questionId: String(answer.questionId ?? ""),
      answer: asAnswerValue(answer.answer),
      questionnaire: storedQuestionnaire || questionnaireName(schoolGrade),
    };
  });
  const clarificationAnswers = (Array.isArray(clarification.rows[0]?.answers)
    ? clarification.rows[0].answers
    : []
  )
    .slice(0, 6)
    .map((item) => {
      const answer = item as Record<string, unknown>;
      return {
        questionId: String(answer.questionId ?? ""),
        answer: asAnswerValue(answer.answer),
      };
    });
  const professions: ProfessionCatalogRow[] = professionsResult.rows.map((row) => ({
    id: String(row.id),
    graphProfessionId: typeof row.graph_profession_id === "string"
      ? row.graph_profession_id
      : null,
  }));
  const titles = new Map(
    professionsResult.rows.map((row) => [String(row.id), String(row.title ?? "")])
  );

  let prepared;
  try {
    prepared = prepareSofiInput({
      profile: {
        schoolGrade,
        municipality: typeof profile.municipality === "string"
          ? profile.municipality
          : "",
      },
      diagnosticAnswers,
      clarificationAnswers,
    });
  } catch (error) {
    if (error instanceof MissingSchoolGradeError) {
      return { ok: false, status: error.httpStatus, error: error.message };
    }
    throw error;
  }

  let sofiResult: SofiModuleResult;
  try {
    sofiResult = await input.deps.pipeline({ prepared, professions });
  } catch (error) {
    console.error(
      "Sofi pipeline failed",
      error instanceof Error ? error.message : "unknown error"
    );
    return { ok: false, status: 502, error: "AI service request failed" };
  }

  const adapted = adaptSofiResult(sofiResult, professions);
  const junior = tier === "1-4";
  const hypotheses = junior
    ? []
    : adapted.hypotheses.map((item) => ({
        ...item,
        title: titles.get(item.professionId) || item.title,
      }));
  const payload = junior
    ? { ...adapted.aiPayload, hypotheses: [] }
    : adapted.aiPayload;

  let nextStepOptions: PathwayOption[];
  const professionOpportunities = new Map<string, PathwayOption[]>();
  if (junior) {
    nextStepOptions = JUNIOR_PATHWAYS;
  } else if (tier === "5-8") {
    nextStepOptions = MIDDLE_PATHWAYS;
  } else {
    const programsResult = await input.deps.query(
      `SELECT
         ep.id,
         ep.title,
         ep.institution,
         ep.level,
         ep.url,
         o.name AS organization_name,
         o.organization_type,
         o.website,
         o.contact_email,
         COALESCE(
           array_agg(pp.profession_id) FILTER (WHERE pp.profession_id IS NOT NULL),
           '{}'
         ) AS profession_ids
       FROM education_programs ep
       LEFT JOIN organizations o
         ON o.id = ep.organization_id
       LEFT JOIN program_professions pp
         ON pp.program_id = ep.id
       WHERE ep.is_active = TRUE
       GROUP BY ep.id, o.name, o.organization_type, o.website, o.contact_email
       ORDER BY ep.title ASC`
    );
    const selectedIds = new Set(hypotheses.map((item) => item.professionId));
    const opportunities = programsResult.rows
      .map(asOpportunity)
      .filter((item) => item.professionIds.some((id) => selectedIds.has(id)));
    nextStepOptions = buildPathwayOptions({
      opportunities,
      professionIds: [...selectedIds],
    });
    for (const professionId of selectedIds) {
      const linked = opportunities.filter(item => item.professionIds.includes(professionId));
      professionOpportunities.set(professionId, buildPathwayOptions({opportunities:linked,professionIds:[professionId]}).filter(option=>option.available));
    }
  }

  const requestedTrialIds = payload.hypotheses.flatMap((item) => item.trialIds);
  // Graph trial IDs may not be UUIDs. Resolve them against the same normalized
  // catalog that the AI pipeline used, preserving the profession relationship.
  const graphTrialsById = new Map<string, Record<string, unknown>>();
  try {
    const rawCatalog = await fs.readFile(path.resolve(process.cwd(), "data/catalog.normalized.json"), "utf8");
    const catalog = JSON.parse(rawCatalog) as { professions?: Array<{ profession_id: string; trials?: Array<Record<string, unknown>> }> };
    const selected = new Set(payload.hypotheses.map((item) => item.catalogProfessionId));
    for (const profession of catalog.professions ?? []) {
      if (!selected.has(profession.profession_id)) continue;
      for (const trial of profession.trials ?? []) {
        const id = trial.trial_id;
        if (typeof id === "string" && requestedTrialIds.includes(id)) graphTrialsById.set(id, trial);
      }
    }
  } catch (error) {
    console.warn("Could not resolve graph trials", error instanceof Error ? error.message : "unknown error");
  }
  const uuidTrialIds = [...new Set(requestedTrialIds.filter((id) => isUuid(id)))];
  let savedTrialIds: string[] = [];
  let trials: Array<Record<string, unknown>> = [];
  if (!junior && uuidTrialIds.length > 0) {
    const trialsResult = await input.deps.query(
      `SELECT id, title, description, format, duration_minutes, municipality, cost, profession_id, source_url
       FROM professional_trials
       WHERE is_active = TRUE
         AND id = ANY($1::uuid[])`,
      [uuidTrialIds]
    );
    const allowed = new Set(trialsResult.rows.map((row) => String(row.id)));
    savedTrialIds = uuidTrialIds.filter((id) => allowed.has(id));
    trials = trialsResult.rows.filter((row) => savedTrialIds.includes(String(row.id)));
  }
  // Include verified graph records not present in the SQL UUID catalog.
  const dbTrialIds = new Set(trials.map((trial) => String(trial.id)));
  for (const [id, trial] of graphTrialsById) {
    if (dbTrialIds.has(id)) continue;
    trials.push({
      id, title: trial.title ?? "",
      description: trial.description_9_11 ?? trial.description_5_8 ?? "",
      format: trial.format ?? null,
      duration_minutes: trial.duration_minutes ?? null,
      municipality: trial.municipality ?? null,
      cost: trial.cost ?? null,
      source_url: trial.source_url ?? null,
      organization: trial.organization ?? null,
      skills_checked: trial.skills_checked ?? [],
      fit_level: trial.fit_level ?? null,
      source: "graph",
    });
  }

  // Enrich each visible hypothesis with its own verified catalog trials.
  const trialsById = new Map(trials.map((trial) => [String(trial.id), trial]));
  const publicHypotheses = hypotheses.map((hypothesis) => {
    const details = payload.hypotheses.find((item) => item.professionId === hypothesis.professionId);
    const linkedTrials = (details?.trialIds ?? []).flatMap((id) => {
      const trial = trialsById.get(id);
      return trial ? [trial] : [];
    });
    return {
      ...hypothesis,
      matchStrength: details?.matchStrength ?? null,
      catalogProfessionId: details?.catalogProfessionId ?? null,
      trialIds: linkedTrials.map((trial) => String(trial.id)),
      trials: linkedTrials,
      opportunities: professionOpportunities.get(hypothesis.professionId) ?? [],
      whatToTry: details?.whatToTry ?? null,
    };
  });

  const generation = payload.generation;
  const mode = generation?.mode ?? null;
  const modelName = mode === "retrieval_only"
    ? "retrieval_only"
    : input.deps.modelName || "sofi";
  const summary = sofiResult.summary?.trim() || "Рекомендация собрана по ответам.";
  const nextStep = (sofiResult.nextStep ?? sofiResult.next_step ?? "").trim()
    || "Посмотри направления, которые получились по ответам.";

  const saved = await input.deps.query(
    `INSERT INTO recommendations (
       session_id,
       summary,
       hypotheses,
       trial_ids,
       next_step,
       pathways,
       model_name,
       prompt_version,
       catalog_version,
       config_version,
       generation_mode,
       ai_payload
     )
     VALUES (
       $1, $2, $3::jsonb, $4::uuid[], $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb
     )
     RETURNING id, created_at`,
    [
      input.sessionId,
      summary,
      JSON.stringify(publicHypotheses),
      savedTrialIds,
      nextStep,
      JSON.stringify(nextStepOptions),
      modelName,
      generation?.promptVersion ?? null,
      generation?.catalogVersion ?? null,
      generation?.configVersion ?? null,
      mode,
      JSON.stringify(payload),
    ]
  );
  const result = saved.rows[0];
  const publicSofi = sofiPublicFields({
    ai_payload: payload,
    generation_mode: mode,
    prompt_version: generation?.promptVersion ?? null,
    catalog_version: generation?.catalogVersion ?? null,
    config_version: generation?.configVersion ?? null,
  });

  return {
    ok: true,
    status: 201,
    body: {
      status: "generated",
      recommendationId: result?.id ?? null,
      sessionId: input.sessionId,
      summary,
      hypotheses: publicHypotheses,
      trials,
      nextStep,
      nextStepOptions,
      model: modelName,
      createdAt: result?.created_at ?? null,
      ...publicSofi,
    },
  };
}
