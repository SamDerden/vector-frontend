import fs from "node:fs";
import assert from "node:assert/strict";
const graph=JSON.parse(fs.readFileSync(new URL("../data/navigator_full_graph.json",import.meta.url),"utf8"));
const unique=(xs,key)=>{const ids=xs.map(x=>x[key]);assert.equal(new Set(ids).size,ids.length,`Duplicate ${key}`);return new Set(ids);};
const professions=unique(graph.professions,"profession_id");
const skills=unique(graph.skills,"skill_id");
const programs=unique(graph.education_programs,"program_id");
const trials=unique(graph.trials,"trial_id");
const orgs=unique(graph.organizations,"organization_id");
const industries=unique(graph.industries,"industry_id");
assert.equal(professions.size,30);
for(let i=1;i<=30;i++)assert(professions.has("prof_"+String(i).padStart(3,"0")));
for(const p of graph.professions){
 assert(industries.has(p.industry_id),`Unknown industry for ${p.profession_id}`);
 for(const s of p.skills??[])assert(skills.has(s.skill_id),`Unknown skill for ${p.profession_id}`);
 for(const pr of p.programs??[])assert(programs.has(pr.program_id),`Unknown program for ${p.profession_id}`);
 for(const t of p.trials??[])assert(trials.has(t.trial_id),`Unknown trial for ${p.profession_id}`);
}
for(const [kind,rows] of [["program",graph.education_programs],["trial",graph.trials]]){
 for(const item of rows){
  if(item.organization?.organization_id)assert(orgs.has(item.organization.organization_id),`Unknown organization in ${kind}`);
  for(const relation of item.professions??[])assert(professions.has(relation.profession_id),`Unknown profession in ${kind}`);
 }
}
console.log(JSON.stringify({status:"PASS",professions:professions.size,skills:skills.size,programs:programs.size,trials:trials.size,organizations:orgs.size}));
