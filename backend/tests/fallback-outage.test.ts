import assert from "node:assert/strict";
import test from "node:test";
import { buildFallbackResponse } from "../lib/ai/fallback.ts";

const dossier = {
  student: { tier: "9-11", school_grade: 10, in_region: true },
  answers: [{ ref: "A1", selected: ["Информатика"] }, { ref: "A2", selected: ["Математика"] }, { ref: "A3", selected: ["Проекты"] }],
  warnings: [],
};
const ctx = {
  tier: "9-11",
  dossierRefs: new Set(["A1","A2","A3"]),
  answersMap: {},
  candidatesMap: {},
  industriesMap: {},
  industryIds: new Set(),
  retrievedIndustryIds: new Set(),
  retrievalScores: {},
  emptyShare: 0,
  coverageGap: true,
  inRegion: true,
  catalogVersion: "test",
};
const retrieval = {
  professionIds: [], industryIds: [], evidence: {},
  professionScores: {}, industryScores: {},
  coverageGap: true, uncoveredAnswerRefs: [],
  mode: "lexical", warnings: [],
};
test("retrieval infrastructure failure is not reported as no matching professions", async () => {
 const result = await buildFallbackResponse({
   dossier: dossier as any,
   ctx: ctx as any,
   retrieval: {...retrieval, warnings: ["retrieval_failed"]} as any,
 });
 assert.equal(result.status,"fallback");
 assert.deepEqual(result.hypotheses,[]);
 assert.equal(result.generation.mode,"retrieval_only");
 assert.ok(result.warnings.includes("retrieval_unavailable"));
 assert.match(result.summary,/техническ|временно/i);
});
test("genuine empty retrieval without infrastructure failure retains no_match", async () => {
 const result = await buildFallbackResponse({
   dossier: dossier as any,
   ctx: ctx as any,
   retrieval: retrieval as any,
 });
 assert.equal(result.status,"no_match");
 assert.ok(!result.warnings.includes("retrieval_unavailable"));
});
