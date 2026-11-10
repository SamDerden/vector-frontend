import assert from "node:assert/strict";
import test from "node:test";

import {
  generationInputHash,
  KEEP_LEASE_SQL,
  parseGenerationSnapshot,
  type GenerationInputSnapshot,
} from "../lib/generation-jobs.ts";
import {
  runGenerationOnce,
  startGenerationWorker,
  WORKER_ATTACH_SQL,
  WORKER_CLAIM_SQL,
  WORKER_EXHAUST_SQL,
  WORKER_LOCK_SQL,
  WORKER_RENEW_SQL,
  type WorkerDeps,
} from "../lib/generation-worker.ts";
import { executeGenerate, type DbQuery, type DbQueryResult, type GenerateOutcome } from "../lib/sofi-generate.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const REQUEST_A = "33333333-3333-4333-8333-333333333333";
const REQUEST_B = "44444444-4444-4444-8444-444444444444";

function empty(): DbQueryResult {
  return { rowCount: 0, rows: [] };
}

function result(rows: Array<Record<string, unknown>>): DbQueryResult {
  return { rowCount: rows.length, rows };
}

function snapshot(answer = "сохранённый-ответ"): GenerationInputSnapshot {
  return {
    schemaVersion: 1,
    schoolGrade: 7,
    municipality: "Екатеринбург",
    trackType: "explore",
    diagnosticId: "55555555-5555-4555-8555-555555555555",
    diagnosticSubmittedAt: "2026-11-10T00:00:00.000Z",
    clarificationId: "",
    clarificationSubmittedAt: "",
    diagnosticAnswers: [{ questionId: "q1", answer, questionnaire: "Билет" }],
    clarificationAnswers: [],
    professionIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  };
}

type Job = Record<string, unknown>;
type Tables = { jobs: Job[]; recommendations: Job[] };

const DB_NOW = "2026-11-10T03:00:00.000Z";
const DB_LEASE = "2026-11-10T06:00:00.000Z";

