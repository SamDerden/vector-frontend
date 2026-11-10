import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("./security-hooks.mjs", import.meta.url), import.meta.url);

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const REC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DIAG_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DIAG_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLAR_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLAR_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OWNER = "owner-session-marker";
const FOREIGN = "foreign-session-marker";

type SqlRow = Record<string, unknown>;
type SqlResult = { rowCount: number | null; rows: SqlRow[] };
type SqlCall = { sql: string; params: unknown[] };

type World = {
  calls: SqlCall[];
  writes: SqlCall[];
  sessions: Map<string, SqlRow>;
  profiles: Map<string, SqlRow>;
  diagnostics: Map<string, SqlRow>;
  diagnosticSessions: Map<string, string>;
  clarifications: Map<string, SqlRow>;
  recommendations: Map<string, SqlRow>;
  recommendationOwner: Map<string, string>;
  reflections: Map<string, SqlRow[]>;
};

declare global {
  var __securityQuery: (sql: string, params?: unknown[]) => Promise<SqlResult>;
}

function empty(): SqlResult {
  return { rowCount: 0, rows: [] };
}

function rowsOf(rows: SqlRow[]): SqlResult {
  return { rowCount: rows.length, rows };
}

function bindsSession(sql: string) {
  return /session_id\s*=\s*\$\d+/i.test(sql) || /where\s+id\s*=\s*\$1/i.test(sql);
}

function leakedRows(values: Iterable<SqlRow>) {
  return [...values];
}

