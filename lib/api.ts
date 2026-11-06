export const API_BASE=process.env.NEXT_PUBLIC_API_BASE_URL||"http://localhost:3000";
export function sessionId(){if(typeof window==="undefined")return "";let id=localStorage.getItem("X-Session-ID");if(!id){id=crypto.randomUUID();localStorage.setItem("X-Session-ID",id)}return id}
export async function api<T=any>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(`${API_BASE}${path}`,{...init,headers:{"Content-Type":"application/json","X-Session-ID":sessionId(),...init.headers},cache:"no-store"});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`Ошибка сервера ${response.status}`);return data as T}
export const post=(path:string,body:unknown)=>api(path,{method:"POST",body:JSON.stringify(body)});