function createStore() {
  let committed: Tables = { jobs: [], recommendations: [] };
  const locks = new Map<string, symbol>();
  let holdCommit: Promise<void> | null = null;
  let renewals = 0;
  const connections: Array<{ data: Tables | null; token: symbol }> = [];

  function createQuery(local: { data: Tables | null; token: symbol }): DbQuery {
    const view = () => local.data ?? committed;
    return async (sql, params = []) => {
      if (sql === "BEGIN") {
        if (local.data) throw new Error("nested transaction");
        local.data = structuredClone(committed);
        return empty();
      }
      if (sql === "ROLLBACK") {
        locks.forEach((token, id) => { if (token === local.token) locks.delete(id); });
        local.data = null;
        return empty();
      }
      if (sql === "COMMIT") {
        if (!local.data) return empty();
        if (holdCommit) {
          const waiting = holdCommit;
          holdCommit = null;
          await waiting;
        }
        committed = local.data;
        locks.forEach((token, id) => { if (token === local.token) locks.delete(id); });
        local.data = null;
        return empty();
      }
      if (sql.includes("FOR UPDATE OF j")) {
        const job = view().jobs.find((item) => {
          if (locks.has(String(item.id)) && locks.get(String(item.id)) !== local.token) return false;
          if (item.status !== "pending" && item.status !== "running") return false;
          if (item.status === "running" && String(item.locked_until) >= DB_NOW) return false;
          const linked = view().recommendations.find((row) => row.generation_job_id === item.id && row.session_id === item.session_id);
          return item.recommendation_id != null || linked;
        });
        if (!job || !local.data) return empty();
        locks.set(String(job.id), local.token);
        const linked = view().recommendations.find((row) => row.generation_job_id === job.id && row.session_id === job.session_id);
        return result([{ ...job, saved_recommendation_id: job.recommendation_id ?? linked?.id ?? null }]);
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        const max = Number(params[0]);
        const job = view().jobs.find((item) => {
          if (locks.has(String(item.id)) && locks.get(String(item.id)) !== local.token) return false;
          if (Number(item.attempt_count) >= max || item.recommendation_id != null) return false;
          if (item.status === "pending") return true;
          return item.status === "running" && String(item.locked_until) < DB_NOW;
        });
        if (!job || !local.data) return empty();
        locks.set(String(job.id), local.token);
        return result([job]);
      }
      if (sql.includes("locked_until = now()") && sql.includes("session_id = $2")) {
        const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && item.locked_by === params[2] && item.status === "running");
        if (!job || !local.data) return empty();
        if (locks.has(String(job.id)) && locks.get(String(job.id)) !== local.token) return empty();
        locks.set(String(job.id), local.token);
        job.locked_until = "2026-11-10T06:00:00.000Z";
        return result([{ id: job.id }]);
      }
      if (sql.includes("attempt_count = attempt_count + 1")) {
        const job = view().jobs.find((item) => item.id === params[0]);
        if (!job) return empty();
        job.status = "running";
        job.locked_by = params[1];
        job.locked_until = DB_LEASE;
        job.attempt_count = Number(job.attempt_count) + 1;
        return result([job]);
      }
      if (sql.includes("now() + interval") && sql.includes("locked_by = $2") && !sql.includes("attempt_count = attempt_count + 1")) {
        renewals += 1;
        const job = view().jobs.find((item) => item.id === params[0] && item.locked_by === params[1] && item.status === "running");
        if (!job) return empty();
        job.locked_until = DB_LEASE;
        return result([job]);
      }
      if (sql.includes("status = 'pending'")) {
        const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && item.locked_by === params[2]);
        if (!job) return empty();
        job.status = "pending";
        job.locked_by = null;
        job.locked_until = null;
        return result([job]);
      }
      if (sql.includes("attempts_exhausted") || sql.includes("status = 'failed'")) {
        if (sql.includes("attempt_count >= $1")) {
          const protectSaved = sql.includes("NOT EXISTS");
          let changed = 0;
          for (const job of view().jobs) {
            const expired = job.status === "pending" || String(job.locked_until) < DB_NOW;
            const linked = protectSaved && view().recommendations.some((row) => row.generation_job_id === job.id);
            if (!expired || job.recommendation_id != null || linked) continue;
            if (Number(job.attempt_count) < Number(params[0])) continue;
            if (job.status !== "pending" && job.status !== "running") continue;
            job.status = "failed";
            job.error_code = "attempts_exhausted";
            job.locked_by = null;
            job.locked_until = null;
            changed += 1;
          }
          return { rowCount: changed, rows: [] };
        }
        const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && (item.status === "running" || item.status === "pending"));
        if (!job) return empty();
        if (sql.includes("locked_by = $5") && job.locked_by !== params[4]) return empty();
        job.status = "failed";
        job.error_code = params[2];
        job.locked_by = null;
        job.locked_until = null;
        return result([job]);
      }
      if (sql.includes("status = 'completed'")) {
        const job = view().jobs.find((item) => item.id === params[0] && item.session_id === params[1] && (item.status === "running" || item.status === "pending"));
        if (!job) return empty();
        if (sql.includes("locked_by = $5") && job.locked_by !== params[4]) return empty();
        job.status = "completed";
        job.recommendation_id = params[2];
        job.locked_by = null;
        job.locked_until = null;
        job.error_code = null;
        return result([job]);
      }
      if (sql.includes("generation_job_id = $1")) {
        const row = view().recommendations.find((item) => item.generation_job_id === params[0] && item.session_id === params[1]);
        return row ? result([{ id: row.id }]) : empty();
      }
      if (sql.includes("client_request_id = $2")) {
        const row = view().jobs.find((item) => item.session_id === params[0] && item.client_request_id === params[1]);
        return row ? result([row]) : empty();
      }
      if (sql.includes("INSERT INTO recommendations")) {
        if (view().recommendations.some((item) => params[12] != null && item.generation_job_id === params[12])) {
          throw Object.assign(new Error("duplicate job recommendation"), { code: "23505" });
        }
        const row = { id: crypto.randomUUID(), session_id: params[0], generation_job_id: params[12] ?? null, summary: params[1] };
        view().recommendations.push(row);
        return result([{ id: row.id, created_at: "2026-11-10T01:00:00.000Z" }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
  }

  const root = createQuery({ data: null, token: Symbol("root") });
  return {
    query: root,
    connect: async () => {
      const local = { data: null as Tables | null, token: Symbol("conn") };
      connections.push(local);
      return { query: createQuery(local), release() {} };
    },
    jobs: () => committed.jobs,
    recommendations: () => committed.recommendations,
    renewals: () => renewals,
    lockCount: () => locks.size,
    holdNextCommit() {
      holdCommit = new Promise((resolve) => { this.releaseCommit = resolve; });
    },
    releaseCommit() {},
    seed(jobRow: Job) { committed.jobs.push(jobRow); },
    seedRecommendation(row: Job) { committed.recommendations.push(row); },
  };
}
function job(partial: Job): Job {
  const input = (partial.input_snapshot as GenerationInputSnapshot | undefined) ?? snapshot();
  const parsed = parseGenerationSnapshot(input);
  return {
    id: crypto.randomUUID(),
    session_id: SESSION_A,
    client_request_id: REQUEST_A,
    input_hash: parsed ? generationInputHash(parsed) : "ab".repeat(32),
    input_snapshot: input,
    status: "pending",
    recommendation_id: null,
    error_code: null,
    stage_timings: {},
    attempt_count: 0,
    locked_by: null,
    locked_until: null,
    ...partial,
  };
}

function deps(store: ReturnType<typeof createStore>, generate: WorkerDeps["generate"], workerId = "worker-a"): WorkerDeps {
  return {
    query: store.query,
    connect: store.connect,
    pipeline: async () => { throw new Error("the worker test must not call the model directly"); },
    workerId,
    renewEveryMs: 30,
    idleMs: 20,
    generate,
  };
}

test("worker SQL locks one row and skips a locked row", () => {
  assert.match(WORKER_CLAIM_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(WORKER_CLAIM_SQL, /attempt_count < \$1/);
  assert.match(WORKER_CLAIM_SQL, /locked_until < now\(\)/);
  assert.match(WORKER_LOCK_SQL, /now\(\) \+ interval '3 minutes'/);
  assert.match(WORKER_RENEW_SQL, /now\(\) \+ interval '3 minutes'/);
  assert.match(WORKER_ATTACH_SQL, /locked_until < now\(\)/);
  assert.match(WORKER_EXHAUST_SQL, /locked_until < now\(\)/);
  assert.doesNotMatch(WORKER_CLAIM_SQL, /\$2|timestamptz/);
  assert.doesNotMatch(WORKER_LOCK_SQL, /\$3/);
  assert.doesNotMatch(WORKER_CLAIM_SQL, /уникальный|ответ/);
});

test("a lease that is still valid for PostgreSQL is not stolen by the worker", async () => {
  const store = createStore();
  store.seed(job({
    status: "running",
    locked_by: "api-request",
    locked_until: "2026-11-10T04:00:00.000Z",
    attempt_count: 1,
  }));
  let calls = 0;
  const worked = await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }));
  assert.equal(worked, false);
  assert.equal(calls, 0);
  assert.equal(store.jobs()[0].locked_by, "api-request");
  assert.equal(store.jobs()[0].attempt_count, 1);
});

