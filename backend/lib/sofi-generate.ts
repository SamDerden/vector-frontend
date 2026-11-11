import type { PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";

import questionnaireByGrade from "../config/questionnaire_by_grade.json" with { type: "json" };
import {
  saveClarificationAnswers,
  validateClarificationAnswers,
} from "./clarification.ts";
import { isUuid } from "./legacy-ai.ts";
import { savedRecommendationBody, sofiPublicFields } from "./recommendation-view.ts";
import {
  CLARIFICATION_VERSION_SQL,
  DIAGNOSTIC_VERSION_SQL,
  TRACK_SQL,
  claimGenerationJob,
  completeOwnedGenerationJob,
  failGenerationJob,
  generationInputHash,
  KEEP_LEASE_SQL,
  publicErrorCode,
  inProgressBody,
  loadOwnedRecommendation,
  readGenerationJob,
  type GenerationInputSnapshot,
  type GenerationJob,
} from "./generation-jobs.ts";
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
  type AgeTier,
  type AnswerValue,
  type PreparedSofiInput,
  type ProfessionCatalogRow,
  type SofiModuleResult,
} from "./sofi-adapter.ts";
import type { SofiPipelineInput } from "./sofi-pipeline.ts";
import {
  programsVisibleForTier,
  publicSkillName,
  resolveCatalogActivities,
} from "./ai/presentation.ts";

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
  leaseRenewMs?: number;
};

export type GenerateOutcome =
  | { ok: true; status: 201 | 202; body: Record<string, unknown> }
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

