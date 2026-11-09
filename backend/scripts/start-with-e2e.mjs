import { spawn } from "node:child_process";
const server=spawn("./node_modules/.bin/next",["start"],{stdio:"inherit",env:process.env});
const stop=(signal)=>{if(!server.killed)server.kill(signal)};
process.on("SIGTERM",()=>stop("SIGTERM"));process.on("SIGINT",()=>stop("SIGINT"));
server.on("exit",(code)=>process.exit(code??1));
(async()=>{
 const base="http://127.0.0.1:"+(process.env.PORT||"8080");
 let ready=false;
 for(let i=0;i<50;i++){
  await new Promise(resolve=>setTimeout(resolve,1000));
  try{const r=await fetch(base+"/api/health",{signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break}}catch{}
 }
 if(!ready){console.error("[RAG E2E] FAIL: API health not ready");return}
 console.log("[RAG E2E] Starting real API session, diagnostic, clarification and recommendation");
 const test=spawn(process.execPath,["scripts/e2e-storage.mjs"],{stdio:"inherit",env:{...process.env,E2E_BASE_URL:base}});
 const code=await new Promise(resolve=>test.on("exit",resolve));
 console.log("[RAG E2E] Full recommendation and persistence test:",code===0?"PASS":"FAIL (exit "+code+")");
})().catch(e=>console.error("[RAG E2E] Error:",e.message));
