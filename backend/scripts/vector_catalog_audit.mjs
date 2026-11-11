import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
const input=process.argv[2];
if(!input)throw Error('Pass path to Excel v3');
const graph=JSON.parse(fs.readFileSync('data/navigator_full_graph.json','utf8'));
const helper=path.join(path.dirname(fileURLToPath(import.meta.url)),'read_catalog_xlsx.py');
const x=JSON.parse(execFileSync('python3',[helper,input],{encoding:'utf8',maxBuffer:16*1024*1024}));
const names=['industry','profession','skill','profession_skill','organization','education_program','program_profession','trial','trial_profession','vacancy_snapshot'];
for(const name of names)if(!Array.isArray(x[name]))throw Error('Missing Excel worksheet '+name);
const problems=[];
const norm=v=>v==null?'':String(v).trim();
const diff=(table,id,field,excel,json)=>problems.push({table,id,field,excel,json});
const check=(table,source,target,id,fields)=>{const index=new Map(target.map(r=>[norm(r[id]),r]));const seen=new Set();for(const r of source){const k=norm(r[id]);if(seen.has(k))diff(table,k,'duplicate_excel_id',k,null);seen.add(k);const g=index.get(k);if(!g){diff(table,k,'missing_in_graph',r,null);continue}for(const f of fields)if(norm(r[f])!==norm(g[f]))diff(table,k,f,r[f],g[f])}for(const k of index.keys())if(!seen.has(k))diff(table,k,'missing_in_excel',null,index.get(k))};
const common=(table,source,target,id,exclude=[])=>check(table,source,target,id,Object.keys(source[0]??{}).filter(k=>k!==id&&!exclude.includes(k)));
common('industry',x.industry,graph.industries,'industry_id');
common('profession',x.profession,graph.professions,'profession_id',['riasec_R','riasec_I','riasec_A','riasec_S','riasec_E','riasec_C','demand_level_region','salary_median_region','vacancies_count']);
const graphProfessionById=new Map(graph.professions.map(p=>[p.profession_id,p]));
for(const p of x.profession){
 const g=graphProfessionById.get(p.profession_id);
 if(!g)continue;
 for(const [excelField,jsonField] of [['demand_level_region','demand_level_region'],['salary_median_region','salary_median_rub'],['vacancies_count','vacancies_count']]){
  if(norm(p[excelField])!==norm(g.current_market_state?.[jsonField]))
   diff('profession',p.profession_id,excelField,p[excelField],g.current_market_state?.[jsonField]);
 }
}
common('skill',x.skill,graph.skills,'skill_id');
common('organization',x.organization,graph.organizations,'organization_id');
common('education_program',x.education_program,graph.education_programs,'program_id',['organization_id']);
common('trial',x.trial,graph.trials,'trial_id',['organization_id']);
for(const [table,source,target,keys] of [
['profession_skill',x.profession_skill,graph.professions.flatMap(p=>p.skills.map(s=>({...s,profession_id:p.profession_id}))),['profession_id','skill_id','importance']],
['program_profession',x.program_profession,graph.education_programs.flatMap(p=>p.professions.map(r=>({...r,program_id:p.program_id}))),['program_id','profession_id','fit_level']],
['trial_profession',x.trial_profession,graph.trials.flatMap(t=>t.professions.map(r=>({...r,trial_id:t.trial_id,skills_checked:r.skills_checked?.join(', ')}))),['trial_id','profession_id','skills_checked']]
]){const key=r=>keys.map(k=>norm(r[k])).join('|');const e=new Set(source.map(key)),g=new Set(target.map(key));for(const k of e)if(!g.has(k))diff(table,k,'missing_in_graph',k,null);for(const k of g)if(!e.has(k))diff(table,k,'missing_in_excel',null,k)}
for(const [table,source,target,id] of [['education_program_org',x.education_program,graph.education_programs,'program_id'],['trial_org',x.trial,graph.trials,'trial_id']]){const m=new Map(target.map(r=>[r[id],r]));for(const r of source){const g=m.get(r[id]);if(g&&norm(r.organization_id)!==norm(g.organization?.organization_id))diff(table,r[id],'organization_id',r.organization_id,g.organization?.organization_id)}}
const report={graph_version:graph.meta?.version,counts:Object.fromEntries(names.map(n=>[n,x[n].length])),graph_discrepancies:problems,db:{status:'NOT_CHECKED'}};
if(process.env.DATABASE_URL){const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});try{const client=await pool.connect();try{await client.query('BEGIN READ ONLY');const ids=x.profession.map(r=>String(r.profession_id));const rows=(await client.query('SELECT id::text AS uuid, external_id, graph_profession_id, title FROM professions WHERE external_id=ANY($1::text[]) OR graph_profession_id=ANY($1::text[])',[ids])).rows;const details=ids.map(id=>{const a=rows.filter(r=>r.external_id===id),b=rows.filter(r=>r.graph_profession_id===id);return {profession_id:id,uuid:a[0]?.uuid??null,graph_uuid:b[0]?.uuid??null,external_matches:a.length,graph_matches:b.length,status:a.length!==1?'EXTERNAL_ID_MISSING_OR_DUPLICATE':b.length!==1?'GRAPH_ID_MISSING_OR_DUPLICATE':a[0].uuid!==b[0].uuid?'UUID_CONFLICT':a[0].title!==x.profession.find(p=>p.profession_id===id)?.name?'NAME_MISMATCH':'MATCH'}});report.db={status:'CHECKED_READ_ONLY',matches:details.filter(d=>d.status==='MATCH').length,details};await client.query('ROLLBACK')}finally{client.release()}}catch(error){report.db={status:'ERROR',message:String(error.message)}}finally{await pool.end()}}
fs.writeFileSync('catalog-audit-result.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({graph_discrepancies:problems.length,db:report.db.status,db_matches:report.db.matches??null,report:'catalog-audit-result.json'},null,2));
if(problems.length||report.db.status==='ERROR'||report.db.status==='CHECKED_READ_ONLY'&&report.db.matches!==30)process.exitCode=1;
