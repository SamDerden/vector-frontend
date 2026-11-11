import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { auditNormalizedCatalog, compareCatalogIds, READ_ONLY_CATALOG_SQL } from "../lib/catalog-integrity.ts";
import { EXPIRED_SESSION_DELETE_SQL, sessionCleanupPlan } from "../lib/session-cleanup.ts";
import { redact } from "../lib/observe.ts";
import { reflectionWrite } from "../lib/reflection-plan.ts";

test("catalog audit does not invent ids and its SQL is read-only", () => {
  const catalog = JSON.parse(readFileSync(new URL("../data/catalog.normalized.json", import.meta.url), "utf8"));
  const report = auditNormalizedCatalog(catalog);
  assert.equal(report.database, "not_checked");
  assert.equal(report.inventedMappings, 0);
  assert.ok(report.counts.professions > 0);
  assert.ok(report.counts.programs > 0);
  assert.ok(report.counts.organizations > 0);
  for (const item of report.discrepancies) {
    assert.equal(item.id.length > 0, true);
    assert.equal("replacement" in item, false);
  }
  for (const sql of READ_ONLY_CATALOG_SQL) {
    assert.match(sql, /^\s*SELECT/i);
    assert.equal(/\b(insert|update|delete|truncate|drop|alter)\b/i.test(sql), false);
  }
  const compared = compareCatalogIds({
    jsonIds: ["prof_001", "prof_002"],
    databaseIds: ["prof_002", "prof_999"],
  });
  assert.deepEqual(compared.missingInDatabase, ["prof_001"]);
  assert.deepEqual(compared.missingInJson, ["prof_999"]);
});

test("session cleanup is dry-run unless apply is explicit and never targets legacy rows", () => {
  const dry = sessionCleanupPlan(false);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.writes.length, 0);
  assert.equal(dry.touchesLegacyNullExpiry, false);
  const apply = sessionCleanupPlan(true);
  assert.match(apply.writes[0], /expires_at IS NOT NULL/);
  assert.equal(apply.writes[0], EXPIRED_SESSION_DELETE_SQL);
  assert.equal(/\btruncate\b/i.test(apply.writes[0]), false);
});

test("logs redact answers, secrets and comments", () => {
  const safe = redact({
    requestId: "33333333-3333-4333-8333-333333333333",
    answer: "хочу быть инженером",
    comment: "секретный комментарий",
    authorization: "Bearer super-secret-token",
    durationMs: 12,
  }) as Record<string, unknown>;
  assert.equal(safe.answer, "[redacted]");
  assert.equal(safe.comment, "[redacted]");
  assert.equal(safe.authorization, "[redacted]");
  assert.equal(safe.durationMs, 12);
  assert.equal(JSON.stringify(safe).includes("инженером"), false);
  assert.equal(JSON.stringify(safe).includes("super-secret-token"), false);
});

test("final reflection for grades 1-4 does not require a recommendation", () => {
  const junior = reflectionWrite({
    sessionId: "11111111-1111-4111-8111-111111111111",
    schoolGrade: 3,
    body: { rating: "useful", stage: "final", comment: "Понравилось" },
  });
  assert.equal(junior.ok, true);
  if (!junior.ok) return;
  assert.equal(junior.journeyStep, 4);
  assert.equal(junior.ageTier, "1-4");
  assert.equal(junior.params[1], null);

  const legacy = reflectionWrite({
    sessionId: "11111111-1111-4111-8111-111111111111",
    schoolGrade: 7,
    body: { rating: "unsure" },
  });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(legacy.journeyStep, undefined);
  assert.equal(legacy.params.length, 4);

  const conflict = reflectionWrite({
    sessionId: "11111111-1111-4111-8111-111111111111",
    schoolGrade: 10,
    body: { rating: "useful", stage: "final", journeyStep: 2 },
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.status, 422);
});
