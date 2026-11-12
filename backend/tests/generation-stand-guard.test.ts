import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertStandDatabaseUrl,
  assertStandInvocation,
  STAND_URL,
} from "../scripts/generation-stand-lib.mjs";

const realCompose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const standCompose = readFileSync(new URL("../docker-compose.generation-stand.yml", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the isolated stand does not reuse the existing database", () => {
  assert.match(realCompose, /5433:5432/);
  assert.match(realCompose, /container_name: navigator-postgres/);
  assert.match(realCompose, /navigator_pgdata/);
  assert.match(standCompose, /127\.0\.0\.1:55432:5432/);
  assert.match(standCompose, /container_name: vector-prof-generation-stand-db/);
  assert.match(standCompose, /vector_prof_generation_stand_pgdata/);
  assert.match(standCompose, /vector_prof_generation_stand/);
  assert.doesNotMatch(standCompose, /5433/);
  assert.doesNotMatch(standCompose, /navigator-postgres/);
  assert.doesNotMatch(standCompose, /navigator_pgdata/);
  assert.doesNotMatch(standCompose, /AI_API/);
  const sync = readFileSync(new URL("../scripts/sync-hybrid-catalog.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(sync, /upsert\(``/);
  assert.equal(packageJson.scripts.test.includes("generation-stand.integration"), false);
  assert.equal(packageJson.scripts["test:generation-stand"].includes("generation-stand.integration.test.ts"), true);
});

test("the stand guard rejects the existing database and ignores DATABASE_URL", () => {
  assert.equal(assertStandDatabaseUrl(STAND_URL), STAND_URL);
  assert.throws(() => assertStandDatabaseUrl(""), /GENERATION_STAND_DATABASE_URL is required/);
  assert.throws(
    () => assertStandDatabaseUrl("postgresql://navigator:navigator_dev_password@127.0.0.1:5433/navigator"),
    /55432/
  );
  assert.throws(
    () => assertStandDatabaseUrl("postgresql://generation_stand:generation_stand_local_only@localhost:55432/vector_prof_generation_stand"),
    /127\.0\.0\.1/
  );
  assert.throws(
    () => assertStandDatabaseUrl("postgresql://navigator:generation_stand_local_only@127.0.0.1:55432/vector_prof_generation_stand"),
    /generation_stand/
  );
  assert.equal(
    assertStandInvocation({
      GENERATION_STAND: "isolated",
      GENERATION_STAND_DATABASE_URL: STAND_URL,
      DATABASE_URL: "postgresql://navigator:navigator_dev_password@127.0.0.1:5433/navigator",
    }),
    STAND_URL
  );
  assert.throws(
    () => assertStandInvocation({
      GENERATION_STAND_DATABASE_URL: STAND_URL,
      DATABASE_URL: STAND_URL,
    }),
    /GENERATION_STAND=isolated/
  );
});
