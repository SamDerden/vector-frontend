import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAIM_JOB_SQL,
  COMPLETE_JOB_SQL,
  COMPLETE_OWNED_SQL,
  FAIL_JOB_SQL,
  KEEP_LEASE_SQL,
  generationInputHash,
  isTransportFailure,
  loadOwnedRecommendation,
  parseIdempotencyKey,
  publicJobAccess,
} from "../lib/generation-jobs.ts";
import { fetchLatestRecommendation, savedRecommendationBody } from "../lib/recommendation-view.ts";
import { executeGenerate, type DbQuery, type DbQueryResult, type GenerateDeps } from "../lib/sofi-generate.ts";
import type { SofiModuleResult } from "../lib/sofi-adapter.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const DIAGNOSTIC_ID = "44444444-4444-4444-8444-444444444444";
const PROFESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANSWER = "уникальный-ответ-школьника";
const SUBMITTED_AT = "2026-11-10T00:00:00.000Z";

type JobRow = Record<string, unknown>;
type RecommendationRow = Record<string, unknown>;
type Tables = { jobs: JobRow[]; recommendations: RecommendationRow[] };

function empty(): DbQueryResult {
  return { rowCount: 0, rows: [] };
}

function rows(list: Array<Record<string, unknown>>): DbQueryResult {
  return { rowCount: list.length, rows: list };
}

function hashFor(answer: string, professionIds = [PROFESSION_ID]) {
  return generationInputHash({
    schoolGrade: 7,
    municipality: "Екатеринбург",
    trackType: "explore",
    diagnosticId: DIAGNOSTIC_ID,
    diagnosticSubmittedAt: SUBMITTED_AT,
    clarificationId: "",
    clarificationSubmittedAt: "",
    diagnosticAnswers: [{ questionId: "q1", answer, questionnaire: "Билет" }],
    clarificationAnswers: [],
    professionIds,
  });
}

