// Read-only catalog audit. Run from backend: node scripts/vector_catalog_audit.mjs "Навигатор Екб v3.xlsx"
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
const excelPath=process.argv[2];
if(!excelPath)throw Error('Usage: node scripts/vector_catalog_audit.mjs "data/Навигатор Екб v3.xlsx"');
const root=process.cwd();
const graph=JSON.parse(fs.readFileSync(path.join(root,'data/navigator_full_graph.json'),'utf8'));
const helper=path.join(path.dirname(new URL(import.meta.url).pathname),'read_catalog_xlsx.py');
const x=JSON.parse(execFileSync('python3',[helper,excelPath],{encoding:'utf8',maxBuffer:16*1024*1024}));
const sheets=['industry','profession','skill','profession_skill','organization','education_program','program_profession','trial','trial_profession','vacancy_snapshot'];
for(const name of sheets)if(!Array.isArray(x[name]))throw Error('Missing Excel sheet: '+name);

