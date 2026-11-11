import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const graph = JSON.parse(await fs.readFile(path.join(root, "data/navigator_full_graph.json"), "utf8"));
const groups = ["industries","professions","skills","organizations","education_programs","trials"];
if (graph.meta?.schema !== "hybrid_v2") throw new Error("Only approved hybrid_v2 is supported");
for (const group of groups) {
  if (!Array.isArray(graph[group]) || graph[group].length !== graph.meta.counts[group])
    throw new Error(`Invalid ${group} count`);
}
const counts = Object.fromEntries(groups.map(k => [k,graph[k].length]));
console.log("[Catalog sync] Approved graph:", graph.meta.version, counts);
if (!process.argv.includes("--apply")) {
  console.log("[Catalog sync] DRY RUN: no database writes. Pass --apply after reviewing a database backup.");
  process.exit(0);
}
if (process.env.CONFIRM_CATALOG_SYNC !== "hybrid_v2") throw new Error("Set CONFIRM_CATALOG_SYNC=hybrid_v2");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");

const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
const db = await pool.connect();
const ids = Object.fromEntries(groups.map(k=>[k,new Map()]));
const q = (sql, params=[])=>db.query(sql,params);
const required = (map,id,kind) => { const v=map.get(id);if(!v) throw new Error(`Unknown ${kind}: ${id}`);return v; };
const upsert = async(sql,args) => (await q(sql,args)).rows[0].id;
const text = x => typeof x==="string" && x.trim() ? x.trim() : null;
const integer = x => Number.isInteger(x) ? x : null;
const safeAge = x => Number.isInteger(x) && x>=5 && x<=25 ? x : null;
try {
  await q("BEGIN");
  await q("SELECT pg_advisory_xact_lock(91826022)");
  const existing = await q("SELECT COUNT(*)::int AS n FROM professions WHERE external_id IS NOT NULL");
  console.log("[Catalog sync] Existing external professions:",existing.rows[0].n);
  const regionId = (await q("INSERT INTO regions(name) VALUES ('Екатеринбург') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id")).rows[0].id;
  for(const item of graph.industries) {
    ids.industries.set(item.industry_id,await upsert(`INSERT INTO industries(external_id,name,description_kid,regional_importance)
      VALUES($1,$2,$3,$4) ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name,description_kid=EXCLUDED.description_kid,regional_importance=EXCLUDED.regional_importance RETURNING id`,
      [item.industry_id,item.name,text(item.description_kid),text(item.regional_importance)]));
  }
  for(const item of graph.skills) {
    ids.skills.set(item.skill_id,await upsert(`INSERT INTO skills(external_id,name,type,description_kid) VALUES($1,$2,$3,$4)
      ON CONFLICT(external_id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,description_kid=EXCLUDED.description_kid RETURNING id`,
      [item.skill_id,item.name,text(item.type),text(item.description_kid)]));
  }
  for(const item of graph.organizations) {
    ids.organizations.set(item.organization_id,await upsert(`INSERT INTO organizations(external_id,graph_organization_id,name,organization_type,municipality,address,website,region_id)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(external_id) DO UPDATE SET graph_organization_id=EXCLUDED.graph_organization_id,
      name=EXCLUDED.name,organization_type=EXCLUDED.organization_type,municipality=EXCLUDED.municipality,address=EXCLUDED.address,website=EXCLUDED.website,region_id=EXCLUDED.region_id RETURNING id`,
      [item.organization_id,item.name,text(item.org_type),text(item.municipality),text(item.address),text(item.website),regionId]));
  }
  for(const item of graph.professions) {
    const industryId=required(ids.industries,item.industry_id,"industry");
    // Reconcile legacy Excel rows by exact title, preserving their UUID and references.
    // Never steal an external_id belonging to a different approved profession.
    const titleMatch = await q("SELECT id, external_id FROM professions WHERE title=$1 FOR UPDATE",[item.name]);
    const idMatch = await q("SELECT id, title FROM professions WHERE external_id=$1 FOR UPDATE",[item.profession_id]);
    if (titleMatch.rows.length && idMatch.rows.length && titleMatch.rows[0].id !== idMatch.rows[0].id)
      throw new Error(`Ambiguous profession identity for ${item.profession_id}: title and external ID point to different rows`);
    if (titleMatch.rows.length && titleMatch.rows[0].external_id !== item.profession_id) {
      const oldExternal = titleMatch.rows[0].external_id;
      // Keep a stable UUID, and attach the approved catalog identifier.
      await q("UPDATE professions SET external_id=$1 WHERE id=$2",[item.profession_id,titleMatch.rows[0].id]);
      console.log("[Catalog sync] Reconciled existing profession by title:",item.profession_id,"previous external ID:",oldExternal);
    }
    ids.professions.set(item.profession_id,await upsert(``INSERT INTO professions(external_id,title,description,industry_id,riasec,demand_level_region,salary_median_region,vacancies_count)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT(external_id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,
      industry_id=EXCLUDED.industry_id,riasec=EXCLUDED.riasec,demand_level_region=EXCLUDED.demand_level_region,
      salary_median_region=EXCLUDED.salary_median_region,vacancies_count=EXCLUDED.vacancies_count RETURNING id`,
      [item.profession_id,item.name,text(item.what_does_kid),industryId,JSON.stringify(item.riasec??{}),
       text(item.current_market_state?.demand_level_region),item.current_market_state?.salary_median_rub??null,
       integer(item.current_market_state?.vacancies_count)]));
    // Attach the approved graph ID to the same stable profession UUID.
    // Reject collisions instead of reassigning a graph ID from another row.
    const professionUuid = required(ids.professions,item.profession_id,"profession");
    const graphOwner = await q("SELECT id FROM professions WHERE graph_profession_id=$1 FOR UPDATE",[item.profession_id]);
    if (graphOwner.rows.length && graphOwner.rows[0].id !== professionUuid)
      throw new Error(`Graph profession ID ${item.profession_id} belongs to another UUID`);
    const graphIdentity = await q("SELECT graph_profession_id FROM professions WHERE id=$1 FOR UPDATE",[professionUuid]);
    if (graphIdentity.rows[0]?.graph_profession_id && graphIdentity.rows[0].graph_profession_id !== item.profession_id)
      throw new Error(`UUID for ${item.profession_id} already has a different graph ID`);
    await q("UPDATE professions SET graph_profession_id=$1 WHERE id=$2 AND graph_profession_id IS NULL",
      [item.profession_id,professionUuid]);
    for(const skill of item.skills??[]) {
      await q(`INSERT INTO profession_skills(profession_id,skill_id,importance) VALUES($1,$2,$3)
        ON CONFLICT(profession_id,skill_id) DO UPDATE SET importance=EXCLUDED.importance`,
        [required(ids.professions,item.profession_id,"profession"),required(ids.skills,skill.skill_id,"skill"),integer(skill.importance)]);
    }
  }
  for(const item of graph.education_programs) {
    const organizationId=item.organization?.organization_id ? required(ids.organizations,item.organization.organization_id,"organization") : null;
    ids.education_programs.set(item.program_id,await upsert(`INSERT INTO education_programs(external_id,graph_program_id,title,institution,organization_id,level,specialty_code,duration_years,region_id)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(external_id) DO UPDATE SET graph_program_id=EXCLUDED.graph_program_id,
      title=EXCLUDED.title,institution=EXCLUDED.institution,organization_id=EXCLUDED.organization_id,
      level=EXCLUDED.level,specialty_code=EXCLUDED.specialty_code,duration_years=EXCLUDED.duration_years,region_id=EXCLUDED.region_id RETURNING id`,
      [item.program_id,item.name,item.organization?.name??"Не указана",organizationId,text(item.level),
       text(item.specialty_code),typeof item.duration_years==="number" && item.duration_years>0 && item.duration_years<=20?item.duration_years:null,regionId]));
    for(const relation of item.professions??[]) {
      await q(`INSERT INTO program_professions(program_id,profession_id,fit_level) VALUES($1,$2,$3)
        ON CONFLICT(program_id,profession_id) DO UPDATE SET fit_level=EXCLUDED.fit_level`,
        [required(ids.education_programs,item.program_id,"program"),required(ids.professions,relation.profession_id,"profession"),text(relation.fit_level)]);
    }
  }
  for(const item of graph.trials) {
    const orgId=item.organization?.organization_id ? required(ids.organizations,item.organization.organization_id,"organization") : null;
    const firstProfession=(item.professions??[])[0]?.profession_id;
    ids.trials.set(item.trial_id,await upsert(`INSERT INTO professional_trials(external_id,graph_trial_id,title,description,format,duration_minutes,age_min,age_max,
      organization_id,region_id,profession_id,municipality,cost,source_url)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(external_id) DO UPDATE SET graph_trial_id=EXCLUDED.graph_trial_id,
      title=EXCLUDED.title,description=EXCLUDED.description,format=EXCLUDED.format,duration_minutes=EXCLUDED.duration_minutes,
      age_min=EXCLUDED.age_min,age_max=EXCLUDED.age_max,organization_id=EXCLUDED.organization_id,region_id=EXCLUDED.region_id,
      profession_id=EXCLUDED.profession_id,municipality=EXCLUDED.municipality,cost=EXCLUDED.cost,source_url=EXCLUDED.source_url RETURNING id`,
      [item.trial_id,item.title,text(item.description_5_8??item.description_9_11??item.description_1_4),
       text(item.format),integer(item.duration_minutes),safeAge(item.age_min),safeAge(item.age_max),
       orgId,regionId,firstProfession?required(ids.professions,firstProfession,"profession"):null,
       text(item.municipality),text(item.cost),text(item.source_url)]));
    for(const relation of item.professions??[]) {
      await q(`INSERT INTO trial_professions(trial_id,profession_id,skills_checked) VALUES($1,$2,$3)
        ON CONFLICT(trial_id,profession_id) DO UPDATE SET skills_checked=EXCLUDED.skills_checked`,
        [required(ids.trials,item.trial_id,"trial"),required(ids.professions,relation.profession_id,"profession"),
         Array.isArray(relation.skills_checked)?relation.skills_checked.join(", "):text(relation.skills_checked)]);
    }
  }
  for(const [group,table,key] of [["professions","professions","external_id"],["trials","professional_trials","graph_trial_id"],["organizations","organizations","graph_organization_id"],["education_programs","education_programs","graph_program_id"]]) {
    const actual=(await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${key}=ANY($1::text[])`,[Array.from(ids[group].keys())])).rows[0].n;
    if(actual!==graph[group].length) throw new Error(`Database count mismatch ${group}: ${actual} != ${graph[group].length}`);
  }
  // Legacy records remain intact for historical references; they are not counted as approved catalog entries.
  await q("COMMIT");
  console.log("[Catalog sync] COMMITTED approved catalog:",counts);
} catch(error) {
  await q("ROLLBACK");
  console.error("[Catalog sync] ROLLED BACK:",error.message);
  process.exitCode=1;
} finally {
  db.release();
  await pool.end();
}
