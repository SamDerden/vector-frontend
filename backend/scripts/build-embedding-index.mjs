import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.env.LLM_BASE_URL || process.env.AI_API_BASE_URL || "").replace(/\/+$/,"");
const key = process.env.LLM_API_KEY || process.env.AI_API_KEY;
const model = process.env.LLM_EMBEDDINGS_MODEL;
if (!base || !key || !model) throw new Error("Embedding gateway URL, API key and LLM_EMBEDDINGS_MODEL required");
const catalog = JSON.parse(await fs.readFile(path.join(root,"data/catalog.normalized.json"),"utf8"));
if (!Array.isArray(catalog.chunks) || !catalog.chunks.length) throw new Error("Empty normalized catalog");
const entries=[];
let dimension=null;
for (let offset=0;offset<catalog.chunks.length;offset+=16) {
  const chunks=catalog.chunks.slice(offset,offset+16);
  const response=await fetch(base+"/embeddings",{
    method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
    body:JSON.stringify({model,input:chunks.map(x=>x.text)}),
    signal:AbortSignal.timeout(30000)
  });
  if(!response.ok) throw new Error("Embeddings API HTTP "+response.status);
  const result=await response.json();
  const vectors=result.data;
  if(!Array.isArray(vectors)||vectors.length!==chunks.length) throw new Error("Embedding count mismatch");
  const byIndex=[...vectors].sort((a,b)=>a.index-b.index);
  for(let i=0;i<chunks.length;i++){
    const vector=byIndex[i]?.embedding;
    if(!Array.isArray(vector)||!vector.length||!vector.every(Number.isFinite)) throw new Error("Invalid vector");
    if(dimension===null) dimension=vector.length;
    if(vector.length!==dimension) throw new Error("Inconsistent embedding dimensions");
    entries.push({chunkId:chunks[i].chunkId??chunks[i].chunk_id??chunks[i].type+":"+(offset+i),
      type:chunks[i].type,vector,metadata:{...chunks[i].metadata,text_preview:chunks[i].text}});
  }
}
const output={catalog_version:catalog.version,embedding_model:model,dimensions:dimension,entries};
const filename=path.join(root,"data/catalog.index.json");
await fs.writeFile(filename+".tmp",JSON.stringify(output));
await fs.rename(filename+".tmp",filename);
console.log("[Embeddings] Indexed",entries.length,"chunks, dimensions",dimension,"model",model);