function createWorld() {
  let committed: Tables = { jobs: [], recommendations: [] };
  let tx: Tables | null = null;
  let failCommit = false;
  const sqlLog: string[] = [];
  const jobParams: unknown[][] = [];
  let pipelineCalls = 0;
  let releasePipeline: (() => void) | null = null;
  let pipelineMode: SofiModuleResult["generation"] = {
    mode: "llm",
    tier: "5-8",
    promptVersion: "nav-5-8@test",
    catalogVersion: "hybrid_v2",
    configVersion: "age-1",
    attempts: 1,
  };
  let pipelineError: Error | null = null;
  const answers = new Map<string, string>([[SESSION_A, ANSWER], [SESSION_B, "другой ответ"]]);
  let clarificationInserts = 0;
  let storedClarification: string | null = null;
  let pipelinePrepared: { normalizedAnswers?: Array<{ source?: string; original?: unknown }> } | null = null;

  const view = () => tx ?? committed;
  const query: DbQuery = async (sql, params = []) => {
    sqlLog.push(sql);
    if (sql === "BEGIN") {
      if (tx) throw new Error("nested transaction");
      tx = structuredClone(committed);
      return empty();
    }
    if (sql === "ROLLBACK") {
      tx = null;
      return empty();
    }
    if (sql === "COMMIT") {
      if (!tx) return empty();
      if (failCommit) {
        tx = null;
        throw new Error("commit failed");
      }
      committed = tx;
      tx = null;
      return empty();
    }
    if (sql.includes("INSERT INTO generation_jobs")) {
      jobParams.push(params);
      const existing = view().jobs.find((job) => job.session_id === params[0] && job.client_request_id === params[1]);
      if (existing) return empty();
      const job: JobRow = {
        id: crypto.randomUUID(),
        session_id: params[0],
        client_request_id: params[1],
        input_hash: params[2],
        status: "running",
        recommendation_id: null,
        error_code: null,
        stage_timings: {},
        attempt_count: 1,
        locked_by: "api-request",
        locked_until: new Date(Date.now() + 180000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
      };
      view().jobs.push(job);
      return rows([job]);
    }
    if (sql.includes("UPDATE generation_jobs")) {
      if (sql.includes("locked_until = now()")) {
        const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && item.status === "running" && item.locked_by === params[2]);
        if (!job) return empty();
        job.locked_until = new Date(Date.now() + 180000).toISOString();
        return rows([{ id: job.id }]);
      }
      const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && item.status === "running");
      if (!job) return empty();
      if (sql.includes("locked_by = $5") && job.locked_by !== params[4]) return empty();
      if (sql.includes("status = 'failed'")) {
        job.status = "failed";
        job.error_code = params[2];
        job.stage_timings = JSON.parse(String(params[3]));
        job.locked_by = null;
        job.locked_until = null;
        job.updated_at = new Date().toISOString();
      } else {
        job.status = "completed";
        job.recommendation_id = params[2];
        job.stage_timings = JSON.parse(String(params[3]));
        job.error_code = null;
        job.locked_by = null;
        job.locked_until = null;
        job.completed_at = new Date().toISOString();
        job.updated_at = new Date().toISOString();
      }
      return rows([job]);
    }
    if (sql.includes("FROM generation_jobs")) {
      const job = view().jobs.find((item) => item.session_id === params[0] && item.client_request_id === params[1]);
      return job ? rows([job]) : empty();
    }
    if (sql.includes("INSERT INTO recommendations")) {
      const row: RecommendationRow = {
        id: crypto.randomUUID(),
        session_id: params[0],
        summary: params[1],
        hypotheses: JSON.parse(String(params[2])),
        trial_ids: params[3],
        next_step: params[4],
        pathways: JSON.parse(String(params[5])),
        model_name: params[6],
        prompt_version: params[7],
        catalog_version: params[8],
        config_version: params[9],
        generation_mode: params[10],
        ai_payload: JSON.parse(String(params[11])),
        generation_job_id: params[12] ?? null,
        created_at: "2026-11-10T01:00:00.000Z",
      };
      view().recommendations.push(row);
      return rows([{ id: row.id, created_at: row.created_at }]);
    }
    if (sql.includes("FROM recommendations")) {
      const row = view().recommendations.find((item) => item.id === params[0] && item.session_id === params[1]);
      return row ? rows([row]) : empty();
    }
    if (sql.includes("INSERT INTO clarification_answers")) {
      return rows([{ ok: true }]);
    }
    if (sql.includes("INSERT INTO clarifications")) {
      clarificationInserts += 1;
      return rows([{ id: crypto.randomUUID() }]);
    }
    if (sql.includes("submitted_at") && sql.includes("FROM diagnostics") && !sql.includes("json_agg")) {
      const sessionId = String(params[1]);
      if (!answers.has(sessionId) || params[0] !== DIAGNOSTIC_ID) return empty();
      return rows([{ submitted_at: SUBMITTED_AT }]);
    }
    if (sql.includes("FROM clarifications") && !sql.includes("json_agg")) {
      return storedClarification
        ? rows([{ id: "55555555-5555-4555-8555-555555555555", submitted_at: SUBMITTED_AT }])
        : empty();
    }
    if (sql.includes("track_type") && sql.includes("FROM sessions")) {
      return answers.has(String(params[0])) ? rows([{ track_type: "explore" }]) : empty();
    }
    if (sql.includes("FROM diagnostics")) {
      const sessionId = String(params[0]);
      if (!answers.has(sessionId)) return empty();
      return rows([{
        id: DIAGNOSTIC_ID,
        answers: [{ questionId: "q1", answer: answers.get(sessionId), questionnaire: "Билет" }],
      }]);
    }
    if (sql.includes("FROM clarifications")) {
      return storedClarification
        ? rows([{
          id: "55555555-5555-4555-8555-555555555555",
          submitted_at: SUBMITTED_AT,
          answers: [{ questionId: "agent_q2_work_style", answer: storedClarification }],
        }])
        : empty();
    }
    if (sql.includes("FROM profiles")) {
      if (!answers.has(String(params[0]))) return empty();
      return rows([{ school_grade: 7, municipality: "Екатеринбург" }]);
    }
    if (sql.includes("FROM professions")) {
      return rows([{ id: PROFESSION_ID, title: "Инженер", graph_profession_id: "prof_004" }]);
    }
    if (sql.includes("FROM professional_trials") || sql.includes("FROM education_programs")) return empty();
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const deps: GenerateDeps = {
    query,
    connect: async () => {
      const client = {
        marker: "pg-client",
        query(this: { marker?: string }, sql: string, params?: unknown[]) {
          if (this?.marker !== "pg-client") {
            throw new TypeError("Cannot read properties of undefined (reading 'queryQueue')");
          }
          return query(sql, params);
        },
        release() {},
      };
      return client;
    },
    pipeline: async (input) => {
      pipelinePrepared = input.prepared;
      pipelineCalls += 1;
      if (releasePipeline && pipelineCalls === 1) await new Promise<void>((resolve) => { releasePipeline = resolve; });
      if (pipelineError && pipelineCalls === 1) throw pipelineError;
      return {
        summary: "Рекомендация собрана",
        next_step: "Посмотри направление",
        warnings: pipelineMode?.mode === "retrieval_only" ? ["llm_fallback_used"] : [],
        hypotheses: [],
        generation: pipelineMode,
      };
    },
    modelName: "test-model",
  };

  return {
    deps,
    answers,
    sqlLog,
    jobParams,
    jobs: () => committed.jobs,
    recommendations: () => committed.recommendations,
    pipelineCalls: () => pipelineCalls,
    clarificationInserts: () => clarificationInserts,
    pipelinePrepared: () => pipelinePrepared,
    seedClarification(answer: string) {
      storedClarification = answer;
    },
    holdPipeline() {
      releasePipeline = () => undefined;
    },
    releasePipeline() {
      const release = releasePipeline;
      releasePipeline = null;
      release?.();
    },
    failNextCommit() {
      failCommit = true;
    },
    failPipeline(error: Error) {
      pipelineError = error;
    },
    useRetrievalOnly() {
      pipelineMode = {
        mode: "retrieval_only",
        tier: "5-8",
        promptVersion: null,
        catalogVersion: "hybrid_v2",
        configVersion: "age-1",
        attempts: 0,
      };
    },
    seed(job: JobRow) {
      committed.jobs.push(job);
    },
  };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out");
}

