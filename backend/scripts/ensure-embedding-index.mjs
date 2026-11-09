import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
const catalog=JSON.parse(await fs.readFile("data/catalog.normalized.json","utf8"));
const model=(process.env.LLM_EMBEDDINGS_MODEL||"").trim();
if(!model) throw new Error("LLM_EMBEDDINGS_MODEL must be configured for semantic RAG");
let valid=false;
try{
 const index=JSON.parse(await fs.readFile("data/catalog.index.json","utf8"));
 const entries=index.entries;
 valid=index.catalog_version===catalog.version && index.embedding_model===model &&
   index.dimensions===2560 && Array.isArray(entries) &&
   entries.length===catalog.chunks.length && entries.length>0 &&
   entries.every(e=>Array.isArray(e.vector)&&e.vector.length===2560&&e.vector.every(Number.isFinite));
}catch(error){console.log("[RAG ensure] Existing index unavailable:",error instanceof Error?error.name:"unknown");}
if(!valid){
 console.log("[RAG ensure] Rebuilding index using",model,"for",catalog.chunks.length,"catalog chunks");
 const result=spawnSync(process.execPath,["scripts/build-embedding-index.mjs"],{stdio:"inherit",timeout:180000,env:process.env});
 if(result.status!==0) throw new Error("RAG index rebuild failed; refusing to start with unverified index");
}
const index=JSON.parse(await fs.readFile("data/catalog.index.json","utf8"));
if(index.catalog_version!==catalog.version||index.embedding_model!==model||index.entries?.length!==catalog.chunks.length||index.entries.some(e=>e.vector?.length!==2560)){
 throw new Error("RAG index verification failed");
}
console.log("[RAG ensure] verified semantic index:",JSON.stringify({model,indexEntries:index.entries.length,dimensions:2560,catalogVersion:catalog.version}));