test("two workers do not claim the same job", async () => {
  const store = createStore();
  store.seed(job({}));
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  store.holdNextCommit();
  const first = runGenerationOnce(deps(store, async () => {
    calls += 1;
    await gate;
    return { ok: true, status: 201, body: {} };
  }, "worker-a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }, "worker-b"));
  assert.equal(second, false);
  assert.equal(calls, 0);
  store.releaseCommit();
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
});

test("an expired running job is claimed and its lease is renewed", async () => {
  const store = createStore();
  store.seed(job({
    status: "running",
    locked_by: "api-request",
    locked_until: "2026-11-10T02:00:00.000Z",
    attempt_count: 1,
  }));
  let seenLease = "";
  const worked = await runGenerationOnce(deps(store, async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    seenLease = String(store.jobs()[0].locked_until);
    return { ok: true, status: 201, body: {} };
  }));
  assert.equal(worked, true);
  assert.equal(store.renewals() > 0, true);
  assert.notEqual(seenLease, "2026-11-10T02:00:00.000Z");
  assert.equal(store.jobs()[0].attempt_count, 2);
});

test("a saved recommendation is attached without another generation", async () => {
  const store = createStore();
  const current = job({ status: "running", locked_until: "2026-11-10T02:00:00.000Z", attempt_count: 1 });
  store.seed(current);
  store.seedRecommendation({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", session_id: SESSION_A, generation_job_id: current.id, summary: "Уже сохранено" });
  let calls = 0;
  const worked = await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }));
  assert.equal(worked, true);
  assert.equal(calls, 0);
  assert.equal(store.jobs()[0].status, "completed");
  assert.equal(store.jobs()[0].recommendation_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(store.recommendations().length, 1);
});

test("a changed snapshot does not return the previous recommendation", async () => {
  const store = createStore();
  const input = snapshot("новый-ответ");
  store.seed(job({
    status: "running",
    locked_until: "2026-11-10T02:00:00.000Z",
    input_snapshot: input,
    input_hash: generationInputHash(snapshot("старый-ответ")),
    attempt_count: 1,
  }));
  store.seedRecommendation({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", session_id: SESSION_A, generation_job_id: null, summary: "Старый результат" });
  let calls = 0;
  await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: { summary: "Старый результат" } };
  }));
  assert.equal(calls, 0);
  assert.equal(store.jobs()[0].status, "failed");
  assert.equal(store.jobs()[0].error_code, "input_mismatch");
  assert.equal(store.jobs()[0].recommendation_id, null);
});

