import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./security-hooks.mjs", import.meta.url), import.meta.url);

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const PROFESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = {
  session_id: string;
  profession_key: string;
  completed: number[];
  saved_ids: string[];
  version: number;
  updated_at: string;
};

const rows = new Map<string, Row>();
let schemaMissing = false;
let clock = 0;

function keyOf(sessionId: string, professionKey: string) {
  return `${sessionId}|${professionKey}`;
}

function request(sessionId: string | null, body?: unknown, professionKey?: string) {
  return {
    url: `http://127.0.0.1/api/education-route${professionKey ? `?professionKey=${encodeURIComponent(professionKey)}` : ""}`,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "x-session-id" ? sessionId : null;
      },
    },
    json: async () => body,
  };
}

globalThis.__securityQuery = async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FROM sessions")) {
    const id = String(params[0]);
    return id === SESSION_A || id === SESSION_B
      ? { rowCount: 1, rows: [{ id }] }
      : { rowCount: 0, rows: [] };
  }
  if (schemaMissing && sql.includes("education_routes")) {
    throw Object.assign(new Error("relation education_routes does not exist"), { code: "42P01" });
  }
  if (sql.includes("FOR UPDATE")) {
    assert.match(sql, /locked\.version = \$5::int/);
    assert.match(sql, /ON CONFLICT \(session_id, profession_key\) DO NOTHING/);
    assert.doesNotMatch(sql, /prompt|api_key|model_name/i);
    const sessionId = String(params[0]);
    const professionKey = String(params[1]);
    const id = keyOf(sessionId, professionKey);
    const existing = rows.get(id);
    const version = params[4];
    if (existing && version === existing.version) {
      const next = {
        ...existing,
        completed: params[2] as number[],
        saved_ids: params[3] as string[],
        version: existing.version + 1,
        updated_at: `2026-11-10T18:00:0${++clock}.000Z`,
      };
      rows.set(id, next);
      return { rowCount: 1, rows: [next] };
    }
    if (!existing && version == null) {
      const created: Row = {
        session_id: sessionId,
        profession_key: professionKey,
        completed: params[2] as number[],
        saved_ids: params[3] as string[],
        version: 1,
        updated_at: `2026-11-10T18:00:0${++clock}.000Z`,
      };
      rows.set(id, created);
      return { rowCount: 1, rows: [created] };
    }
    return { rowCount: 0, rows: [] };
  }
  if (sql.includes("FROM education_routes")) {
    assert.match(sql, /session_id = \$1/);
    const row = rows.get(keyOf(String(params[0]), String(params[1])));
    return row && row.session_id === params[0] ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
  }
  throw new Error(`unexpected SQL: ${sql}`);
};

const route = await import("../app/api/education-route/route.ts");

test("education route stays on the header session and keeps the newer version", async () => {
  const created = await route.PUT(request(SESSION_A, {
    professionKey: PROFESSION,
    completed: [0],
    saved: ["program:prog_024", "trial_011"],
    version: null,
  }) as never);
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.version, 1);
  assert.deepEqual(createdBody.completed, [0]);

  const updated = await route.PUT(request(SESSION_A, {
    professionKey: PROFESSION,
    completed: [0, 2],
    saved: ["program:prog_024"],
    version: 1,
  }) as never);
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.version, 2);
  assert.deepEqual(updatedBody.completed, [0, 2]);

  const read = await route.GET(request(SESSION_A, undefined, PROFESSION) as never);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).version, 2);

  const hidden = await route.GET(request(SESSION_B, undefined, PROFESSION) as never);
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).error, "Education route not found");

  const stale = await route.PUT(request(SESSION_A, {
    professionKey: PROFESSION,
    completed: [4],
    saved: [],
    version: 1,
  }) as never);
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.details.route.version, 2);
  assert.deepEqual(conflict.details.route.completed, [0, 2]);

  const [left, right] = await Promise.all([
    route.PUT(request(SESSION_A, { professionKey: "none", completed: [1], saved: [], version: null }) as never),
    route.PUT(request(SESSION_A, { professionKey: "none", completed: [3], saved: [], version: null }) as never),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [201, 409]);
  const stored = rows.get(`${SESSION_A}|none`);
  assert.equal(stored?.version, 1);
  assert.equal(stored?.completed.length, 1);

  const before = rows.get(`${SESSION_A}|${PROFESSION}`)?.version;
  const rejected = await route.PUT(request(SESSION_A, {
    sessionId: SESSION_B,
    professionKey: PROFESSION,
    completed: [1],
    saved: [],
    version: before,
  }) as never);
  assert.equal(rejected.status, 422);
  assert.equal(rows.get(`${SESSION_A}|${PROFESSION}`)?.version, before);
  assert.equal(rows.has(`${SESSION_B}|${PROFESSION}`), false);

  const invalid = await route.PUT(request(SESSION_A, {
    professionKey: PROFESSION,
    completed: [0, 0],
    saved: ["program:" + "x".repeat(500)],
    version: null,
  }) as never);
  assert.equal(invalid.status, 422);
  assert.equal((await route.GET(request(null, undefined, "none") as never)).status, 401);

  schemaMissing = true;
  const outdated = await route.GET(request(SESSION_A, undefined, PROFESSION) as never);
  assert.equal(outdated.status, 503);
  schemaMissing = false;
  assert.equal(rows.get(`${SESSION_A}|${PROFESSION}`)?.version, 2);
});
