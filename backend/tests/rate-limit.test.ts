import assert from "node:assert/strict";
import test from "node:test";

import { createAbuseGuard, SCHOOL_SAFE_LIMITS } from "../lib/abuse-guard.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";

test("the same generation key can be retried without using another slot", async () => {
  const guard = createAbuseGuard({ ...SCHOOL_SAFE_LIMITS, generation: 2 });
  assert.equal((await guard.guardGeneration("session", "one")).ok, true);
  assert.equal((await guard.guardGeneration("session", "one")).ok, true);
  assert.equal((await guard.guardGeneration("session", "two")).ok, true);
  const blocked = await guard.guardGeneration("session", "three");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterMs > 0);
});

test("concurrent generation attempts stop at the limit", async () => {
  const guard = createAbuseGuard({ ...SCHOOL_SAFE_LIMITS, generation: 3 });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => guard.guardGeneration("class", `request-${index}`))
  );
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal(results.filter((result) => !result.ok).length, 5);
});

test("write and track limits are independent", async () => {
  const guard = createAbuseGuard({
    ...SCHOOL_SAFE_LIMITS,
    writes: 1,
    trackPerIp: 1,
  });
  assert.equal((await guard.guardWrite("pupil")).ok, true);
  assert.equal((await guard.guardWrite("pupil")).ok, false);
  assert.equal((await guard.guardTrackCreate("school-nat")).ok, true);
  assert.equal((await guard.guardTrackCreate("school-nat")).ok, false);
  assert.equal((await guard.guardRead("pupil")).ok, true);
});

test("a disabled guard does not block a class", async () => {
  const guard = createAbuseGuard({ ...SCHOOL_SAFE_LIMITS, writes: 1 }, true);
  assert.equal((await guard.guardWrite("pupil")).ok, true);
  assert.equal((await guard.guardWrite("pupil")).ok, true);
});

test("in-memory slots do not exceed the limit under a burst", async () => {
  const limiter = createRateLimiter(4, 60_000);
  const results = await Promise.all(Array.from({ length: 10 }, () => limiter.take("shared")));
  assert.equal(results.filter((result) => result.ok).length, 4);
});