test("migration 007 only adds generation jobs", () => {
  const sql = readFileSync(new URL("../migrations/007_generation_jobs.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS generation_jobs/);
  assert.match(sql, /session_id UUID NOT NULL REFERENCES sessions\(id\) ON DELETE CASCADE/);
  assert.match(sql, /recommendation_id UUID REFERENCES recommendations\(id\) ON DELETE SET NULL/);
  assert.match(sql, /UNIQUE \(session_id, client_request_id\)/);
  assert.match(sql, /CHECK \(status IN \('pending', 'running', 'completed', 'failed'\)\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS generation_jobs_reclaim_idx/);
  assert.match(sql, /input_snapshot JSONB NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS generation_job_id UUID UNIQUE/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE|ALTER TABLE recommendations\s+DROP/i);
  assert.match(CLAIM_JOB_SQL, /ON CONFLICT \(session_id, client_request_id\) DO NOTHING/);
  assert.match(COMPLETE_JOB_SQL, /status = 'completed'/);
  assert.match(FAIL_JOB_SQL, /status = 'failed'/);
  assert.equal(CLAIM_JOB_SQL.includes(REQUEST_ID), false);
});

test("idempotency key is a UUID and the input hash hides answer text", () => {
  assert.equal(parseIdempotencyKey(null).ok && parseIdempotencyKey(null).key, null);
  assert.equal(parseIdempotencyKey("  ") .ok && parseIdempotencyKey("  ").key, null);
  assert.equal(parseIdempotencyKey(REQUEST_ID.toUpperCase()).ok && parseIdempotencyKey(REQUEST_ID.toUpperCase()).key, REQUEST_ID);
  assert.equal(parseIdempotencyKey("not a key").ok, false);
  assert.equal(parseIdempotencyKey(`${REQUEST_ID} extra`).ok, false);
  const first = hashFor(ANSWER);
  const second = hashFor("другой ответ");
  assert.equal(first, hashFor(ANSWER));
  assert.notEqual(first, second);
  assert.equal(first.includes(ANSWER), false);
  assert.equal(second.includes("другой ответ"), false);
});

test("a request without an idempotency key keeps the previous 201 contract", async () => {
  const world = createWorld();
  const outcome = await executeGenerate({ sessionId: SESSION_A, body: {}, deps: world.deps });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.status, "generated");
  assert.equal("requestId" in outcome.body, false);
  assert.equal("jobStatus" in outcome.body, false);
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.sqlLog.some((sql) => sql.includes("generation_jobs")), false);
  assert.equal(world.recommendations().length, 1);
});

test("one idempotent request creates one running job and completes it with measured stages", async () => {
  const world = createWorld();
  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.requestId, REQUEST_ID);
  assert.equal(outcome.body.jobStatus, "completed");
  assert.equal(outcome.body.replayed, false);
  const timings = outcome.body.stageTimings as { pipeline: { durationMs: number }; persist: { durationMs: number } };
  assert.equal(typeof timings.pipeline.durationMs, "number");
  assert.equal(typeof timings.persist.durationMs, "number");
  assert.equal("retrieval" in timings, false);
  assert.equal(world.jobs().length, 1);
  assert.equal(world.jobs()[0].status, "completed");
  assert.equal(world.jobs()[0].recommendation_id, outcome.body.recommendationId);
  assert.equal(world.jobs()[0].locked_by, null);
  assert.equal(world.recommendations().length, 1);
  const snapshot = JSON.parse(String(world.jobParams[0][3]));
  assert.equal(snapshot.diagnosticAnswers[0].answer, ANSWER);
  assert.equal(String(world.jobParams[0][2]).includes(ANSWER), false);
  assert.equal(JSON.stringify(outcome.body).includes(ANSWER), false);
});