test("a retryable failure stops after the attempt limit", async () => {
  const store = createStore();
  store.seed(job({}));
  let calls = 0;
  const failing: WorkerDeps["generate"] = async () => {
    calls += 1;
    return { ok: false, status: 502, error: "AI service request failed", details: { errorCode: "pipeline_failed" } };
  };
  for (let attempt = 0; attempt < 4; attempt += 1) await runGenerationOnce(deps(store, failing));
  assert.equal(calls, 3);
  assert.equal(store.jobs()[0].status, "failed");
  assert.equal(store.jobs()[0].error_code, "attempts_exhausted");
  await runGenerationOnce(deps(store, failing));
  assert.equal(calls, 3);
});

test("input mismatch is not retried", async () => {
  const store = createStore();
  store.seed(job({ input_snapshot: { schemaVersion: 1 }, input_hash: "ab".repeat(32) }));
  let calls = 0;
  await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }));
  await runGenerationOnce(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }));
  assert.equal(calls, 0);
  assert.equal(store.jobs()[0].status, "failed");
  assert.equal(store.jobs()[0].error_code, "input_unavailable");
});

test("stopping the worker leaves the next pending job untouched", async () => {
  const store = createStore();
  store.seed(job({ client_request_id: REQUEST_A }));
  store.seed(job({ client_request_id: REQUEST_B }));
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stop = startGenerationWorker(deps(store, async () => {
    calls += 1;
    await gate;
    return { ok: true, status: 201, body: {} } satisfies GenerateOutcome;
  }));
  for (let attempt = 0; attempt < 50 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stopping = stop();
  release();
  await stopping;
  assert.equal(calls, 1);
  const pending = store.jobs().filter((item) => item.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].client_request_id, REQUEST_B);
});

test("another session cannot read the job by the same request id", async () => {
  const store = createStore();
  store.seed(job({}));
  const own = await store.query(
    "SELECT id FROM generation_jobs WHERE session_id = $1 AND client_request_id = $2",
    [SESSION_A, REQUEST_A]
  );
  const foreign = await store.query(
    "SELECT id FROM generation_jobs WHERE session_id = $1 AND client_request_id = $2",
    [SESSION_B, REQUEST_A]
  );
  assert.equal(own.rowCount, 1);
  assert.equal(foreign.rowCount, 0);
});

