import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source=readFileSync(new URL("../lib/demo-backend.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");

test("demo backend uses an isolated session",()=>assert.match(source,/const session=crypto\.randomUUID\(\)/));
test("profile grade is submitted to backend",()=>assert.match(source,/schoolGrade:profile\.grade/));
test("profile interests and all six answers are sent to diagnostic",()=>{
  assert.match(source,/profile\.interests/);
  assert.match(source,/demoQuestions\.map/);
  assert.match(source,/api\/diagnostic\/submit/);
});
test("AI recommendations are requested after diagnostic",()=>assert.match(source,/api\/recommendations\/generate/));
test("UI keeps honest offline fallback when AI unavailable",()=>{
  assert.match(page,/demoAiError/);
  assert.match(page,/Предварительные рекомендации \(без AI\)/);
});