test("two concurrent requests with one key start the pipeline once", async () => {
  const world = createWorld();
  world.holdPipeline();
  const first = executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  await until(() => world.pipelineCalls() === 1);
  const second = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.status, 202);
    assert.equal(second.body.jobStatus, "running");
    assert.equal(second.body.status, "in_progress");
    assert.equal("recommendationId" in second.body, false);
  }
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.jobs()[0].status, "running");
  assert.equal(world.jobs()[0].recommendation_id, null);
  assert.equal(typeof world.jobs()[0].locked_until, "string");
  world.releasePipeline();
  const finished = await first;
  assert.equal(finished.ok && finished.status, 201);
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.recommendations().length, 1);
});

test("a completed job is replayed without another pipeline call", async () => {
  const world = createWorld();
  const first = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  const second = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.status, 201);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.recommendationId, first.body.recommendationId);
  assert.equal(second.body.summary, first.body.summary);
  assert.equal(second.body.jobStatus, "completed");
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.recommendations().length, 1);
});

test("pending and running jobs do not start another generation", async () => {
  for (const status of ["pending", "running"] as const) {
    const world = createWorld();
    world.seed({
      id: crypto.randomUUID(),
      session_id: SESSION_A,
      client_request_id: REQUEST_ID,
      input_hash: hashFor(ANSWER),
      status,
      recommendation_id: null,
      error_code: null,
      stage_timings: {},
      attempt_count: 1,
      locked_by: status === "running" ? "api-request" : null,
      locked_until: status === "running" ? new Date(Date.now() + 180000).toISOString() : null,
    });
    const outcome = await executeGenerate({
      sessionId: SESSION_A,
      body: {},
      idempotencyKey: REQUEST_ID,
      deps: world.deps,
    });
    assert.equal(outcome.ok, true, status);
    if (!outcome.ok) continue;
    assert.equal(outcome.status, 202, status);
    assert.equal(outcome.body.jobStatus, status);
    assert.equal(world.pipelineCalls(), 0, status);
    assert.equal(world.recommendations().length, 0, status);
  }
});

test("the same key with a different input returns 409 and keeps the first result", async () => {
  const world = createWorld();
  const first = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  world.answers.set(SESSION_A, "изменённый ответ");
  const second = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (second.ok || !first.ok) return;
  assert.equal(second.status, 409);
  assert.equal(second.error, "Idempotency key was already used with different input");
  assert.equal(JSON.stringify(second.details).includes("изменённый ответ"), false);
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.recommendations().length, 1);
  assert.equal(world.jobs()[0].recommendation_id, first.body.recommendationId);
});

test("another session cannot read or replay the first session job", async () => {
  const world = createWorld();
  const first = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  const second = await executeGenerate({
    sessionId: SESSION_B,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(second.body.recommendationId, first.body.recommendationId);
  assert.equal(second.body.sessionId, SESSION_B);
  assert.equal(world.pipelineCalls(), 2);
  const leaked = await loadOwnedRecommendation(
    world.deps.query,
    String(first.body.recommendationId),
    SESSION_B
  );
  assert.equal(leaked, null);
  const owned = await loadOwnedRecommendation(
    world.deps.query,
    String(first.body.recommendationId),
    SESSION_A
  );
  assert.equal(owned?.session_id, SESSION_A);
});

test("retrieval_only is a completed job and a pipeline error leaves no recommendation", async () => {
  const success = createWorld();
  success.useRetrievalOnly();
  const saved = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: success.deps,
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(saved.body.model, "retrieval_only");
    assert.equal(saved.body.jobStatus, "completed");
    assert.equal(success.jobs()[0].error_code, null);
  }

  const failed = createWorld();
  failed.failPipeline(new Error("model timeout"));
  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: failed.deps,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 502);
    assert.equal(outcome.error, "AI service request failed");
    assert.equal(JSON.stringify(outcome.details).includes("model timeout"), false);
  }
  assert.equal(failed.recommendations().length, 0);
  assert.equal(failed.jobs()[0].status, "failed");
  assert.equal(failed.jobs()[0].error_code, "pipeline_failed");
  assert.equal(failed.jobs()[0].recommendation_id, null);
  const replay = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: failed.deps,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.status, 502);
  assert.equal(failed.pipelineCalls(), 1);
});

