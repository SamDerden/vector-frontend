import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const logic = readFileSync(new URL("../lib/demo-recommendations.ts", import.meta.url), "utf8");

test("demo recommendations depend on selected profile and six answers", () => {
  assert.match(page, /buildDemoRecommendation\(demoProfile,demoAnswers\)/);
  assert.match(logic, /profile\.interests/);
  assert.match(logic, /answers\[qi\]/);
  assert.match(logic, /answers\[5\]/);
  assert.match(logic, /answers\[4\]/);
});
test("demo displays hypotheses and actionable next steps", () => {
  assert.match(page, /demoRecommendation\.hypotheses\.map/);
  assert.match(page, /demoRecommendation\.nextStepOptions\.map/);
});
test("demo distinguishes heuristic recommendations from AI and verified regional events", () => {
  assert.match(logic, /Не AI-оценка/);
  assert.match(logic, /не проверялись/);
});
