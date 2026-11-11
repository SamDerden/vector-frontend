import assert from "node:assert/strict";
import test from "node:test";
import { clearCache, getFromCache, makeCacheKey, setCache } from "../lib/ai/cache.ts";

test("AI cache expires entries after one hour", () => {
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    clearCache();
    const key = makeCacheKey([{ answer: "robotics" }], "prompt1", "catalog1", "config1");
    setCache(key, { mode: "retrieval_only" });
    now += 60 * 60 * 1000 - 1;
    assert.deepEqual(getFromCache(key), { mode: "retrieval_only" });
    now += 1;
    assert.equal(getFromCache(key), null);
    assert.equal(getFromCache(key), null);
  } finally {
    Date.now = realNow;
    clearCache();
  }
});

test("AI cache keys change when catalog, prompt, or config changes", () => {
  const answers = [{ answer: "robotics" }];
  const original = makeCacheKey(answers, "p1", "c1", "v1");
  assert.notEqual(original, makeCacheKey(answers, "p2", "c1", "v1"));
  assert.notEqual(original, makeCacheKey(answers, "p1", "c2", "v1"));
  assert.notEqual(original, makeCacheKey(answers, "p1", "c1", "v2"));
});