test("a request without an idempotency key does not take a worker lock", async () => {
  const calls: string[] = [];
  const outcome = await executeGenerate({
    sessionId: SESSION_A,
    body: {},
    deps: {
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes("FOR UPDATE") || sql.includes("generation_jobs")) throw new Error("worker SQL on the legacy path");
        if (sql.includes("FROM diagnostics")) return result([{ id: "55555555-5555-4555-8555-555555555555", answers: [] }]);
        if (sql.includes("FROM profiles")) return result([{ school_grade: 7, municipality: "Екатеринбург" }]);
        if (sql.includes("FROM professions")) return result([{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Инженер", graph_profession_id: "prof_004" }]);
        if (sql.includes("FROM clarifications") || sql.includes("FROM professional_trials") || sql.includes("FROM education_programs")) return empty();
        if (sql.includes("INSERT INTO recommendations")) return result([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_at: "2026-11-10T01:00:00.000Z" }]);
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      connect: async () => ({ query: async () => empty(), release() {} }),
      pipeline: async () => ({ summary: "Без ключа", next_step: "Дальше", hypotheses: [], warnings: [], generation: { mode: "retrieval_only", tier: "5-8", promptVersion: null, catalogVersion: "hybrid_v2", configVersion: "age-1", attempts: 0 } }),
      modelName: "test-model",
    },
  });
  assert.equal(outcome.ok && outcome.status, 201);
  assert.equal(calls.some((sql) => sql.includes("generation_jobs") || sql.includes("FOR UPDATE")), false);
});

test("an active HTTP lease blocks a concurrent worker", async () => {
  const store = createStore();
  const current = job({
    status: "running",
    locked_by: "api-request",
    locked_until: "2026-11-10T02:00:00.000Z",
    attempt_count: 1,
  });
  store.seed(current);
  store.holdNextCommit();
  const client = await store.connect();
  const renew = (async () => {
    await client.query("BEGIN");
    const kept = await client.query(KEEP_LEASE_SQL, [current.id, SESSION_A, "api-request"]);
    assert.equal(kept.rows.length, 1);
    await client.query("COMMIT");
    client.release();
  })();
  for (let attempt = 0; attempt < 50 && store.lockCount() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(store.lockCount(), 1);
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return { ok: true as const, status: 201 as const, body: {} };
  };
  const claimed = await runGenerationOnce(deps(store, generate));
  assert.equal(claimed, false);
  assert.equal(calls, 0);
  store.releaseCommit();
  await renew;
  const again = await runGenerationOnce(deps(store, generate));
  assert.equal(again, false);
  assert.equal(calls, 0);
  assert.equal(store.jobs()[0].locked_by, "api-request");
  assert.equal(store.jobs()[0].status, "running");
});

test("exhausting attempts does not hide a recommendation already saved for another job", async () => {
  assert.match(WORKER_EXHAUST_SQL, /NOT EXISTS/);
  const store = createStore();
  const first = job({ status: "running", locked_until: "2026-11-10T02:00:00.000Z", attempt_count: 3 });
  const second = job({
    client_request_id: REQUEST_B,
    status: "running",
    locked_until: "2026-11-10T02:00:00.000Z",
    attempt_count: 3,
  });
  store.seed(first);
  store.seed(second);
  store.seedRecommendation({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", session_id: SESSION_A, generation_job_id: first.id });
  store.seedRecommendation({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", session_id: SESSION_A, generation_job_id: second.id });
  const generate = async () => {
    throw new Error("saved jobs must not call the model");
  };
  assert.equal(await runGenerationOnce(deps(store, generate)), true);
  assert.equal(await runGenerationOnce(deps(store, generate)), true);
  assert.equal(store.jobs().every((item) => item.status === "completed"), true);
  assert.equal(store.recommendations().length, 2);
});

test("a restarted worker picks up the pending job left by the previous process", async () => {
  const store = createStore();
  store.seed(job({ client_request_id: REQUEST_A }));
  store.seed(job({ client_request_id: REQUEST_B }));
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const stop = startGenerationWorker(deps(store, async () => {
    calls += 1;
    await gate;
    return { ok: true, status: 201, body: {} };
  }));
  for (let attempt = 0; attempt < 50 && calls === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stopping = stop();
  release();
  await stopping;
  assert.equal(store.jobs().filter((item) => item.status === "pending").length, 1);
  const restarted = startGenerationWorker(deps(store, async () => {
    calls += 1;
    return { ok: true, status: 201, body: {} };
  }, "worker-b"));
  for (let attempt = 0; attempt < 50 && calls < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await restarted();
  assert.equal(calls, 2);
  assert.equal(store.jobs().some((item) => item.client_request_id === REQUEST_B && item.attempt_count > 0), true);
});
