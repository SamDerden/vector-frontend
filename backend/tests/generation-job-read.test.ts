import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./security-hooks.mjs", import.meta.url), import.meta.url);

const SESSION = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const RECOMMENDATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Job = {
  id: string;
  session_id: string;
  client_request_id: string;
  input_hash: string;
  status: string;
  recommendation_id: string | null;
  error_code: string | null;
  stage_timings: Record<string, unknown>;
  attempt_count: number;
  locked_by: string | null;
  locked_until: string | null;
};

const jobs = new Map<string, Job>();
const updates: string[] = [];

function recommendation() {
  return {
    id: RECOMMENDATION_ID,
    session_id: SESSION,
    summary: "Сохранено",
    hypotheses: [],
    trial_ids: [],
    next_step: "Дальше",
    pathways: [],
    model_name: "test",
    created_at: "2026-11-10T01:00:00.000Z",
    ai_payload: {},
    generation_mode: "retrieval_only",
    prompt_version: null,
    catalog_version: null,
    config_version: null,
  };
}

function seed(partial: Partial<Job>) {
  jobs.clear();
  updates.length = 0;
  jobs.set(JOB_ID, {
    id: JOB_ID,
    session_id: SESSION,
    client_request_id: REQUEST_ID,
    input_hash: "ab".repeat(32),
    status: "running",
    recommendation_id: RECOMMENDATION_ID,
    error_code: null,
    stage_timings: {},
    attempt_count: 1,
    locked_by: "api-request",
    locked_until: "2099-01-01T00:00:00.000Z",
    ...partial,
  });
}

globalThis.__securityQuery = async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FROM sessions")) {
    return String(params[0]) === SESSION
      ? { rowCount: 1, rows: [{ id: SESSION }] }
      : { rowCount: 0, rows: [] };
  }
  if (sql.includes("UPDATE generation_jobs")) {
    updates.push(sql);
    assert.match(sql, /locked_by IS NOT NULL/);
    assert.match(sql, /locked_until >= now\(\)/);
    assert.doesNotMatch(sql, /status IN \('pending', 'running'\)\s*$/);
    const job = jobs.get(String(params[0]));
    if (!job || job.session_id !== params[1]) return { rowCount: 0, rows: [] };
    const active = job.status === "running"
      && job.locked_by != null
      && job.locked_until != null
      && job.locked_until >= new Date().toISOString();
    if (active) return { rowCount: 0, rows: [] };
    job.status = "completed";
    job.recommendation_id = String(params[2]);
    job.locked_by = null;
    job.locked_until = null;
    return { rowCount: 1, rows: [job] };
  }
  if (sql.includes("FROM generation_jobs")) {
    const job = [...jobs.values()].find((item) => item.session_id === params[0] && item.client_request_id === params[1]);
    return job ? { rowCount: 1, rows: [job] } : { rowCount: 0, rows: [] };
  }
  if (sql.includes("FROM recommendations")) {
    return String(params[0]) === RECOMMENDATION_ID && params[1] === SESSION
      ? { rowCount: 1, rows: [recommendation()] }
      : { rowCount: 0, rows: [] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
};

const route = await import("../app/api/recommendations/jobs/[requestId]/route.ts");

function call() {
  return route.GET({
    headers: { get: (name: string) => name.toLowerCase() === "x-session-id" ? SESSION : null },
    url: `http://127.0.0.1/api/recommendations/jobs/${REQUEST_ID}`,
  } as never, { params: Promise.resolve({ requestId: REQUEST_ID }) });
}

test("reading a job does not take the lock from its active owner", async () => {
  seed({ locked_until: "2099-01-01T00:00:00.000Z", locked_by: "api-request", status: "running" });
  const response = await call();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recommendationId, RECOMMENDATION_ID);
  assert.equal(body.status, "generated");
  const job = jobs.get(JOB_ID);
  assert.equal(job?.status, "running");
  assert.equal(job?.locked_by, "api-request");
  assert.equal(updates.length, 1);
});

test("an expired owner can be replaced by the saved recommendation", async () => {
  seed({ locked_until: "2000-01-01T00:00:00.000Z", locked_by: "api-request", status: "running" });
  const response = await call();
  assert.equal(response.status, 200);
  const job = jobs.get(JOB_ID);
  assert.equal(job?.status, "completed");
  assert.equal(job?.locked_by, null);
  assert.equal(job?.recommendation_id, RECOMMENDATION_ID);
});