test("ECONNABORTED is a transport failure and does not start a second generation", async () => {
  const failed = createWorld();
  const abort = Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" });
  assert.equal(isTransportFailure(abort), true);
  failed.failPipeline(abort);
  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: failed.deps,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 502);
    assert.equal(JSON.stringify(outcome).includes("timeout of 5000ms"), false);
    assert.equal(JSON.stringify(outcome).includes("ECONNABORTED"), false);
  }
  const replay = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: failed.deps,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.status, 502);
  assert.equal(failed.pipelineCalls(), 1);
  assert.equal(failed.jobs()[0].status, "failed");
  assert.equal(failed.jobs()[0].error_code, "pipeline_failed");
});

test("a failed commit does not keep a recommendation and leaves a failed job", async () => {
  const world = createWorld();
  world.failNextCommit();
  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.details && (outcome.details as { errorCode?: string }).errorCode, "persist_failed");
  assert.equal(world.recommendations().length, 0);
  assert.equal(world.jobs()[0].status, "failed");
  assert.equal(world.jobs()[0].recommendation_id, null);
  assert.equal(world.pipelineCalls(), 1);
});

test("a running job without a recommendation stays reclaimable for a future worker", async () => {
  const world = createWorld();
  world.holdPipeline();
  const running = executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  await until(() => world.jobs().length === 1 && world.pipelineCalls() === 1);
  const job = world.jobs()[0];
  assert.equal(job.status, "running");
  assert.equal(job.recommendation_id, null);
  assert.equal(job.locked_by, "api-request");
  assert.equal(typeof job.locked_until, "string");
  assert.equal(world.recommendations().length, 0);
  world.releasePipeline();
  await running;
});

test("legacy recommendations are readable without generation_jobs", async () => {
  const calls: string[] = [];
  const query: DbQuery = async (sql, params = []) => {
    calls.push(sql);
    assert.equal(sql.includes("generation_jobs"), false);
    if (!sql.includes("FROM recommendations")) return empty();
    return rows([{
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      session_id: String(params[0]),
      summary: "Старая рекомендация",
      hypotheses: [],
      trial_ids: [],
      next_step: "Дальше",
      pathways: [],
      model_name: "sofi",
      created_at: SUBMITTED_AT,
      ai_payload: {},
      generation_mode: "llm",
      prompt_version: null,
      catalog_version: null,
      config_version: null,
    }]);
  };
  const row = await fetchLatestRecommendation(query, SESSION_A);
  const body = savedRecommendationBody(row ?? {}, []);
  assert.equal(body.summary, "Старая рекомендация");
  assert.equal("jobStatus" in body, false);
  assert.equal(calls.some((sql) => sql.includes("generation_jobs")), false);
});

test("a completed job without a recommendation and an unsafe error code stay closed", async () => {
  const incomplete = createWorld();
  incomplete.seed({
    id: crypto.randomUUID(),
    session_id: SESSION_A,
    client_request_id: REQUEST_ID,
    input_hash: hashFor(ANSWER),
    status: "completed",
    recommendation_id: null,
    error_code: null,
    stage_timings: {},
    attempt_count: 1,
    locked_by: null,
    locked_until: null,
  });
  const missing = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: incomplete.deps,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.status, 502);
    assert.equal((missing.details as { errorCode?: string }).errorCode, "incomplete_result");
  }
  assert.equal(incomplete.pipelineCalls(), 0);

  const poisoned = createWorld();
  poisoned.seed({
    id: crypto.randomUUID(),
    session_id: SESSION_A,
    client_request_id: REQUEST_ID,
    input_hash: hashFor(ANSWER),
    status: "failed",
    recommendation_id: null,
    error_code: ANSWER,
    stage_timings: {},
    attempt_count: 1,
    locked_by: null,
    locked_until: null,
  });
  const closed = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: poisoned.deps,
  });
  assert.equal(closed.ok, false);
  if (!closed.ok) {
    assert.equal((closed.details as { errorCode?: string }).errorCode, "pipeline_failed");
    assert.equal(JSON.stringify(closed).includes(ANSWER), false);
  }
  assert.equal(poisoned.pipelineCalls(), 0);
});

