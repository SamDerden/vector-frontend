import assert from "node:assert/strict";
import test from "node:test";
import { readOrCreateSessionId, sessionStorageKey, requestStorageKey, openGenerationRequest } from "../lib/session-store.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

test("two independent browser tabs selecting the same demo pupil get separate sessions", () => {
  const firstTab = memoryStorage();
  const secondTab = memoryStorage();
  const scope = { mode: "demo", studentId: 1 };
  const first = readOrCreateSessionId(scope, firstTab, () => A);
  const second = readOrCreateSessionId(scope, secondTab, () => B);
  assert.notEqual(first, second);
  assert.equal(readOrCreateSessionId(scope, firstTab, () => C), A);
  assert.equal(readOrCreateSessionId(scope, secondTab, () => D), B);
  assert.equal(sessionStorageKey(scope), "vector-session-demo-1");
});

test("two demo pupils in one tab do not share their UUID or generation job", () => {
  const tab = memoryStorage();
  const anya = { mode: "demo", studentId: 1 };
  const roman = { mode: "demo", studentId: 15 };
  assert.equal(readOrCreateSessionId(anya, tab, () => A), A);
  assert.equal(readOrCreateSessionId(roman, tab, () => B), B);
  assert.notEqual(sessionStorageKey(anya), sessionStorageKey(roman));
  assert.notEqual(requestStorageKey(anya), requestStorageKey(roman));
  assert.equal(openGenerationRequest(anya, tab, () => C), C);
  assert.equal(openGenerationRequest(roman, tab, () => D), D);
});

test("a fresh tab has no access to the previous tab's demo UUID", () => {
  const scope = { mode: "demo", studentId: 1 };
  const previousTab = memoryStorage();
  readOrCreateSessionId(scope, previousTab, () => A);
  const freshTab = memoryStorage();
  assert.equal(freshTab.getItem(sessionStorageKey(scope)), null);
  assert.equal(readOrCreateSessionId(scope, freshTab, () => B), B);
});
