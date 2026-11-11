import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source=readFileSync(new URL("../lib/demo-backend.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");

test("demo and own sessions stay stable and separate",()=>{
  assert.match(source,/browserSessionId\(generationSessionScope\(input\)\)/);
  assert.doesNotMatch(source,/crypto\.randomUUID\(\)/);
});
function responseFor(path,response){
  if(typeof response==="function")return response(path);
  return path.endsWith("/api/recommendations/generate")
    ?{status:201,body:JSON.stringify({summary:"ok",hypotheses:[],generation:{mode:"llm"}})}
    :{status:200,body:JSON.stringify({ok:true})};
}
function installBrowser(responses){
  const values=new Map(responses.stored??[]);
  const storage={
    getItem:(key)=>values.get(key)??null,
    setItem:(key,value)=>{values.set(key,value);},
  };
  const sessionValues=new Map();
  const tabStorage={
    getItem:(key)=>sessionValues.get(key)??null,
    setItem:(key,value)=>{sessionValues.set(key,value);},
  };
  const previousWindow=globalThis.window;
  const previousFetch=globalThis.fetch;
  const calls=[];
  Object.defineProperty(globalThis,"window",{value:{localStorage:storage,sessionStorage:tabStorage},configurable:true});
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    const path=String(url);
    const response=responseFor(path,responses.handler);
    return new Response(response.body,{status:response.status,headers:{"Content-Type":response.type??"application/json"}});
  };
  return {storage,tabStorage,calls,restore(){
    if(previousWindow===undefined)delete globalThis.window;
    else Object.defineProperty(globalThis,"window",{value:previousWindow,configurable:true});
    globalThis.fetch=previousFetch;
  }};
}
const six=(values)=>values.map((value,index)=>({questionId:`c${index}`,answer:[value]}));
const dossier=(studentId,grade,answers)=>({
  studentId,grade,city:"Екатеринбург",questionnaireName:"Билет",answers,
});

test("profile grade is submitted to backend",async()=>{
  const {generateDemoWithBackend}=await import("../lib/demo-backend.ts");
  const ownId="11111111-1111-4111-8111-111111111111";
  const browser=installBrowser({
    stored:[["X-Session-ID",ownId],["vector-route-v2-own-none","{}"],["unrelated-note","keep"]],
  });
  try{
    await generateDemoWithBackend({grade:7,track:"interests",diagnosticAnswers:[{questionId:"q1",answer:"техника"}],clarificationAnswers:six(["1","2","3","4","5","6"])});
    const track=browser.calls.find((call)=>call.url.endsWith("/api/track/select"));
    assert.deepEqual(JSON.parse(track.init.body),{trackType:"interests",schoolGrade:7});
    assert.equal(browser.calls.every((call)=>call.init.headers["X-Session-ID"]===ownId),true);
    assert.equal(browser.calls.some((call)=>call.url.includes(ownId)),false);
    assert.equal(browser.storage.getItem("vector-route-v2-own-none"),"{}");
    assert.equal(browser.storage.getItem("unrelated-note"),"keep");
  }finally{browser.restore()}
});
test("profile interests and all six answers are sent to diagnostic",async()=>{
  const {generateDemoWithBackend}=await import("../lib/demo-backend.ts");
  const answers=[{questionId:"interest",answer:"животные",question:"Что нравится?"},{questionId:"q2",answer:false,question:"Второй"}];
  const clarification=six(["a","b","c","d","e","f"]);
  const browser=installBrowser({});
  try{
    await generateDemoWithBackend({dossier:dossier(2,2,answers),grade:10,track:"known_direction",clarificationAnswers:clarification});
    const track=browser.calls.find((call)=>call.url.endsWith("/api/track/select"));
    const diagnostic=browser.calls.find((call)=>call.url.endsWith("/api/diagnostic/submit"));
    const clarify=browser.calls.find((call)=>call.url.endsWith("/api/clarification/submit"));
    assert.deepEqual(JSON.parse(track.init.body),{trackType:"explore",schoolGrade:2,demoStudentId:2});
    assert.deepEqual(JSON.parse(diagnostic.init.body),{answers:[{questionId:"interest",answer:"животные"},{questionId:"q2",answer:false}]});
    assert.deepEqual(JSON.parse(clarify.init.body),{answers:clarification});
    assert.equal(browser.storage.getItem("X-Session-ID"),null);
    assert.equal(browser.storage.getItem("vector-session-demo-2"),null);
    assert.match(browser.tabStorage.getItem("vector-session-demo-2"),/^[0-9a-f-]{36}$/i);
  }finally{browser.restore()}
});
test("AI recommendations are requested after diagnostic",()=>assert.match(source,/api\/recommendations\/generate/));
test("UI keeps honest offline fallback when AI unavailable",async()=>{
  const {generateDemoWithBackend}=await import("../lib/demo-backend.ts");
  async function run(handler){
    const browser=installBrowser({handler});
    try{return await generateDemoWithBackend({grade:7,track:"explore",diagnosticAnswers:[{questionId:"q1",answer:"техника"}],clarificationAnswers:six(["1","2","3","4","5","6"])});}
    finally{browser.restore()}
  }
  const saved=await run((path)=>path.endsWith("/api/recommendations/generate")
    ?{status:201,body:JSON.stringify({summary:"Каталог",hypotheses:[{title:"Кружок"}],model:"retrieval_only",generation:{mode:"retrieval_only"}})}
    :{status:200,body:JSON.stringify({ok:true})});
  assert.equal(saved.result.summary,"Каталог");
  assert.match(saved.notice,/каталогу/);
  assert.doesNotMatch(saved.notice,/Предварительные рекомендации/);
  await assert.rejects(()=>run((path)=>path.endsWith("/api/recommendations/generate")
    ?{status:502,body:JSON.stringify({error:"AI service request failed"})}
    :{status:200,body:JSON.stringify({ok:true})}),/Не удалось собрать рекомендации/);
  await assert.rejects(()=>run((path)=>path.endsWith("/api/recommendations/generate")
    ?{status:502,body:"<html>bad gateway</html>",type:"text/html"}
    :{status:200,body:JSON.stringify({ok:true})}),/временно недоступен/);
  assert.equal(page.includes("Предварительные рекомендации (без AI)"),false);
  assert.match(page,/demoAiError/);
  assert.match(page,/demoAiNotice/);
});
