/**
 * Real PostgreSQL checks for the isolated generation stand.
 * This file is not part of npm test and does not read .env or DATABASE_URL.
 * Run only after the stand is up:
 *   npm run test:generation-stand
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAIM_JOB_SQL,
  COMPLETE_OWNED_SQL,
  FAIL_JOB_SQL,
  KEEP_LEASE_SQL,
  completeGenerationJob,
  generationInputHash,
} from "../lib/generation-jobs.ts";
import { saveEducationRoute } from "../lib/education-route.ts";
import { consumeLimit, CapacityError } from "../lib/request-limits.ts";
import { executeTrackSelect } from "../lib/track-select.ts";
import { runGenerationOnce } from "../lib/generation-worker.ts";
import { issueSessionProof, sessionProofCookieName } from "../lib/session-proof.ts";
import { KEYED_RECOMMENDATION_INSERT_SQL } from "../lib/sofi-generate.ts";
import {
  WORKER_ATTACH_SQL,
  WORKER_CLAIM_SQL,
  WORKER_EXHAUST_SQL,
  WORKER_LOCK_SQL,
} from "../lib/generation-worker.ts";
import { applyStandMigrations, assertStandInvocation } from "../scripts/generation-stand-lib.mjs";

const standUrl = assertStandInvocation(process.env);
process.env.DATABASE_URL = standUrl;
process.env.PGSSL = "";

const SCHEMA_SQL = readFileSync(new URL("./sql/generation-stand-checks.sql", import.meta.url), "utf8");
const PAST = "2026-11-10T00:00:00.000Z";

function id(suffix) {
  return `00000000-0000-4000-8000-${suffix}`;
}

const snapshot = JSON.stringify({
  schemaVersion: 1,
  schoolGrade: 7,
  municipality: "Стенд",
  trackType: "explore",
  diagnosticId: id("000000000010"),
  diagnosticSubmittedAt: PAST,
  clarificationId: "",
  clarificationSubmittedAt: "",
  diagnosticAnswers: [{ questionId: "q-stand", answer: "synthetic-stand-answer", questionnaire: "stand" }],
  clarificationAnswers: [],
  professionIds: [],
});

async function openStand() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: standUrl, max: 4 });
  await applyStandMigrations(pool);
  await pool.query("DELETE FROM sessions WHERE id::text LIKE '00000000-0000-4000-8000-%'");
  return pool;
}

async function session(pool, sessionId) {
  await pool.query("INSERT INTO sessions (id, track_type) VALUES ($1, 'explore')", [sessionId]);
}

function recommendationParams(sessionId, jobId) {
  return [
    sessionId,
    "Синтетическая рекомендация стенда",
    "[]",
    [],
    "Дальше",
    "[]",
    "stand",
    null,
    null,
    null,
    "retrieval_only",
    "{}",
    jobId,
  ];
}

test.after(async () => {
  const { getPool } = await import("../lib/db.ts");
  await getPool().end();
});

test("schema constraints, foreign keys, and a rolled-back write", async () => {
  const pool = await openStand();
  try {
    const checks = await pool.query(SCHEMA_SQL);
    const failed = checks.rows.filter((row) => row.passed !== true).map((row) => row.check_name);
    assert.deepEqual(failed, []);

    const client = await pool.connect();
    const sessionId = id("000000000101");
    try {
      await client.query("BEGIN");
      await session(client, sessionId);
      await client.query(CLAIM_JOB_SQL, [sessionId, id("000000000102"), "a".repeat(64), snapshot]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const left = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE id = $1", [sessionId]);
    assert.equal(left.rows[0].n, 0);

    const rejected = await pool.connect();
    try {
      await rejected.query("BEGIN");
      await session(rejected, id("000000000103"));
      await assert.rejects(() => rejected.query(
        `INSERT INTO generation_jobs (session_id, client_request_id, input_hash, status)
         VALUES ($1, $2, 'hash', 'not-a-status')`,
        [id("000000000103"), id("000000000104")]
      ));
      await rejected.query("ROLLBACK");
    } finally {
      rejected.release();
    }
    const rejectedLeft = await pool.query("SELECT count(*)::int AS n FROM sessions WHERE id = $1", [id("000000000103")]);
    assert.equal(rejectedLeft.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});

test("one idempotency key inserts one job under parallel claims", async () => {
  const pool = await openStand();
  const sessionId = id("000000000201");
  const requestId = id("000000000202");
  try {
    await session(pool, sessionId);
    const params = [sessionId, requestId, "b".repeat(64), snapshot];
    const [left, right] = await Promise.all([
      pool.query(CLAIM_JOB_SQL, params),
      pool.query(CLAIM_JOB_SQL, params),
    ]);
    const inserted = [left, right].filter((result) => result.rowCount === 1);
    assert.equal(inserted.length, 1);
    const jobs = await pool.query(
      "SELECT count(*)::int AS n FROM generation_jobs WHERE session_id = $1 AND client_request_id = $2",
      [sessionId, requestId]
    );
    assert.equal(jobs.rows[0].n, 1);
  } finally {
    await pool.end();
  }
});

test("a second recommendation for the same job is rejected", async () => {
  const pool = await openStand();
  const sessionId = id("000000000301");
  const requestId = id("000000000302");
  try {
    await session(pool, sessionId);
    const claimed = await pool.query(CLAIM_JOB_SQL, [sessionId, requestId, "c".repeat(64), snapshot]);
    const jobId = String(claimed.rows[0].id);
    const first = await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, jobId));
    await assert.rejects(
      () => pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, jobId)),
      (error) => error && error.code === "23505"
    );
    const saved = await pool.query("SELECT count(*)::int AS n FROM recommendations WHERE generation_job_id = $1", [jobId]);
    assert.equal(saved.rows[0].n, 1);
    assert.equal(first.rowCount, 1);
  } finally {
    await pool.end();
  }
});

test("SKIP LOCKED does not hand a locked job to a second transaction", async () => {
  const pool = await openStand();
  const sessionId = id("000000000401");
  const firstClient = await pool.connect();
  const secondClient = await pool.connect();
  try {
    await session(pool, sessionId);
    await pool.query(
      `INSERT INTO generation_jobs (session_id, client_request_id, input_hash, status, attempt_count)
       VALUES ($1, $2, 'hash', 'pending', 0)`,
      [sessionId, id("000000000402")]
    );
    await firstClient.query("BEGIN");
    const first = await firstClient.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(first.rowCount, 1);
    await secondClient.query("BEGIN");
    const second = await secondClient.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(second.rowCount, 0);
    await secondClient.query("ROLLBACK");
    await firstClient.query("ROLLBACK");
  } finally {
    firstClient.release();
    secondClient.release();
    await pool.end();
  }
});

test("lease updates and completion require the current owner", async () => {
  const pool = await openStand();
  const sessionId = id("000000000501");
  const requestId = id("000000000502");
  try {
    await session(pool, sessionId);
    const claimed = await pool.query(CLAIM_JOB_SQL, [sessionId, requestId, "d".repeat(64), snapshot]);
    const jobId = String(claimed.rows[0].id);
    const wrongLease = await pool.query(KEEP_LEASE_SQL, [jobId, sessionId, "worker-other"]);
    assert.equal(wrongLease.rowCount, 0);
    const kept = await pool.query(KEEP_LEASE_SQL, [jobId, sessionId, "api-request"]);
    assert.equal(kept.rowCount, 1);
    const wrongFail = await pool.query(FAIL_JOB_SQL, [jobId, sessionId, "pipeline_failed", "{}", "worker-other"]);
    assert.equal(wrongFail.rowCount, 0);
    const stillRunning = await pool.query("SELECT status, locked_by FROM generation_jobs WHERE id = $1", [jobId]);
    assert.equal(stillRunning.rows[0].status, "running");
    assert.equal(stillRunning.rows[0].locked_by, "api-request");
    const saved = await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, jobId));
    const wrongComplete = await pool.query(COMPLETE_OWNED_SQL, [jobId, sessionId, saved.rows[0].id, "{}", "worker-other"]);
    assert.equal(wrongComplete.rowCount, 0);
    const completed = await pool.query(COMPLETE_OWNED_SQL, [jobId, sessionId, saved.rows[0].id, "{}", "api-request"]);
    assert.equal(completed.rowCount, 1);
  } finally {
    await pool.end();
  }
});

test("an expired running job can be claimed once and a saved recommendation is not generated again", async () => {
  const pool = await openStand();
  const sessionId = id("000000000601");
  const holder = await pool.connect();
  const other = await pool.connect();
  try {
    await session(pool, sessionId);
    const expired = await pool.query(CLAIM_JOB_SQL, [sessionId, id("000000000602"), "e".repeat(64), snapshot]);
    const expiredId = String(expired.rows[0].id);
    await pool.query("UPDATE generation_jobs SET locked_until = $2 WHERE id = $1", [expiredId, PAST]);
    await holder.query("BEGIN");
    const claimed = await holder.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(String(claimed.rows[0].id), expiredId);
    await other.query("BEGIN");
    const skipped = await other.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(skipped.rowCount, 0);
    const locked = await holder.query(WORKER_LOCK_SQL, [expiredId, "worker-stand"]);
    assert.equal(locked.rows[0].locked_by, "worker-stand");
    assert.equal(Number(locked.rows[0].attempt_count), 2);
    await other.query("ROLLBACK");
    await holder.query("COMMIT");

    const crashed = await pool.query(CLAIM_JOB_SQL, [sessionId, id("000000000603"), "f".repeat(64), snapshot]);
    const crashedId = String(crashed.rows[0].id);
    const saved = await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, crashedId));
    await pool.query("UPDATE generation_jobs SET locked_until = $2 WHERE id = $1", [crashedId, PAST]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const attached = await client.query(WORKER_ATTACH_SQL);
      const row = attached.rows.find((item) => String(item.id) === crashedId);
      assert.ok(row);
      assert.equal(String(row.saved_recommendation_id), String(saved.rows[0].id));
      await completeGenerationJob((sql, params) => client.query(sql, params), {
        jobId: crashedId,
        sessionId,
        recommendationId: String(saved.rows[0].id),
        stageTimings: {},
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const again = await pool.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(again.rows.some((row) => String(row.id) === crashedId), false);
    const count = await pool.query("SELECT count(*)::int AS n FROM recommendations WHERE generation_job_id = $1", [crashedId]);
    assert.equal(count.rows[0].n, 1);
  } finally {
    holder.release();
    other.release();
    await pool.end();
  }
});

test("attempt exhaustion is terminal and does not remove a saved recommendation", async () => {
  const pool = await openStand();
  const sessionId = id("000000000701");
  try {
    await session(pool, sessionId);
    const exhausted = await pool.query(
      `INSERT INTO generation_jobs (session_id, client_request_id, input_hash, status, attempt_count)
       VALUES ($1, $2, 'hash', 'pending', 3)
       RETURNING id`,
      [sessionId, id("000000000702")]
    );
    const savedJob = await pool.query(CLAIM_JOB_SQL, [sessionId, id("000000000703"), "g".repeat(64), snapshot]);
    const savedJobId = String(savedJob.rows[0].id);
    const saved = await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, savedJobId));
    await pool.query("UPDATE generation_jobs SET recommendation_id = NULL, attempt_count = 3, locked_until = $2 WHERE id = $1", [savedJobId, PAST]);
    await pool.query(WORKER_EXHAUST_SQL, [3]);
    const failed = await pool.query("SELECT status, error_code FROM generation_jobs WHERE id = $1", [exhausted.rows[0].id]);
    assert.equal(failed.rows[0].status, "failed");
    assert.equal(failed.rows[0].error_code, "attempts_exhausted");
    const kept = await pool.query("SELECT status, recommendation_id FROM generation_jobs WHERE id = $1", [savedJobId]);
    assert.equal(kept.rows[0].status, "running");
    assert.equal(kept.rows[0].recommendation_id, null);
    const recommendations = await pool.query("SELECT count(*)::int AS n FROM recommendations WHERE id = $1", [saved.rows[0].id]);
    assert.equal(recommendations.rows[0].n, 1);
    const retry = await pool.query(WORKER_CLAIM_SQL, [3]);
    assert.equal(retry.rows.some((row) => String(row.id) === String(exhausted.rows[0].id)), false);
  } finally {
    await pool.end();
  }
});

test("HTTP job and session routes restore only the owning session", async () => {
  const pool = await openStand();
  const owner = id("000000000801");
  const stranger = id("000000000802");
  const requestId = id("000000000803");
  try {
    await session(pool, owner);
    await session(pool, stranger);
    const claimed = await pool.query(CLAIM_JOB_SQL, [owner, requestId, "h".repeat(64), snapshot]);
    const jobId = String(claimed.rows[0].id);
    const { NextRequest } = await import("next/server");
    const jobs = await import("../app/api/recommendations/jobs/[requestId]/route.ts");
    const sessionRoute = await import("../app/api/session/route.ts");
    const call = (sessionId, path) => new NextRequest(`http://127.0.0.1:55432${path}`, {
      headers: { "X-Session-ID": sessionId },
    });

    const hidden = await jobs.GET(call(stranger, `/api/recommendations/jobs/${requestId}`), {
      params: Promise.resolve({ requestId }),
    });
    assert.equal(hidden.status, 404);

    const pending = await jobs.GET(call(owner, `/api/recommendations/jobs/${requestId}`), {
      params: Promise.resolve({ requestId }),
    });
    assert.equal(pending.status, 202);
    const sessionPending = await sessionRoute.GET(call(owner, "/api/session"));
    const pendingBody = await sessionPending.json();
    assert.equal(pendingBody.activeJob.requestId, requestId);
    assert.equal(pendingBody.activeJob.jobStatus, "running");
    assert.equal("recommendationId" in await pending.json(), false);

    const saved = await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(owner, jobId));
    await pool.query(COMPLETE_OWNED_SQL, [jobId, owner, saved.rows[0].id, "{}", "api-request"]);
    const firstRead = await jobs.GET(call(owner, `/api/recommendations/jobs/${requestId}`), {
      params: Promise.resolve({ requestId }),
    });
    const secondRead = await jobs.GET(call(owner, `/api/recommendations/jobs/${requestId}`), {
      params: Promise.resolve({ requestId }),
    });
    const firstBody = await firstRead.json();
    const secondBody = await secondRead.json();
    assert.equal(firstRead.status, 200);
    assert.equal(secondRead.status, 200);
    assert.equal(firstBody.status, "generated");
    assert.equal(firstBody.replayed, true);
    assert.equal(firstBody.requestId, requestId);
    assert.equal(firstBody.jobStatus, "completed");
    assert.equal(firstBody.recommendationId, saved.rows[0].id);
    assert.equal(secondBody.recommendationId, firstBody.recommendationId);
    assert.equal(secondBody.replayed, true);
    const count = await pool.query("SELECT count(*)::int AS n FROM recommendations WHERE generation_job_id = $1", [jobId]);
    assert.equal(count.rows[0].n, 1);
    const restored = await sessionRoute.GET(call(owner, "/api/session"));
    const restoredBody = await restored.json();
    assert.equal(restoredBody.recommendation.recommendationId, saved.rows[0].id);
    assert.equal("activeJob" in restoredBody, false);
  } finally {
    await pool.end();
  }
});

test("migrations 008-011 keep routes, expiry, budgets and journey steps", async () => {
  const pool = await openStand();
  const sessionId = id("000000000901");
  const otherId = id("000000000902");
  try {
    const applied = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(applied.rows.map((row) => row.filename), [
      "001_initial_schema.sql",
      "002_catalog_extension.sql",
      "003_clarifications_and_pathways.sql",
      "004_sofi_ai.sql",
      "005_hybrid_professions.sql",
      "006_hybrid_catalog.sql",
      "007_generation_jobs.sql",
      "008_education_routes.sql",
      "009_session_lifetime.sql",
      "010_request_budgets.sql",
      "011_reflection_journey.sql",
    ]);
    const catalog = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM professions) AS professions,
         (SELECT count(*)::int FROM education_programs) AS programs,
         (SELECT count(*)::int FROM organizations) AS organizations,
         (SELECT count(*)::int FROM professions WHERE graph_profession_id IS NOT NULL) AS linked_professions`
    );
    assert.equal(catalog.rows[0].professions, 0);
    assert.equal(catalog.rows[0].programs, 0);
    assert.equal(catalog.rows[0].organizations, 0);
    assert.equal(catalog.rows[0].linked_professions, 0);

    await session(pool, sessionId);
    await session(pool, otherId);
    const created = await saveEducationRoute(pool.query.bind(pool), sessionId, {
      professionKey: "none",
      completed: [0, 1],
      saved: ["prog_001"],
      version: null,
    });
    assert.equal(created.status, 201);
    assert.equal(created.route?.version, 1);
    const updated = await saveEducationRoute(pool.query.bind(pool), sessionId, {
      professionKey: "none",
      completed: [0, 1, 2],
      saved: ["prog_001"],
      version: 1,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.route?.version, 2);
    const stale = await saveEducationRoute(pool.query.bind(pool), sessionId, {
      professionKey: "none",
      completed: [4],
      saved: [],
      version: 1,
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.route?.completed, [0, 1, 2]);
    const hidden = await pool.query(
      "SELECT count(*)::int AS n FROM education_routes WHERE session_id = $1",
      [otherId]
    );
    assert.equal(hidden.rows[0].n, 0);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO education_routes (session_id, profession_key, completed, saved_ids)
         VALUES ($1, 'none', '{}', '{}')`,
        [sessionId]
      ),
      (error) => error && error.code === "23505"
    );

    await pool.query(
      "UPDATE sessions SET session_mode = 'own', expires_at = now() - interval '1 hour' WHERE id = $1",
      [sessionId]
    );
    const expired = await pool.query(
      "SELECT (expires_at IS NOT NULL AND expires_at <= now()) AS expired FROM sessions WHERE id = $1",
      [sessionId]
    );
    assert.equal(expired.rows[0].expired, true);
    await pool.query("UPDATE sessions SET expires_at = NULL WHERE id = $1", [otherId]);
    const legacy = await pool.query(
      `SELECT count(*)::int AS n
       FROM sessions
       WHERE id = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
      [otherId]
    );
    assert.equal(legacy.rows[0].n, 0);

    const budgetKey = "stand:budget:000000000901";
    const decisions = await Promise.allSettled([
      consumeLimit(pool.query.bind(pool), budgetKey, 60, 2),
      consumeLimit(pool.query.bind(pool), budgetKey, 60, 2),
      consumeLimit(pool.query.bind(pool), budgetKey, 60, 2),
    ]);
    assert.equal(decisions.filter((item) => item.status === "fulfilled").length, 2);
    assert.equal(decisions.filter((item) => item.status === "rejected" && item.reason instanceof CapacityError).length, 1);
    const used = await pool.query("SELECT used FROM request_budgets WHERE key = $1", [budgetKey]);
    assert.equal(used.rows[0].used, 2);
    await pool.query("DELETE FROM request_budgets WHERE key = $1", [budgetKey]);

    await pool.query("INSERT INTO profiles (session_id, school_grade) VALUES ($1, 3)", [otherId]);
    const reflection = await pool.query(
      `INSERT INTO reflections (session_id, rating, comment, journey_step)
       VALUES ($1, 'useful', 'synthetic-stand-reflection', 4)
       RETURNING journey_step`,
      [otherId]
    );
    assert.equal(reflection.rows[0].journey_step, 4);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO reflections (session_id, rating, journey_step)
         VALUES ($1, 'useful', 5)`,
        [otherId]
      ),
      (error) => error && error.code === "23514"
    );
  } finally {
    await pool.end();
  }
});

test("session proof, expiry and reflection handlers stay on the stand", async () => {
  const pool = await openStand();
  const owner = id("000000000a01");
  const expiredId = id("000000000a02");
  const previousFlag = process.env.SESSION_PROOF_ENFORCED;
  const previousSecret = process.env.SESSION_PROOF_SECRET;
  try {
    await session(pool, expiredId);
    await pool.query(
      "UPDATE sessions SET session_mode = 'demo', expires_at = now() - interval '2 hours' WHERE id = $1",
      [expiredId]
    );
    const { NextRequest } = await import("next/server");
    const sessionRoute = await import("../app/api/session/route.ts");
    const reflectionRoute = await import("../app/api/reflection/route.ts");
    const trackRoute = await import("../app/api/track/select/route.ts");
    const call = (sessionId: string, path: string, cookie?: string) => new NextRequest(`http://127.0.0.1:55432${path}`, {
      headers: {
        "X-Session-ID": sessionId,
        ...(cookie ? { cookie } : {}),
      },
    });
    const expired = await sessionRoute.GET(call(expiredId, "/api/session"));
    assert.equal(expired.status, 410);

    process.env.SESSION_PROOF_SECRET = "s".repeat(32);
    process.env.SESSION_PROOF_ENFORCED = "true";
    const created = await trackRoute.POST(new NextRequest("http://127.0.0.1:55432/api/track/select", {
      method: "POST",
      headers: { "X-Session-ID": owner, "content-type": "application/json" },
      body: JSON.stringify({ trackType: "explore" }),
    }));
    assert.equal(created.status, 200);
    const proof = created.cookies.get(sessionProofCookieName(owner))?.value;
    assert.equal(typeof proof, "string");
    assert.equal(issueSessionProof.length > 0, true);
    const denied = await sessionRoute.GET(call(owner, "/api/session"));
    assert.equal(denied.status, 403);
    const allowed = await sessionRoute.GET(call(owner, "/api/session", `${sessionProofCookieName(owner)}=${proof}`));
    assert.equal(allowed.status, 200);

    process.env.SESSION_PROOF_ENFORCED = "false";
    await pool.query("INSERT INTO profiles (session_id, school_grade) VALUES ($1, 3)", [owner]);
    const saved = await reflectionRoute.POST(new NextRequest("http://127.0.0.1:55432/api/reflection", {
      method: "POST",
      headers: { "X-Session-ID": owner, "content-type": "application/json" },
      body: JSON.stringify({ rating: "useful", stage: "final", comment: "synthetic-stand-final" }),
    }));
    assert.equal(saved.status, 201);
    const body = await saved.json();
    assert.equal(body.journeyStep, 4);
    assert.equal(body.stage, "final");
    assert.equal(body.ageTier, "1-4");
    const listed = await reflectionRoute.GET(call(owner, "/api/reflection"));
    const listedBody = await listed.json();
    assert.equal(listedBody.data[0].journeyStep, 4);
    assert.equal(listedBody.data[0].stage, "final");
  } finally {
    if (previousFlag === undefined) delete process.env.SESSION_PROOF_ENFORCED;
    else process.env.SESSION_PROOF_ENFORCED = previousFlag;
    if (previousSecret === undefined) delete process.env.SESSION_PROOF_SECRET;
    else process.env.SESSION_PROOF_SECRET = previousSecret;
    await pool.end();
  }
});

test("track mode conflict and a mock worker recover one recommendation", async () => {
  const pool = await openStand();
  const sessionId = id("000000000b01");
  const requestId = id("000000000b02");
  try {
    const first = await executeTrackSelect({
      sessionId,
      body: { trackType: "explore" },
      query: pool.query.bind(pool),
    });
    assert.equal(first.ok, true);
    const conflict = await executeTrackSelect({
      sessionId,
      body: { trackType: "explore", demoStudentId: 1 },
      query: pool.query.bind(pool),
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.status, 409);

    const standSnapshot = JSON.parse(snapshot);
    const standHash = generationInputHash(standSnapshot);
    const claimed = await pool.query(CLAIM_JOB_SQL, [sessionId, requestId, standHash, snapshot]);
    const jobId = String(claimed.rows[0].id);
    await pool.query("UPDATE generation_jobs SET locked_until = $2 WHERE id = $1", [jobId, PAST]);
    let pipelineCalls = 0;
    let generateCalls = 0;
    const deps = {
      query: (sql: string, params?: unknown[]) => pool.query(sql, params),
      connect: () => pool.connect(),
      pipeline: async () => {
        pipelineCalls += 1;
        throw new Error("real AI pipeline must not run");
      },
      generate: async ({ job, deps: workerDeps }: {
        job: { id: string; sessionId: string };
        deps: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
      }) => {
        generateCalls += 1;
        const saved = await workerDeps.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(job.sessionId, job.id));
        await completeGenerationJob(workerDeps.query, {
          jobId: job.id,
          sessionId: job.sessionId,
          recommendationId: String(saved.rows[0].id),
          stageTimings: {},
        });
        return { ok: true as const, status: 201 as const, body: {} };
      },
    };
    assert.equal(await runGenerationOnce(deps), true);
    assert.equal(generateCalls, 1);
    assert.equal(pipelineCalls, 0);
    assert.equal(await runGenerationOnce(deps), false);
    assert.equal(generateCalls, 1);
    const saved = await pool.query("SELECT count(*)::int AS n FROM recommendations WHERE generation_job_id = $1", [jobId]);
    assert.equal(saved.rows[0].n, 1);
    const finished = await pool.query("SELECT status FROM generation_jobs WHERE id = $1", [jobId]);
    assert.equal(finished.rows[0].status, "completed");

    const interrupted = id("000000000b03");
    const crashed = await pool.query(CLAIM_JOB_SQL, [sessionId, interrupted, standHash, snapshot]);
    const crashedId = String(crashed.rows[0].id);
    await pool.query(KEYED_RECOMMENDATION_INSERT_SQL, recommendationParams(sessionId, crashedId));
    await pool.query(
      "UPDATE generation_jobs SET recommendation_id = NULL, locked_until = $2, status = 'running' WHERE id = $1",
      [crashedId, PAST]
    );
    assert.equal(await runGenerationOnce(deps), true);
    assert.equal(generateCalls, 1);
    const recovered = await pool.query(
      "SELECT status, (SELECT count(*)::int FROM recommendations WHERE generation_job_id = $1) AS n FROM generation_jobs WHERE id = $1",
      [crashedId]
    );
    assert.equal(recovered.rows[0].status, "completed");
    assert.equal(recovered.rows[0].n, 1);

    await pool.query(
      `INSERT INTO generation_jobs (session_id, client_request_id, input_hash, status, attempt_count)
       VALUES ($1, $2, 'hash', 'pending', 3)`,
      [sessionId, id("000000000b04")]
    );
    assert.equal(await runGenerationOnce(deps), false);
    assert.equal(generateCalls, 1);
    const exhausted = await pool.query(
      "SELECT status, error_code FROM generation_jobs WHERE client_request_id = $1",
      [id("000000000b04")]
    );
    assert.equal(exhausted.rows[0].status, "failed");
    assert.equal(exhausted.rows[0].error_code, "attempts_exhausted");
  } finally {
    await pool.end();
  }
});