function createWorld(): World {
  const recommendation = (id: string, sessionId: string, summary: string): SqlRow => ({
    id,
    session_id: sessionId,
    summary,
    hypotheses: [],
    trial_ids: [],
    next_step: summary,
    pathways: [],
    model_name: "test",
    created_at: "2026-11-05T00:00:00.000Z",
    ai_payload: {},
    generation_mode: null,
    prompt_version: null,
    catalog_version: null,
    config_version: null,
  });
  const diagnostic = (id: string, answer: string): SqlRow => ({
    id,
    submitted_at: "2026-11-05T00:00:00.000Z",
    answers: [{ questionId: "q1", answer }],
  });
  const clarification = (id: string, answer: string): SqlRow => ({
    id,
    submitted_at: "2026-11-05T00:00:00.000Z",
    answers: [{ questionId: "agent_q2_work_style", answer }],
  });

  const world: World = {
    calls: [],
    writes: [],
    sessions: new Map([
      [SESSION_A, { id: SESSION_A, track_type: "interests", created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }],
      [SESSION_B, { id: SESSION_B, track_type: "explore", created_at: "2026-11-02T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z" }],
    ]),
    profiles: new Map([
      [SESSION_A, { school_grade: 7, municipality: "Екатеринбург", preferences: {} }],
      [SESSION_B, { school_grade: 10, municipality: "Екатеринбург", preferences: {} }],
    ]),
    diagnostics: new Map([
      [SESSION_A, diagnostic(DIAG_A, OWNER)],
      [SESSION_B, diagnostic(DIAG_B, FOREIGN)],
    ]),
    diagnosticSessions: new Map([
      [DIAG_A, SESSION_A],
      [DIAG_B, SESSION_B],
    ]),
    clarifications: new Map([
      [SESSION_A, clarification(CLAR_A, OWNER)],
      [SESSION_B, clarification(CLAR_B, FOREIGN)],
    ]),
    recommendations: new Map([
      [SESSION_B, recommendation(REC_B, SESSION_B, FOREIGN)],
      [SESSION_A, recommendation(REC_A, SESSION_A, OWNER)],
    ]),
    recommendationOwner: new Map([
      [REC_A, SESSION_A],
      [REC_B, SESSION_B],
    ]),
    reflections: new Map([
      [SESSION_A, [{ id: "refl-a", recommendation_id: REC_A, rating: "useful", comment: OWNER, created_at: "2026-11-05T00:00:00.000Z" }]],
      [SESSION_B, [{ id: "refl-b", recommendation_id: REC_B, rating: "unsure", comment: FOREIGN, created_at: "2026-11-05T00:00:00.000Z" }]],
    ]),
  };

  globalThis.__securityQuery = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    world.calls.push({ sql: text, params });

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return empty();
    }

    if (/^insert\s+into\s+diagnostics\b/i.test(text)) {
      world.writes.push({ sql: text, params });
      const sessionId = String(params[0]);
      const id = `new-diag-${sessionId}`;
      world.diagnosticSessions.set(id, sessionId);
      world.diagnostics.set(sessionId, {
        id,
        submitted_at: "2026-11-05T12:00:00.000Z",
        answers: [],
      });
      return { rowCount: 1, rows: [{ id }] };
    }

    if (/^insert\s+into\s+diagnostic_answers\b/i.test(text)) {
      world.writes.push({ sql: text, params });
      const diagnosticId = String(params[0]);
      const sessionId = world.diagnosticSessions.get(diagnosticId);
      const row = sessionId ? world.diagnostics.get(sessionId) : undefined;
      const answers = row?.answers;
      if (row && Array.isArray(answers)) {
        answers.push({
          questionId: params[1],
          answer: JSON.parse(String(params[2])),
        });
      }
      return { rowCount: 1, rows: [] };
    }

    if (/^insert\s+into\s+clarifications\b/i.test(text)) {
      world.writes.push({ sql: text, params });
      const sessionId = String(params[0]);
      const id = `new-clar-${sessionId}`;
      world.clarifications.set(sessionId, {
        id,
        diagnostic_id: params[1],
        submitted_at: "2026-11-05T12:00:00.000Z",
        answers: [],
      });
      return { rowCount: 1, rows: [{ id }] };
    }

    if (/^insert\s+into\s+clarification_answers\b/i.test(text)) {
      world.writes.push({ sql: text, params });
      const clarificationId = String(params[0]);
      for (const row of world.clarifications.values()) {
        if (row.id !== clarificationId || !Array.isArray(row.answers)) continue;
        row.answers.push({
          questionId: params[1],
          answer: JSON.parse(String(params[2])),
        });
      }
      return { rowCount: 1, rows: [] };
    }

    if (/^insert\s+into\s+reflections\b/i.test(text)) {
      world.writes.push({ sql: text, params });
      const sessionId = String(params[0]);
      const createdAt = "2026-11-05T12:00:00.000Z";
      const list = world.reflections.get(sessionId) ?? [];
      list.unshift({
        id: "new-reflection",
        recommendation_id: params[1],
        rating: params[2],
        comment: params[3],
        created_at: createdAt,
      });
      world.reflections.set(sessionId, list);
      return { rowCount: 1, rows: [{ id: "new-reflection", created_at: createdAt }] };
    }

    if (text.includes("FROM recommendations") && /where\s+id\s*=\s*\$1/i.test(text)) {
      const id = String(params[0]);
      const owner = world.recommendationOwner.get(id);
      if (!owner) return empty();
      if (/session_id\s*=\s*\$2/i.test(text)) {
        return owner === params[1] ? { rowCount: 1, rows: [{ id }] } : empty();
      }
      return { rowCount: 1, rows: [{ id }] };
    }

    if (text.includes("FROM recommendations")) {
      if (!/session_id\s*=\s*\$1/i.test(text)) {
        return rowsOf([...world.recommendations.values()]);
      }
      const row = world.recommendations.get(String(params[0]));
      return row ? rowsOf([row]) : empty();
    }

    if (text.includes("FROM professional_trials")) {
      return empty();
    }

    if (text.includes("FROM sessions")) {
      if (!bindsSession(text)) return rowsOf([...world.sessions.values()]);
      const row = world.sessions.get(String(params[0]));
      if (!row) return empty();
      if (text.includes("track_type")) return rowsOf([row]);
      return rowsOf([{ id: row.id }]);
    }

    if (text.includes("FROM profiles")) {
      if (!bindsSession(text)) return rowsOf(leakedRows(world.profiles.values()));
      const row = world.profiles.get(String(params[0]));
      return row ? rowsOf([row]) : empty();
    }

    if (text.includes("FROM diagnostics")) {
      if (!bindsSession(text)) return rowsOf([...world.diagnostics.values()]);
      const row = world.diagnostics.get(String(params[0]));
      if (!row) return empty();
      if (text.includes("json_agg")) return rowsOf([row]);
      return rowsOf([{ id: row.id }]);
    }

    if (text.includes("FROM clarifications")) {
      if (!bindsSession(text)) return rowsOf([...world.clarifications.values()]);
      const row = world.clarifications.get(String(params[0]));
      return row ? rowsOf([row]) : empty();
    }

    if (text.includes("FROM generation_jobs")) {
      if (!bindsSession(text)) throw new Error("generation job query must bind the session");
      return empty();
    }

    if (text.includes("FROM reflections")) {
      if (!bindsSession(text)) {
        return rowsOf([...world.reflections.values()].flat());
      }
      return rowsOf(world.reflections.get(String(params[0])) ?? []);
    }

    throw new Error(`unexpected SQL in security mock: ${text}`);
  };

  return world;
}

