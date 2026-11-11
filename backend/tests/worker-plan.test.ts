import assert from "node:assert/strict";
import test from "node:test";

import { planWorkerCandidate } from "../lib/generation-worker.ts";
import { RETRYABLE_ERROR_CODES } from "../lib/generation-jobs.ts";

const now = 1_000_000;

test("a live lease is left to its owner", () => {
  assert.equal(planWorkerCandidate({
    status: "running",
    attemptCount: 1,
    lockedUntilMs: now + 10_000,
    hasRecommendation: false,
    nowMs: now,
  }), "leave");
});

test("an expired running job is claimed, exhausted, or attached to a saved result", () => {
  assert.equal(planWorkerCandidate({
    status: "running",
    attemptCount: 1,
    lockedUntilMs: now - 1,
    hasRecommendation: false,
    nowMs: now,
  }), "claim");
  assert.equal(planWorkerCandidate({
    status: "running",
    attemptCount: 3,
    lockedUntilMs: now - 1,
    hasRecommendation: false,
    nowMs: now,
  }), "exhaust");
  assert.equal(planWorkerCandidate({
    status: "running",
    attemptCount: 3,
    lockedUntilMs: now - 1,
    hasRecommendation: true,
    nowMs: now,
  }), "attach");
  assert.equal(planWorkerCandidate({
    status: "pending",
    attemptCount: 0,
    lockedUntilMs: null,
    hasRecommendation: false,
    nowMs: now,
  }), "claim");
  assert.equal(RETRYABLE_ERROR_CODES.has("pipeline_failed"), true);
  assert.equal(RETRYABLE_ERROR_CODES.has("persist_failed"), false);
});
