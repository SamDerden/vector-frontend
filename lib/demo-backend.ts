import { demoQuestions } from "./demo-questions";
import type { demoProfiles } from "./demo-profiles";
import { API_BASE } from "./api";

type Profile = (typeof demoProfiles)[number];
type Answers = Record<number, number[]>;

async function request<T>(path:string,session:string,body:unknown):Promise<T>{
  const response=await fetch(`${API_BASE}${path}`,{
    method:"POST",cache:"no-store",
    headers:{"Content-Type":"application/json","X-Session-ID":session},
    body:JSON.stringify(body),
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||`Backend returned ${response.status}`);
  return payload as T;
}

/** Separate demo session so demo answers cannot overwrite a real student's session. */
export async function generateDemoWithBackend(profile:Profile,answers:Answers){
  const session=crypto.randomUUID();
  await request("/api/track/select",session,{
    trackType:"interests",schoolGrade:profile.grade,
  });
  const diagnosticAnswers=[
    {questionId:"demo_profile_interests",answer:[...profile.interests]},
    ...demoQuestions.map((q,i)=>({
      questionId:`demo_question_${i+1}`,
      answer:(answers[i]||[]).map(choice=>q.options[choice]),
    })),
  ];
  if(diagnosticAnswers.some(item=>!item.answer.length)){
    throw new Error("Ответь на все шесть вопросов, чтобы получить рекомендации.");
  }
  await request("/api/diagnostic/submit",session,{answers:diagnosticAnswers});
  return request<Record<string,unknown>>("/api/recommendations/generate",session,{});
}