function request(sessionId: string | null, body: unknown = {}) {
  const raw = JSON.stringify(body);
  return {
    headers: {
      get(name: string) {
        return name.toLowerCase() === "x-session-id" ? sessionId : null;
      },
    },
    json: async () => body,
    text: async () => raw,
  };
}

function assertNoForeignMarker(payload: unknown) {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(FOREIGN), false);
  assert.equal(serialized.includes(OWNER), true);
}

function sessionIds(world: World) {
  return world.calls.map((call) => {
    if (/where\s+id\s*=\s*\$1\s+and\s+session_id\s*=\s*\$2/i.test(call.sql)) {
      return call.params[1];
    }
    if (bindsSession(call.sql)) return call.params[0];
    return undefined;
  }).filter((value) => value !== undefined);
}

const diagnosticSubmit = await import("../app/api/diagnostic/submit/route.ts");
const clarificationSubmit = await import("../app/api/clarification/submit/route.ts");
const reflection = await import("../app/api/reflection/route.ts");
const diagnosticLatest = await import("../app/api/diagnostic/latest/route.ts");
const recommendations = await import("../app/api/recommendations/route.ts");
const sessionRoute = await import("../app/api/session/route.ts");
const trackSelect = await import("../app/api/track/select/route.ts");
const generate = await import("../app/api/recommendations/generate/route.ts");

const guarded = [
  ["POST /api/diagnostic/submit", diagnosticSubmit.POST],
  ["POST /api/clarification/submit", clarificationSubmit.POST],
  ["GET /api/reflection", reflection.GET],
  ["POST /api/reflection", reflection.POST],
  ["GET /api/diagnostic/latest", diagnosticLatest.GET],
  ["GET /api/recommendations", recommendations.GET],
  ["GET /api/session", sessionRoute.GET],
  ["POST /api/track/select", trackSelect.POST],
  ["POST /api/recommendations/generate", generate.POST],
] as const;

describe("session isolation", { concurrency: false }, () => {
for (const [name, handler] of guarded) {
  test(`${name} returns 401 when X-Session-ID is missing`, async () => {
    const world = createWorld();
    const response = await handler(request(null) as never);
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error, "X-Session-ID header is required");
    assert.equal(world.writes.length, 0);
  });

  test(`${name} returns 400 when X-Session-ID is not a UUID`, async () => {
    const world = createWorld();
    const response = await handler(request("not-a-uuid") as never);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "X-Session-ID must be a valid UUID");
    assert.equal(world.writes.length, 0);
  });
}

test("POST /api/reflection does not save a recommendation from another session", async () => {
  const world = createWorld();
  const response = await reflection.POST(request(SESSION_A, {
    sessionId: SESSION_B,
    recommendationId: REC_B,
    rating: "useful",
    comment: "foreign-reflection-attempt",
  }) as never);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "Recommendation not found for this session");
  assert.equal(world.writes.some((call) => call.sql.includes("INSERT INTO reflections")), false);
  assert.equal(JSON.stringify(world.reflections).includes("foreign-reflection-attempt"), false);
  assert.ok(sessionIds(world).every((id) => id === SESSION_A));
});

