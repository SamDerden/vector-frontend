import assert from "node:assert/strict";
import test from "node:test";

import { activityTitles, gradeBand, interestLabels, showsEducationPrograms, showsProfessions } from "../lib/age-view.ts";
import { presentGeneration } from "../lib/generation-result.ts";
import {
  generationSessionScope,
  readOrCreateSessionId,
  sessionHeader,
  sessionStorageKey,
} from "../lib/session-store.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("grades 2, 7 and 10 follow the age policy", () => {
  assert.equal(gradeBand(2), "1-4");
  assert.equal(showsProfessions(2), false);
  assert.equal(showsEducationPrograms(2), false);

  assert.equal(gradeBand(7), "5-8");
  assert.equal(showsProfessions(7), true);
  assert.equal(showsEducationPrograms(7), false);

  assert.equal(gradeBand(10), "9-11");
  assert.equal(showsProfessions(10), true);
  assert.equal(showsEducationPrograms(10), true);
});

test("interests and activities render only supplied titles", () => {
  assert.deepEqual(interestLabels([
    { tag: "Техника", why: "из ответа" },
    { tag: "Техника" },
    "Природа",
  ]), ["Техника", "Природа"]);
  assert.deepEqual(activityTitles([
    { id: "act_1", title: "Кружок робототехники" },
    { id: "act_2", title: "act_2" },
    { id: "act_3" },
  ]), [{ id: "act_1", title: "Кружок робототехники" }]);
});

test("demo students and the own session keep separate stable ids", () => {
  const storage = memoryStorage();
  const createId = (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-00000000000${++n}`;
  })();
  const first = readOrCreateSessionId({ mode: "demo", studentId: 2 }, storage, createId);
  const second = readOrCreateSessionId({ mode: "demo", studentId: 2 }, storage, createId);
  const other = readOrCreateSessionId({ mode: "demo", studentId: 7 }, storage, createId);
  const own = readOrCreateSessionId({ mode: "own" }, storage, createId);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.notEqual(own, first);
  assert.equal(sessionStorageKey({ mode: "own" }), "X-Session-ID");
  assert.equal(generationSessionScope({ dossier: { studentId: 2 } }).mode, "demo");
  assert.equal(generationSessionScope({}).mode, "own");
});

test("repeated session reads use the same stored header", () => {
  const storage = memoryStorage();
  readOrCreateSessionId({ mode: "demo", studentId: 4 }, storage, () => "11111111-1111-4111-8111-111111111111");
  const first = sessionHeader({ mode: "demo", studentId: 4 }, storage);
  const second = sessionHeader({ mode: "demo", studentId: 4 }, storage);
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first ?? {}).join(","), "X-Session-ID");
  assert.equal(sessionHeader({ mode: "own" }, storage), null);
  assert.equal(sessionHeader({ mode: "demo", studentId: 10 }, storage), null);
});

test("generation responses distinguish success, catalog fallback, JSON 502 and proxy HTML", () => {
  const success = presentGeneration(201, { summary: "ok", generation: { mode: "llm" } }, true);
  assert.equal(success.ok, true);
  if (success.ok) assert.equal(success.notice, null);

  const fallback = presentGeneration(201, { model: "retrieval_only", generation: { mode: "retrieval_only" } }, true);
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.fallback, true);
    assert.match(fallback.notice ?? "", /каталогу/);
    assert.doesNotMatch(fallback.notice ?? "", /AI service request failed/);
  }

  const failed = presentGeneration(502, { error: "AI service request failed" }, true);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.match(failed.message, /Не удалось собрать рекомендации/);
    assert.doesNotMatch(failed.message, /AI service request failed/);
  }

  const proxy = presentGeneration(502, null, false);
  assert.equal(proxy.ok, false);
  if (!proxy.ok) {
    assert.match(proxy.message, /временно недоступен/);
    assert.doesNotMatch(proxy.message, /<html>/);
  }
});
