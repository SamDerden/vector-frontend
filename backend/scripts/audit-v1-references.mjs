import fs from "node:fs";
import path from "node:path";
const root=path.resolve("..");
const ignore=new Set([".git","node_modules",".next","dist","build"]);
const hits=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){if(ignore.has(ent.name))continue;const p=path.join(dir,ent.name);if(ent.isDirectory()){walk(p);continue;}if(!ent.isFile()||!/(?:\.md|\.mjs|\.js|\.ts|\.tsx|\.json|\.ya?ml|Dockerfile|\.sh)$/.test(ent.name))continue;const s=fs.readFileSync(p,"utf8");s.split(/\r?\n/).forEach((line,i)=>{if(/(?:Навигатор.{0,20}v1\.xlsx|navigator.{0,20}v1\.xlsx|v1\.xlsx)/i.test(line)){const relative=path.relative(root,p);const documentation=/\.md$/.test(p);hits.push({file:relative,line:i+1,documentation,text:line.trim().slice(0,220)});}});}}
walk(root);
const active=hits.filter(x=>!x.documentation&&!x.file.endsWith("audit-v1-references.mjs"));
console.log(JSON.stringify({status:active.length?"FAIL":"PASS",activeReferences:active,documentationReferences:hits.filter(x=>x.documentation)},null,2));
if(active.length)process.exitCode=1;