test("POST /api/reflection saves a recommendation that belongs to the header session", async () => {
  const world = createWorld();
  const response = await reflection.POST(request(SESSION_A, {
    sessionId: SESSION_B,
    recommendationId: REC_A,
    rating: "useful",
    comment: "owner-reflection-note",
  }) as never);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "saved");
  const insert = world.writes.find((call) => call.sql.includes("INSERT INTO reflections"));
  assert.ok(insert);
  assert.equal(insert?.params[0], SESSION_A);
  assert.equal(insert?.params[1], REC_A);
  assert.equal(JSON.stringify(world.reflections.get(SESSION_B)).includes("owner-reflection-note"), false);
});

test("diagnostic JSON sessionId does not replace X-Session-ID", async () => {
  const world = createWorld();
  const response = await diagnosticSubmit.POST(request(SESSION_A, {
    sessionId: SESSION_B,
    answers: [{ questionId: "q1", answer: "fresh-diagnostic-answer" }],
  }) as never);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "submitted");
  const insert = world.writes.find((call) => call.sql.includes("INSERT INTO diagnostics"));
  assert.equal(insert?.params[0], SESSION_A);
  assert.equal(world.writes.some((call) => call.params.includes(SESSION_B)), false);

  world.calls.length = 0;
  const own = await diagnosticLatest.GET(request(SESSION_A) as never);
  const foreign = await diagnosticLatest.GET(request(SESSION_B) as never);
  const ownBody = await own.json();
  const foreignBody = await foreign.json();

  assert.equal(own.status, 200);
  assert.equal(JSON.stringify(ownBody).includes("fresh-diagnostic-answer"), true);
  assert.equal(JSON.stringify(foreignBody).includes("fresh-diagnostic-answer"), false);
  assert.equal(JSON.stringify(foreignBody).includes(FOREIGN), true);
});

test("clarification JSON sessionId does not replace X-Session-ID", async () => {
  const world = createWorld();
  const response = await clarificationSubmit.POST(request(SESSION_A, {
    sessionId: SESSION_B,
    diagnosticId: DIAG_B,
    answers: [{ questionId: "agent_q2_work_style", answer: "team" }],
  }) as never);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "submitted");
  const insert = world.writes.find((call) => call.sql.includes("INSERT INTO clarifications"));
  assert.equal(insert?.params[0], SESSION_A);
  assert.equal(insert?.params[1], DIAG_A);
  assert.equal(world.writes.some((call) => call.params.includes(SESSION_B)), false);
  assert.equal(world.writes.some((call) => call.params.includes(DIAG_B)), false);
  assert.equal(world.clarifications.get(SESSION_B)?.id, CLAR_B);
});

test("GET /api/diagnostic/latest returns only the header session", async () => {
  const world = createWorld();
  const response = await diagnosticLatest.GET(request(SESSION_A) as never);
  const body = await response.json();

  assert.equal(response.status, 200);
  assertNoForeignMarker(body);
  assert.equal(body.diagnosticId, DIAG_A);
  assert.ok(sessionIds(world).every((id) => id === SESSION_A));
});

test("GET /api/reflection returns only the header session", async () => {
  const world = createWorld();
  const response = await reflection.GET(request(SESSION_A) as never);
  const body = await response.json();

  assert.equal(response.status, 200);
  assertNoForeignMarker(body);
  assert.equal(body.count, 1);
  assert.ok(sessionIds(world).every((id) => id === SESSION_A));
});

test("GET /api/recommendations returns only the header session", async () => {
  const world = createWorld();
  const response = await recommendations.GET(request(SESSION_A) as never);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.recommendationId, REC_A);
  assert.equal(body.sessionId, SESSION_A);
  assertNoForeignMarker(body);
  assert.ok(sessionIds(world).every((id) => id === SESSION_A));
});

test("GET /api/session does not return another session diagnostic, reflections, or recommendation", async () => {
  const world = createWorld();
  const response = await sessionRoute.GET(request(SESSION_A) as never);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.sessionId, SESSION_A);
  assert.equal(body.diagnostic.diagnosticId, DIAG_A);
  assert.equal(body.diagnostic.clarification.clarificationId, CLAR_A);
  assert.equal(body.recommendation.recommendationId, REC_A);
  assertNoForeignMarker(body);
  assert.ok(sessionIds(world).every((id) => id === SESSION_A));
});
});
