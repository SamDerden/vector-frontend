import {API_BASE} from "./api";
export type StudentDossier={studentId:number;grade:number;city:string;questionnaireName:string;answers:Array<{questionId:string;answer:unknown;question:string}>};
export type ClarificationQuestion={question_id:string;text:string;type:string;max_selections?:number;options:Array<{value:string;label:string;allow_custom_text?:boolean}>};
export async function backendGet<T>(path:string):Promise<T>{
 const response=await fetch(`${API_BASE}${path}`,{cache:"no-store"});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(payload.error||`Ошибка сервера ${response.status}`);
 return payload as T;
}
async function request<T>(path:string,session:string,body:unknown):Promise<T>{
 const response=await fetch(`${API_BASE}${path}`,{method:"POST",cache:"no-store",
 headers:{"Content-Type":"application/json","X-Session-ID":session},body:JSON.stringify(body)});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(payload.error||`Ошибка сервера ${response.status}`);
 return payload as T;
}
export async function fetchDemoStudents(){
 const response=await backendGet<{data:StudentDossier[]}>("/api/demo/students");
 if(response.data.length!==15)throw new Error("Не удалось загрузить все 15 анкет");
 return response.data;
}
export async function fetchClarificationQuestions(){
 const response=await backendGet<{data:ClarificationQuestion[]}>("/api/clarification/questions");
 if(response.data.length!==6)throw new Error("Ожидалось шесть уточняющих вопросов Sofi");
 return response.data;
}
export async function generateDemoWithBackend(input:{
 dossier?:StudentDossier;grade:number;track:string;diagnosticAnswers?:Array<{questionId:string;answer:unknown}>;
 clarificationAnswers:Array<{questionId:string;answer:string[]}>;}){
 const session=crypto.randomUUID();
 await request("/api/track/select",session,{trackType:input.dossier?"explore":input.track,schoolGrade:input.dossier?.grade??input.grade});
 const answers=input.dossier?.answers.map(({questionId,answer})=>({questionId,answer}))??input.diagnosticAnswers??[];
 if(!answers.length)throw new Error("Не заполнена исходная диагностика");
 await request("/api/diagnostic/submit",session,{answers});
 await request("/api/clarification/submit",session,{answers:input.clarificationAnswers});
 return request<Record<string,unknown>>("/api/recommendations/generate",session,{});
}
