import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeTrackSelect,
  type DbQuery,
} from "../lib/track-select.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function createDb(initial: Record<string, Record<string, unknown> | undefined> = {}) {
  const profiles = new Map(Object.entries(initial));
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query: DbQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO sessions")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("FROM profiles")) {
      const row = profiles.get(String(params[0]));
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.includes("INSERT INTO profiles")) {
      profiles.set(String(params[0]), {
        school_grade: params[1],
        preferences: params[2] ? JSON.parse(String(params[2])) : {},
      });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SET school_grade")) {
      const row = profiles.get(String(params[0]));
      if (row) row.school_grade = params[1];
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    if (sql.includes("SET preferences")) {
      const row = profiles.get(String(params[0]));
      if (row) row.preferences = JSON.parse(String(params[1]));
      return { rowCount: row ? 1 : 0, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { query, profiles, calls };
}

test("school grades 1, 3, 7, 10 and 11 are stored for the header session", async () => {
  for (const grade of [1, 3, 7, 10, 11]) {
    const db = createDb();
    const outcome = await executeTrackSelect({
      sessionId: SESSION_A,
      body: { trackType: "explore", schoolGrade: grade, sessionId: SESSION_B },
      query: db.query,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, {
      sessionId: SESSION_A,
      trackType: "explore",
      status: "selected",
    });
    assert.equal(db.profiles.get(SESSION_A)?.school_grade, grade);
    assert.equal(db.profiles.has(SESSION_B), false);
    assert.equal(
      db.calls.every((call) => call.params[0] === SESSION_A),
      true
    );
  }
});

test("omitted schoolGrade keeps the previously saved grade", async () => {
  const db = createDb({
    [SESSION_A]: { school_grade: 7, preferences: { cityNote: "keep" } },
  });
  const outcome = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "interests" },
    query: db.query,
  });
  assert.equal(outcome.ok, true);
  assert.equal(db.profiles.get(SESSION_A)?.school_grade, 7);
  assert.equal(
    db.calls.some((call) => call.sql.includes("profiles")),
    false
  );
});

test("invalid school grades are rejected without writing a profile", async () => {
  for (const schoolGrade of [0, 9.5, 12, null]) {
    const db = createDb();
    const outcome = await executeTrackSelect({
      sessionId: SESSION_A,
      body: { trackType: "explore", schoolGrade },
      query: db.query,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 422);
    assert.equal(db.calls.length, 0);
    assert.equal(db.profiles.size, 0);
  }
});

test("an expired session is not renewed and a mode conflict stays closed", async () => {
  const expired = createDb();
  expired.query = async (sql, params = []) => {
    if (sql.includes("INSERT INTO sessions")) return { rowCount: 0, rows: [] };
    if (sql.includes("expired")) return { rowCount: 1, rows: [{ expired: true, session_mode: "own" }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const blocked = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "explore" },
    query: expired.query,
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.status, 410);

  const conflict = createDb();
  conflict.query = async (sql) => {
    if (sql.includes("INSERT INTO sessions")) return { rowCount: 0, rows: [] };
    if (sql.includes("expired")) return { rowCount: 1, rows: [{ expired: false, session_mode: "demo" }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const rejected = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "explore", demoStudentId: 1 },
    query: conflict.query,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.status, 409);
});

test("an invalid demo student does not write a session", async () => {
  const db = createDb();
  const outcome = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "explore", demoStudentId: 16 },
    query: db.query,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.status, 422);
  assert.equal(db.calls.length, 0);
});

test("updating a profile changes only the requested grade and confidence", async () => {
  const db = createDb({
    [SESSION_A]: {
      school_grade: 3,
      preferences: {
        cityNote: "keep",
        confidence: { before: "low", after: "high", delta: 2, note: "saved" },
      },
    },
    [SESSION_B]: { school_grade: 11, preferences: { cityNote: "other" } },
  });

  const outcome = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "known_direction", schoolGrade: 10, confidenceBefore: "medium" },
    query: db.query,
  });
  assert.equal(outcome.ok, true);
  const profile = db.profiles.get(SESSION_A);
  assert.equal(profile?.school_grade, 10);
  const preferences = profile?.preferences as {
    cityNote: string;
    confidence: { before: string; after: string; delta: number; note: string };
  };
  assert.equal(preferences.cityNote, "keep");
  assert.deepEqual(preferences.confidence, {
    before: "medium",
    after: "high",
    delta: 1,
    note: "saved",
  });
  assert.equal(db.profiles.get(SESSION_B)?.school_grade, 11);
});

test("confidenceBefore does not clear an existing grade", async () => {
  const db = createDb({
    [SESSION_A]: { school_grade: 11, preferences: { cityNote: "keep" } },
  });
  const outcome = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "explore", confidenceBefore: "low" },
    query: db.query,
  });
  assert.equal(outcome.ok, true);
  assert.equal(db.profiles.get(SESSION_A)?.school_grade, 11);
  assert.deepEqual(db.profiles.get(SESSION_A)?.preferences, {
    cityNote: "keep",
    confidence: { before: "low", after: null, delta: null },
  });
});

test("an unknown session receives its own profile and does not change another session", async () => {
  const db = createDb({
    [SESSION_B]: { school_grade: 11, preferences: { cityNote: "other" } },
  });
  const outcome = await executeTrackSelect({
    sessionId: SESSION_A,
    body: { trackType: "explore", schoolGrade: 1, sessionId: SESSION_B },
    query: db.query,
  });
  assert.equal(outcome.ok, true);
  assert.equal(db.profiles.get(SESSION_A)?.school_grade, 1);
  assert.equal(db.profiles.get(SESSION_B)?.school_grade, 11);
  assert.deepEqual(db.profiles.get(SESSION_B)?.preferences, { cityNote: "other" });
});
