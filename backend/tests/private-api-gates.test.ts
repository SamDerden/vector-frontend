import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const privateRoutes = [
  "clarification/submit",
  "diagnostic/latest",
  "diagnostic/submit",
  "education-route",
  "recommendations/generate",
  "recommendations/jobs/[requestId]",
  "recommendations",
  "reflection",
  "session",
];
const publicRoutes = [
  "clarification/questions",
  "demo/students",
  "diagnostic/questions",
  "health",
  "professions",
  "professions/[id]",
  "trials",
];
function source(route: string): string {
  return readFileSync(fileURLToPath(new URL(`../app/api/${route}/route.ts`, import.meta.url)), "utf8");
}
test("every private API handler checks session ownership and expiry", () => {
  for (const route of privateRoutes) {
    const code = source(route);
    assert.match(code, /requireExistingSession\(request\)/, `missing session gate: ${route}`);
    assert.match(code, /if \("error" in (?:session|header)\)/, `missing gate failure handling: ${route}`);
  }
});
test("track selection separately gates existing UUID claims", () => {
  const code = source("track/select");
  assert.match(code, /authorizeSessionOwnership\(request, header\.sessionId\)/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /sessionProofEnforced\(\)/);
});
test("public catalog and question routes do not read session-specific records", () => {
  for (const route of publicRoutes) {
    const code = source(route);
    assert.doesNotMatch(code, /requireExistingSession\(request\)/, `unexpected private gate: ${route}`);
  }
});
