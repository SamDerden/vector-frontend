import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8");
const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

test("track selection persists school grade required by backend", () => {
  assert.match(page, /post\("\/api\/track\/select",\{trackType:track,schoolGrade:grade\}\)/);
});
test("session restores school grade", () => {
  assert.match(page, /s\?\.profile\?\.schoolGrade/);
});
test("session requests clarification questions on resume", () => {
  assert.match(page, /api<\{data:Q\[\]\}>\("\/api\/clarification\/questions"\)/);
});
test("client forwards stable session header", () => {
  assert.match(api, /"X-Session-ID":sessionId\(\)/);
});
test("same-origin proxy forwards API requests", () => {
  assert.match(config, /source: "\/api\/:path\*"/);
});
