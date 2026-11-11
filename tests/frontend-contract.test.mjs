import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
const backend=readFileSync(new URL("../lib/demo-backend.ts",import.meta.url),"utf8");
const route=readFileSync(new URL("../backend/app/api/demo/students/route.ts",import.meta.url),"utf8");
const config=readFileSync(new URL("../next.config.ts",import.meta.url),"utf8");
test("demo students are served from canonical backend dossiers",()=>{
 assert.match(route,/getMockStudents/);
 assert.match(route,/lookupQuestionText/);
 assert.match(page,/fetchDemoStudents/);
 assert.match(backend,/input\.dossier\?\.answers/);
});
test("Sofi receives canonical clarification answers",()=>{
 assert.match(page,/fetchClarificationQuestions/);
 assert.match(page,/questionId:q\.question_id/);
 assert.match(backend,/\/api\/clarification\/submit/);
 assert.match(backend,/\/api\/recommendations\/generate/);
});
test("own route retains grade-specific baseline diagnosis",()=>{
 assert.match(page,/\/api\/diagnostic\/questions\?grade=/);
 assert.match(backend,/\/api\/diagnostic\/submit/);
 assert.match(backend,/schoolGrade:\s*input\.dossier\?\.grade\s*\?\?\s*input\.grade/);
});
test("same-origin API proxy remains configured",()=>{
 assert.match(config,/source: "\/api\/:path\*"/);
});