function stampForSnapshot(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

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

const CLARIFICATION_LOAD_SQL = `SELECT
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
     LIMIT 1`;

function mapClarificationAnswers(value: unknown): Array<{ questionId: string; answer: AnswerValue }> {
  return (Array.isArray(value) ? value : [])
    .slice(0, 6)
    .map((item) => {
      const answer = item as Record<string, unknown>;
      return {
        questionId: String(answer.questionId ?? ""),
        answer: asAnswerValue(answer.answer),
      };
    });
}

async function writeClarificationAnswers(
  deps: GenerateDeps,
  params: {
    sessionId: string;
    diagnosticId: string;
    answers: Parameters<typeof saveClarificationAnswers>[1]["answers"];
  }
) {
  const client = await deps.connect();
  try {
    await client.query("BEGIN");
    await saveClarificationAnswers(client as PoolClient, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const RECOMMENDATION_INSERT_SQL = `INSERT INTO recommendations (
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
     RETURNING id, created_at`;

export const KEYED_RECOMMENDATION_INSERT_SQL = `INSERT INTO recommendations (
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
       ai_payload,
       generation_job_id
     )
     VALUES (
       $1, $2, $3::jsonb, $4::uuid[], $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13
     )
     RETURNING id, created_at`;

export const LINKED_RECOMMENDATION_SQL = `SELECT id
FROM recommendations
WHERE generation_job_id = $1 AND session_id = $2`;

export const PROFESSIONS_BY_IDS_SQL = `SELECT id, title, graph_profession_id
FROM professions
WHERE id = ANY($1::uuid[])`;

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function storedHypothesesTrials(hypotheses: unknown): unknown[] {
  if (!Array.isArray(hypotheses)) return [];
  const seen = new Set<string>();
  const trials: unknown[] = [];
  for (const item of hypotheses) {
    const list = item && typeof item === "object" && Array.isArray((item as { trials?: unknown }).trials)
      ? (item as { trials: unknown[] }).trials
      : [];
    for (const trial of list) {
      const id = trial && typeof trial === "object" ? String((trial as { id?: unknown }).id ?? "") : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      trials.push(trial);
    }
  }
  return trials;
}

function replayBody(row: Record<string, unknown>, job: GenerationJob): Record<string, unknown> {
  const saved = savedRecommendationBody(row, storedHypothesesTrials(row.hypotheses));
  const payload = row.ai_payload && typeof row.ai_payload === "object" && !Array.isArray(row.ai_payload)
    ? row.ai_payload as Record<string, unknown>
    : {};
  return {
    ...saved,
    status: "generated",
    activities: Array.isArray(payload.activities) ? payload.activities : [],
    requestId: job.clientRequestId,
    jobStatus: "completed",
    replayed: true,
    stageTimings: job.stageTimings,
  };
}

export async function executeGenerate(input: {
  sessionId: string;
  body: unknown;
  idempotencyKey?: string | null;
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
      details: { code: "diagnostic_required" },
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

    if (!input.idempotencyKey) {
      await writeClarificationAnswers(input.deps, {
        sessionId: input.sessionId,
        diagnosticId: String(diagnosticRow.id),
        answers: parsedBody.data.clarificationAnswers,
      });
    }
  }

  const clarification = await input.deps.query(CLARIFICATION_LOAD_SQL, [input.sessionId]);

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
      details: { code: "school_grade_required" },
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
  const clarificationAnswers = mapClarificationAnswers(clarification.rows[0]?.answers);
  const suppliedClarifications = parsedBody.data.clarificationAnswers
    ? mapClarificationAnswers(parsedBody.data.clarificationAnswers)
    : null;
  // A keyed request freezes the validated body. The pipeline, snapshot and hash
  // must use that same input. A request without a key keeps the stored reload.
  const generationClarifications = input.idempotencyKey
    ? (suppliedClarifications ?? clarificationAnswers)
    : clarificationAnswers;
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
      clarificationAnswers: generationClarifications,
    });
  } catch (error) {
    if (error instanceof MissingSchoolGradeError) {
      return { ok: false, status: error.httpStatus, error: error.message };
    }
    throw error;
  }

  let ownedJob: GenerationJob | null = null;
  if (input.idempotencyKey) {
    const [trackRow, diagnosticVersion, clarificationVersion] = await Promise.all([
      input.deps.query(TRACK_SQL, [input.sessionId]),
      input.deps.query(DIAGNOSTIC_VERSION_SQL, [String(diagnosticRow.id), input.sessionId]),
      input.deps.query(CLARIFICATION_VERSION_SQL, [input.sessionId]),
    ]);
    const snapshot: GenerationInputSnapshot = {
      schemaVersion: 1,
      schoolGrade,
      municipality: typeof profile.municipality === "string" ? profile.municipality : "",
      trackType: typeof trackRow.rows[0]?.track_type === "string" ? trackRow.rows[0].track_type : "",
      diagnosticId: String(diagnosticRow.id),
      diagnosticSubmittedAt: stampForSnapshot(diagnosticVersion.rows[0]?.submitted_at),
      clarificationId: suppliedClarifications || clarificationVersion.rows[0]?.id == null
        ? ""
        : String(clarificationVersion.rows[0].id),
      clarificationSubmittedAt: suppliedClarifications
        ? ""
        : stampForSnapshot(clarificationVersion.rows[0]?.submitted_at),
      diagnosticAnswers,
      clarificationAnswers: generationClarifications,
      professionIds: professions.map((item) => item.id),
    };
    const inputHash = generationInputHash(snapshot);
    const claim = await claimGenerationJob(input.deps.query, {
      sessionId: input.sessionId,
      clientRequestId: input.idempotencyKey,
      inputHash,
      snapshot,
    });
    if (claim.kind === "conflict") {
      return {
        ok: false,
        status: 409,
        error: "Idempotency key was already used with different input",
        details: { code: "idempotency_conflict", requestId: input.idempotencyKey, jobStatus: "conflict" },
      };
    }
    if (claim.kind === "in_progress") {
      return { ok: true, status: 202, body: inProgressBody(claim.job) };
    }
    if (claim.kind === "failed" || claim.kind === "unavailable") {
      const incomplete = claim.kind === "unavailable" || claim.job.status === "completed";
      return {
        ok: false,
        status: 502,
        error: "AI service request failed",
        details: {
          requestId: input.idempotencyKey,
          jobStatus: "failed",
          errorCode: incomplete ? "incomplete_result" : publicErrorCode(claim.job.errorCode ?? "pipeline_failed"),
        },
      };
    }
    if (claim.kind === "replay") {
      const stored = await loadOwnedRecommendation(
        input.deps.query,
        claim.job.recommendationId ?? "",
        input.sessionId
      );
      if (!stored) {
        return {
          ok: false,
          status: 502,
          error: "AI service request failed",
          details: { requestId: input.idempotencyKey, jobStatus: "failed", errorCode: "incomplete_result" },
        };
      }
      return { ok: true, status: 201, body: replayBody(stored, claim.job) };
    }
    ownedJob = claim.job;
    if (suppliedClarifications && parsedBody.data.clarificationAnswers) {
      try {
        await writeClarificationAnswers(input.deps, {
          sessionId: input.sessionId,
          diagnosticId: String(diagnosticRow.id),
          answers: parsedBody.data.clarificationAnswers,
        });
      } catch (error) {
        await failGenerationJob(input.deps.query, {
          jobId: ownedJob.id,
          sessionId: input.sessionId,
          errorCode: "persist_failed",
          stageTimings: {},
          owner: ownedJob.lockedBy ?? "",
        }).catch((failure: unknown) => {
          console.error(
            "generation job failure was not recorded",
            failure instanceof Error ? failure.name : "unknown"
          );
        });
        console.error(
          "clarification persist failed",
          error instanceof Error ? error.name : "unknown"
        );
        return {
          ok: false,
          status: 502,
          error: "AI service request failed",
          details: { requestId: input.idempotencyKey, jobStatus: "failed", errorCode: "persist_failed" },
        };
      }
    }
  }

  return finishOwnedGeneration({
    deps: input.deps,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey ?? null,
    ownedJob,
    prepared,
    professions,
    tier,
    titles,
    ownFailure: true,
  });
}

async function outcomeForCurrentJob(
  deps: GenerateDeps,
  sessionId: string,
  requestId: string | null
): Promise<GenerateOutcome> {
  if (!requestId) {
    return { ok: false, status: 502, error: "AI service request failed" };
  }
  const job = await readGenerationJob(deps.query, sessionId, requestId);
  if (job?.status === "completed" && job.recommendationId) {
    const row = await loadOwnedRecommendation(deps.query, job.recommendationId, sessionId);
    if (row) return { ok: true, status: 201, body: replayBody(row, job) };
  }
  if (job && (job.status === "pending" || job.status === "running")) {
    return { ok: true, status: 202, body: inProgressBody(job) };
  }
  return {
    ok: false,
    status: 502,
    error: "AI service request failed",
    details: {
      requestId,
      jobStatus: "failed",
      errorCode: publicErrorCode(job?.errorCode ?? "incomplete_result"),
    },
  };
}

function startOwnedLease(deps: GenerateDeps, job: GenerationJob): () => void {
  if (!job.lockedBy) return () => undefined;
  const timer = setInterval(() => {
    void deps.query(KEEP_LEASE_SQL, [job.id, job.sessionId, job.lockedBy]).catch((error: unknown) => {
      console.error("generation lease was not renewed", error instanceof Error ? error.name : "unknown");
    });
  }, deps.leaseRenewMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function retainOwnedJob(deps: GenerateDeps, job: GenerationJob): Promise<boolean> {
  if (!job.lockedBy) return false;
  const kept = await deps.query(KEEP_LEASE_SQL, [job.id, job.sessionId, job.lockedBy]);
  return (kept.rowCount ?? kept.rows.length) > 0;
}

async function finishOwnedGeneration(source: {
  deps: GenerateDeps;
  sessionId: string;
  idempotencyKey: string | null;
  ownedJob: GenerationJob | null;
  prepared: PreparedSofiInput;
  professions: ProfessionCatalogRow[];
  tier: AgeTier;
  titles: Map<string, string>;
  ownFailure: boolean;
}): Promise<GenerateOutcome> {
  const input = {
    deps: source.deps,
    sessionId: source.sessionId,
    idempotencyKey: source.idempotencyKey,
  };
  const { ownedJob, prepared, professions, tier, titles, ownFailure } = source;
  const stopLease = ownedJob ? startOwnedLease(input.deps, ownedJob) : () => undefined;
  try {
  if (ownedJob && !(await retainOwnedJob(input.deps, ownedJob))) {
    return outcomeForCurrentJob(input.deps, input.sessionId, input.idempotencyKey);
  }
  let sofiResult: SofiModuleResult;
  const pipelineStarted = Date.now();
  try {
    sofiResult = await input.deps.pipeline({ prepared, professions });
  } catch (error) {
    const pipelineDurationMs = Date.now() - pipelineStarted;
    console.error(
      "Sofi pipeline failed",
      error instanceof Error ? error.name : "unknown error"
    );
    if (ownedJob && ownFailure && ownedJob.lockedBy) {
      const failed = await failGenerationJob(input.deps.query, {
        jobId: ownedJob.id,
        sessionId: input.sessionId,
        errorCode: "pipeline_failed",
        stageTimings: { pipeline: { durationMs: pipelineDurationMs } },
        owner: ownedJob.lockedBy,
      }).catch((failure: unknown) => {
        console.error(
          "generation job failure was not recorded",
          failure instanceof Error ? failure.name : "unknown"
        );
        return { rowCount: 0, rows: [] };
      });
      if ((failed.rowCount ?? failed.rows.length) < 1) {
        return outcomeForCurrentJob(input.deps, input.sessionId, input.idempotencyKey);
      }
    }
    return {
      ok: false,
      status: 502,
      error: "AI service request failed",
      details: ownedJob
        ? { requestId: input.idempotencyKey, jobStatus: "failed", errorCode: "pipeline_failed" }
        : undefined,
    };
  }
  const pipelineDurationMs = Date.now() - pipelineStarted;

  const adapted = adaptSofiResult(sofiResult, professions);
  console.log("[Sofi mapping] result:",JSON.stringify({rawHypotheses:sofiResult.hypotheses?.length??0,mapped:adapted.hypotheses.length,unmapped:adapted.unmapped.length,unmappedIds:adapted.unmapped.slice(0,5).map(item=>item.catalogProfessionId),generationMode:sofiResult.generation?.mode??null}));
  const junior = tier === "1-4";
  // Keep catalog-backed recommendations visible even when the legacy SQL
  // professions table has no graph_profession_id mapping. Do not invent UUIDs.
  const catalogProfessionNames = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), "data/catalog.normalized.json"), "utf8");
    const graph = JSON.parse(raw) as { professions?: Array<{ profession_id: string; name: string }> };
    for (const profession of graph.professions ?? []) {
      catalogProfessionNames.set(profession.profession_id, profession.name);
    }
  } catch (error) {
    console.warn("[Sofi mapping] Could not load catalog profession titles", error instanceof Error ? error.message : "unknown");
  }
  // Resolve internal skill identifiers only through the approved source catalog.
  const skillNames = new Map<string, string>();
  try {
    const rawSkills = await fs.readFile(path.resolve(process.cwd(), "data/navigator_full_graph.json"), "utf8");
    const sourceCatalog = JSON.parse(rawSkills) as { skills?: Array<{ skill_id: string; name: string }> };
    for (const skill of sourceCatalog.skills ?? []) {
      if (skill.skill_id && skill.name) skillNames.set(skill.skill_id, skill.name);
    }
  } catch (error) {
    console.warn("[Sofi mapping] Skill reference unavailable", error instanceof Error ? error.message : "unknown");
  }
  const publicSkill = (value: unknown): string | null => publicSkillName(value, skillNames);
  const hypotheses = junior
    ? []
    : adapted.aiPayload.hypotheses.flatMap((item) => {
        const catalogTitle = catalogProfessionNames.get(item.catalogProfessionId);
        if (!catalogTitle) return [];
        return [{
          professionId: item.professionId ?? item.catalogProfessionId,
          title: item.professionId ? (titles.get(item.professionId) || catalogTitle) : catalogTitle,
          reason: item.reason || "Профессия подобрана по ответам и проверенному каталогу.",
          fitScore: item.fitScore,
          scoreKind: "relative_ranking" as const,
          mapping: item.mapping,
        }];
      });
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
  const graphProfessionsById = new Map<string, Record<string, unknown>>();
  let catalogActivities: Array<{ id: string; title: string; description?: string; durationMinutes?: number | null; format?: string | null; municipality?: string | null; cost?: string | null; sourceUrl?: string | null; organization?: unknown }> = [];
  try {
    const rawCatalog = await fs.readFile(path.resolve(process.cwd(), "data/catalog.normalized.json"), "utf8");
    const catalog = JSON.parse(rawCatalog) as {
      professions?: Array<Record<string, unknown>>;
      trials?: Array<{ trial_id?: unknown; title?: unknown; age_min?: unknown; age_max?: unknown; description_1_4?: unknown; duration_minutes?: unknown; format?: unknown; municipality?: unknown; cost?: unknown; source_url?: unknown; organization?: unknown }>;
    };
    if (junior) {
      const resolved = resolveCatalogActivities(catalog.trials ?? [], payload.activityIds);
      const byId = new Map((catalog.trials ?? []).map(trial => [trial.trial_id, trial]));
      const estimatedAge = prepared.student.school_grade + 6;
      catalogActivities = resolved.flatMap(item => {
        const trial = byId.get(item.id);
        if (!trial) return [];
        const min = typeof trial.age_min === "number" ? trial.age_min : null;
        const max = typeof trial.age_max === "number" ? trial.age_max : null;
        if ((min !== null && estimatedAge < min) || (max !== null && estimatedAge > max)) return [];
        return [{
          ...item,
          description: typeof trial.description_1_4 === "string" ? trial.description_1_4 : "",
          durationMinutes: typeof trial.duration_minutes === "number" ? trial.duration_minutes : null,
          format: typeof trial.format === "string" ? trial.format : null,
          municipality: typeof trial.municipality === "string" ? trial.municipality : null,
          cost: typeof trial.cost === "string" ? trial.cost : null,
          sourceUrl: typeof trial.source_url === "string" ? trial.source_url : null,
          organization: trial.organization && typeof trial.organization === "object" ? trial.organization : null,
        }];
      });
    }
    const selected = new Set(payload.hypotheses.map(item => item.catalogProfessionId));
    for (const profession of catalog.professions ?? []) {
      const id = profession.profession_id;
      if (typeof id !== "string" || !selected.has(id)) continue;
      graphProfessionsById.set(id, profession);
      for (const trial of Array.isArray(profession.trials) ? profession.trials : []) {
        if (!trial || typeof trial !== "object") continue;
        const record = trial as Record<string, unknown>;
        const trialId = record.trial_id;
        if (typeof trialId === "string" && requestedTrialIds.includes(trialId)) graphTrialsById.set(trialId, record);
      }
    }
  } catch (error) {
    console.warn("Could not resolve profession catalog", error instanceof Error ? error.message : "unknown error");
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
      description: (tier === "5-8" ? trial.description_5_8 : trial.description_9_11) ?? "",
      format: trial.format ?? null,
      duration_minutes: trial.duration_minutes ?? null,
      municipality: trial.municipality ?? null,
      cost: trial.cost ?? null,
      source_url: trial.source_url ?? null,
      organization: trial.organization ?? null,
      skills_checked: (Array.isArray(trial.skills_checked) ? trial.skills_checked : []).map(publicSkill).filter((name): name is string => Boolean(name)),
      fit_level: trial.fit_level ?? null,
      source: "graph",
    });
  }

  // Enrich each visible hypothesis with its own verified catalog trials.
  const trialsById = new Map(trials.map((trial) => [String(trial.id), trial]));
  const publicHypotheses = hypotheses.map((hypothesis) => {
    const details = payload.hypotheses.find((item) => (item.professionId ?? item.catalogProfessionId) === hypothesis.professionId);
    const linkedTrials = (details?.trialIds ?? []).flatMap((id) => {
      const trial = trialsById.get(id);
      return trial ? [trial] : [];
    });
    const profession = details?.catalogProfessionId ? graphProfessionsById.get(details.catalogProfessionId) : undefined;
    const description = tier === "5-8" ? profession?.description_5_8 : profession?.description_9_11;
    const skills = Array.isArray(profession?.key_skills) ? profession.key_skills.map(publicSkill).filter((name): name is string => Boolean(name)) : [];
    const programs = Array.isArray(profession?.programs) ? profession.programs.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    return {
      ...hypothesis,
      description: typeof description === "string" ? description : null,
      whatDoes: typeof profession?.what_kid_does === "string" ? profession.what_kid_does : null,
      skills,
      programs: programsVisibleForTier(tier) ? programs.map(program => ({
        id: String(program.program_id ?? ""),
        title: String(program.name ?? ""),
        level: typeof program.level === "string" ? program.level : null,
        organization: typeof program.organization_name === "string" ? program.organization_name : (program.organization && typeof program.organization === "object" ? String((program.organization as Record<string,unknown>).name ?? "") : null),
        website: program.organization && typeof program.organization === "object" && typeof (program.organization as Record<string,unknown>).website === "string" ? (program.organization as Record<string,unknown>).website : null,
        source: "catalog",
      })).filter(program => program.id && program.title) : [],
      matchStrength: details?.matchStrength ?? null,
      industryName: typeof profession?.industry_name === "string" ? profession.industry_name : null,
      catalogProfessionId: details?.catalogProfessionId ?? null,
      trialIds: linkedTrials.map((trial) => String(trial.id)),
      trials: linkedTrials,
      opportunities: programsVisibleForTier(tier) ? professionOpportunities.get(hypothesis.professionId) ?? [] : [],
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

  const storedPayload = ownedJob ? { ...payload, activities: catalogActivities } : payload;
  const recommendationParams = [
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
    JSON.stringify(storedPayload),
  ];
  let saved;
  let stageTimings: Record<string, { durationMs: number }> | null = null;
  if (!ownedJob) {
    saved = await input.deps.query(RECOMMENDATION_INSERT_SQL, recommendationParams);
  } else {
    const persistStarted = Date.now();
    let recommendationId = "";
    let lostOwnership = false;
    const owner = ownedJob.lockedBy ?? "";
    const insertClient = await input.deps.connect();
    try {
      await insertClient.query("BEGIN");
      const kept = await insertClient.query(KEEP_LEASE_SQL, [ownedJob.id, input.sessionId, owner]);
      if ((kept.rowCount ?? kept.rows.length) < 1) {
        lostOwnership = true;
        await insertClient.query("ROLLBACK");
      } else {
        saved = await insertClient.query(KEYED_RECOMMENDATION_INSERT_SQL, [
          ...recommendationParams,
          ownedJob.id,
        ]);
        const completed = await completeOwnedGenerationJob(insertClient.query, {
          jobId: ownedJob.id,
          sessionId: input.sessionId,
          recommendationId: String(saved.rows[0]?.id ?? ""),
          stageTimings: {
            pipeline: { durationMs: pipelineDurationMs },
            persist: { durationMs: Date.now() - persistStarted },
          },
          owner,
        });
        if ((completed.rowCount ?? completed.rows.length) < 1) {
          throw new Error("generation job was no longer owned");
        }
        await insertClient.query("COMMIT");
        recommendationId = saved.rows[0]?.id == null ? "" : String(saved.rows[0].id);
      }
    } catch (error) {
      await insertClient.query("ROLLBACK").catch(() => undefined);
      if (uniqueViolation(error)) {
        const existing = await input.deps.query(LINKED_RECOMMENDATION_SQL, [ownedJob.id, input.sessionId]);
        recommendationId = existing.rows[0]?.id == null ? "" : String(existing.rows[0].id);
      }
      if (!recommendationId) {
        if (ownFailure && owner) {
          await failGenerationJob(input.deps.query, {
            jobId: ownedJob.id,
            sessionId: input.sessionId,
            errorCode: "persist_failed",
            stageTimings: { pipeline: { durationMs: pipelineDurationMs } },
            owner,
          }).catch((failure: unknown) => {
            console.error(
              "generation job failure was not recorded",
              failure instanceof Error ? failure.name : "unknown"
            );
          });
        }
        console.error(
          "recommendation persist failed",
          error instanceof Error ? error.name : "unknown"
        );
        return {
          ok: false,
          status: 502,
          error: "AI service request failed",
          details: { requestId: input.idempotencyKey, jobStatus: "failed", errorCode: "persist_failed" },
        };
      }
    } finally {
      insertClient.release();
    }
    if (lostOwnership && !recommendationId) {
      return outcomeForCurrentJob(input.deps, input.sessionId, input.idempotencyKey);
    }
    stageTimings = {
      pipeline: { durationMs: pipelineDurationMs },
      persist: { durationMs: Date.now() - persistStarted },
    };
    saved = { rowCount: 1, rows: [{ id: recommendationId, created_at: saved?.rows[0]?.created_at ?? null }] };
  }
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
      activities: catalogActivities,
      trials,
      nextStep,
      nextStepOptions,
      model: modelName,
      createdAt: result?.created_at ?? null,
      ...publicSofi,
      ...(ownedJob
        ? {
            requestId: input.idempotencyKey,
            jobStatus: "completed",
            replayed: false,
            stageTimings,
          }
        : {}),
    },
  };
  } finally {
    stopLease();
  }
}

