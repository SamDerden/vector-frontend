import assert from "node:assert/strict";
import test from "node:test";
import { boundedAttemptTimeoutMs } from "../lib/ai/llm/timeout-budget.ts";

test("zero caller timeout never disables Axios timeout", () => {
  assert.equal(boundedAttemptTimeoutMs(0, 30000, 45000), 30000);
});
test("the remaining deadline limits the HTTP attempt", () => {
  assert.equal(boundedAttemptTimeoutMs(30000, 30000, 1200), 1200);
});
test("a shorter caller timeout is respected", () => {
  assert.equal(boundedAttemptTimeoutMs(5000, 30000, 45000), 5000);
});
test("the configured per-attempt ceiling is respected", () => {
  assert.equal(boundedAttemptTimeoutMs(60000, 30000, 45000), 30000);
});
test("an exhausted deadline cannot start another attempt", () => {
  assert.throws(() => boundedAttemptTimeoutMs(0, 30000, 0), /deadline exceeded/);
});