test("the same clarification input is saved once and then replayed", async () => {
  const world = createWorld();
  world.seedClarification("прежний-ответ");
  const body = {
    clarificationAnswers: [{ questionId: "agent_q2_work_style", answer: "solo" }],
  };
  const first = await executeGenerate({
    sessionId: SESSION_A,
    body,
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  const second = await executeGenerate({
    sessionId: SESSION_A,
    body,
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  const changed = await executeGenerate({
    sessionId: SESSION_A,
    body: { clarificationAnswers: [{ questionId: "agent_q2_work_style", answer: "team" }] },
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.recommendationId, first.body.recommendationId);
  }
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.status, 409);
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.clarificationInserts(), 1);
  const preparedAnswers = world.pipelinePrepared()?.normalizedAnswers ?? [];
  const usedClarification = preparedAnswers.find((item) => item.source === "clarification");
  assert.equal(usedClarification?.original, "solo");
  assert.equal(JSON.stringify(preparedAnswers).includes("прежний-ответ"), false);
  const storedSnapshot = JSON.parse(String(world.jobParams[0][3]));
  assert.equal(storedSnapshot.clarificationAnswers[0].answer, "solo");
  assert.equal(String(world.jobParams[0][2]).includes("solo"), false);
  assert.equal(JSON.stringify(first.ok ? first.body : {}).includes("solo"), false);
  assert.equal(JSON.stringify(second.ok ? second.body : {}).includes("solo"), false);
});

test("an invalid Idempotency-Key is rejected before a session lookup", async () => {
  const { register } = await import("node:module");
  register(new URL("./security-hooks.mjs", import.meta.url), import.meta.url);
  const route = await import("../app/api/recommendations/generate/route.ts");
  const response = await route.POST({
    headers: { get: (name: string) => name.toLowerCase() === "idempotency-key" ? "not-a-uuid" : null },
    text: async () => "{}",
  } as never);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Idempotency-Key must be a UUID");
});

test("saving and failing a job stay limited to the current owner", () => {
  assert.match(KEEP_LEASE_SQL, /locked_by = \$3 AND status = 'running'/);
  assert.match(FAIL_JOB_SQL, /locked_by = \$5/);
  assert.match(COMPLETE_OWNED_SQL, /locked_by = \$5/);
  assert.match(COMPLETE_JOB_SQL, /status IN \('pending', 'running'\)/);
  assert.equal(publicJobAccess("failed", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "saved");
  assert.equal(publicJobAccess("failed", null), "failed");
  assert.equal(publicJobAccess("completed", null), "incomplete");
  assert.equal(publicJobAccess("running", null), "pending");
});

test("a lost lease cannot save another owner's result", async () => {
  const world = createWorld();
  world.holdPipeline();
  const running = executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  await until(() => world.pipelineCalls() === 1);
  world.jobs()[0].locked_by = "worker-b";
  world.releasePipeline();
  const outcome = await running;
  assert.equal(outcome.ok && outcome.status, 202);
  assert.equal(world.pipelineCalls(), 1);
  assert.equal(world.recommendations().length, 0);
  assert.equal(world.jobs()[0].status, "running");
  assert.equal(world.jobs()[0].locked_by, "worker-b");
});

test("a pipeline error after a lost lease does not fail the new owner", async () => {
  const world = createWorld();
  world.holdPipeline();
  const running = executeGenerate({
    sessionId: SESSION_A,
    body: {},
    idempotencyKey: REQUEST_ID,
    deps: world.deps,
  });
  await until(() => world.pipelineCalls() === 1);
  world.jobs()[0].locked_by = "worker-b";
  world.failPipeline(new Error("model timeout"));
  world.releasePipeline();
  const outcome = await running;
  assert.equal(outcome.ok && outcome.status, 202);
  assert.equal(world.recommendations().length, 0);
  assert.equal(world.jobs()[0].status, "running");
  assert.equal(world.jobs()[0].locked_by, "worker-b");
  assert.equal(world.jobs()[0].error_code ?? null, null);
});
