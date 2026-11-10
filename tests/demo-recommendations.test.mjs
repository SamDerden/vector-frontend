import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("demo recommendations depend on selected profile and six answers", async () => {
  const { buildDemoRecommendation } = await import("../lib/demo-recommendations.ts");
  const { demoProfiles } = await import("../lib/demo-profiles.ts");
  const junior = demoProfiles.find((profile) => profile.grade <= 4);
  const older = demoProfiles.find((profile) => profile.grade >= 9);
  const firstAnswers = { 0: [0], 1: [0], 2: [0], 3: [0], 4: [0], 5: [0] };
  const otherAnswers = { 0: [2], 1: [2], 2: [2], 3: [2], 4: [1], 5: [1, 2] };
  const first = buildDemoRecommendation(junior, firstAnswers);
  const second = buildDemoRecommendation(junior, otherAnswers);
  const olderResult = buildDemoRecommendation(older, firstAnswers);
  assert.notDeepEqual(first.hypotheses.map((item) => item.title), second.hypotheses.map((item) => item.title));
  assert.notEqual(first.nextStepOptions[0].note, second.nextStepOptions[0].note);
  assert.match(first.summary, new RegExp(junior.name));
  assert.match(first.summary, /не выбор профессии/);
  assert.match(olderResult.summary, /не окончательный профессиональный выбор/);
  assert.match(first.methodology, /Не AI-оценка/);
  assert.equal(page.includes("buildDemoRecommendation"), false);
  assert.match(page, /clarificationAnswers\.length!==6/);
  assert.match(page, /input\.dossier|generateDemoWithBackend\(\{dossier/);
  assert.match(page, /Для 1–4 классов показываем только интересы и активности/);
  assert.match(page, /showsProfessions\(grade\)\?"Для 5–8 классов/);
});
test("demo displays hypotheses and actionable next steps", async () => {
  const { hasActionableRoute, showsProfessions } = await import("../lib/age-view.ts");
  const result = {
    hypotheses: [{ professionId: "p1", title: "Инженер", trials: [{ id: "t1", title: "Проба" }] }],
    nextStepOptions: [{ title: "Кружок", available: false }],
  };
  assert.equal(showsProfessions(10), true);
  assert.equal(showsProfessions(2), false);
  assert.equal(hasActionableRoute(result), true);
  assert.equal(hasActionableRoute({ hypotheses: [], nextStepOptions: [{ title: "Курс", available: true }] }), true);
  assert.equal(hasActionableRoute({ hypotheses: [{ trials: [] }], nextStepOptions: [{ available: false }] }), false);
  assert.match(page, /hasActionableRoute\(result\)/);
  assert.match(page, /\(result\?\.hypotheses\|\|\[\]\)\.slice\(0,5\)\.map/);
  assert.match(page, /result\?\.nextStepOptions/);
  assert.equal(page.includes("demoRecommendation"), false);
});
test("demo distinguishes heuristic recommendations from AI and verified regional events", async () => {
  const { buildDemoRecommendation } = await import("../lib/demo-recommendations.ts");
  const { demoProfiles } = await import("../lib/demo-profiles.ts");
  const result = buildDemoRecommendation(demoProfiles[0], { 0: [0], 1: [0], 2: [0], 3: [0], 4: [0], 5: [] });
  assert.match(result.methodology, /Не AI-оценка/);
  assert.match(result.methodology, /не проверялись/);
  assert.equal(result.nextStepOptions.every((item) => item.available === false), true);
});