export async function runFrozenGeneration(args: {
  deps: GenerateDeps;
  sessionId: string;
  requestId: string;
  snapshot: GenerationInputSnapshot;
  job: GenerationJob;
}): Promise<GenerateOutcome> {
  let prepared: PreparedSofiInput;
  try {
    prepared = prepareSofiInput({
      profile: {
        schoolGrade: args.snapshot.schoolGrade,
        municipality: args.snapshot.municipality,
      },
      diagnosticAnswers: args.snapshot.diagnosticAnswers as Parameters<typeof prepareSofiInput>[0]["diagnosticAnswers"],
      clarificationAnswers: args.snapshot.clarificationAnswers as Parameters<typeof prepareSofiInput>[0]["clarificationAnswers"],
    });
  } catch (error) {
    if (error instanceof MissingSchoolGradeError) {
      return {
        ok: false,
        status: 502,
        error: "AI service request failed",
        details: { requestId: args.requestId, jobStatus: "failed", errorCode: "input_unavailable" },
      };
    }
    throw error;
  }
  const loaded = await args.deps.query(PROFESSIONS_BY_IDS_SQL, [args.snapshot.professionIds]);
  const found = loaded.rows.map((row) => String(row.id)).sort();
  const expected = [...args.snapshot.professionIds].sort();
  if (expected.length === 0 || expected.join("\n") !== found.join("\n")) {
    return {
      ok: false,
      status: 502,
      error: "AI service request failed",
      details: { requestId: args.requestId, jobStatus: "failed", errorCode: "input_unavailable" },
    };
  }
  return finishOwnedGeneration({
    deps: args.deps,
    sessionId: args.sessionId,
    idempotencyKey: args.requestId,
    ownedJob: args.job,
    prepared,
    professions: loaded.rows.map((row) => ({
      id: String(row.id),
      graphProfessionId: typeof row.graph_profession_id === "string" ? row.graph_profession_id : null,
    })),
    tier: tierForGrade(args.snapshot.schoolGrade),
    titles: new Map(loaded.rows.map((row) => [String(row.id), String(row.title ?? "")])),
    ownFailure: false,
  });
}
