const base=(process.env.LLM_BASE_URL||process.env.AI_API_BASE_URL||"").trim().replace(/\/+$/,"");
const key=process.env.LLM_API_KEY||process.env.AI_API_KEY;
if(!base||!key){console.log("[RAG probe] Gateway configuration unavailable; skipped");process.exit(0);}
try{
 const response=await fetch(base+"/models",{headers:{Authorization:"Bearer "+key},signal:AbortSignal.timeout(10000)});
 if(!response.ok){console.log("[RAG probe] Model discovery HTTP",response.status);process.exit(0);}
 const body=await response.json();
 const models=Array.isArray(body.data)?body.data:[];
 console.log("[RAG probe] Models visible to service:",models.map(x=>x.id).filter(x=>typeof x==="string").join(", ")||"(none)");
 console.log("[RAG probe] Embedding model configured:",Boolean(process.env.LLM_EMBEDDINGS_MODEL));
}catch(error){console.log("[RAG probe] Model discovery unavailable:",error instanceof Error?error.name:"unknown");}

// Non-destructive connectivity check: never print credentials or embedding values.
const embeddingModel=(process.env.LLM_EMBEDDINGS_MODEL||"").trim();
if(embeddingModel){
 try{
  const response=await fetch(base+"/embeddings",{
   method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
   body:JSON.stringify({model:embeddingModel,input:["Проверка семантического поиска профессий"]}),
   signal:AbortSignal.timeout(15000)
  });
  if(!response.ok){console.log("[RAG probe] Embeddings POST HTTP",response.status);}
  else{
   const body=await response.json();
   const vector=body?.data?.[0]?.embedding;
   const valid=Array.isArray(vector)&&vector.length>0&&vector.every(x=>typeof x==="number"&&Number.isFinite(x));
   console.log("[RAG probe] Embeddings POST valid:",valid,"dimensions:",valid?vector.length:"unavailable","model:",embeddingModel);
  }
 }catch(error){console.log("[RAG probe] Embeddings POST failed:",error instanceof Error?error.name:"unknown");}
}
