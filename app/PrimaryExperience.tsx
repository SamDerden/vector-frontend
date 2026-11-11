"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/api";
import { activityTitles, interestLabels } from "@/lib/age-view";
import { browserStorage, sessionHeader, type SessionScope } from "@/lib/session-store";
import "./primary-experience.css";

type Activity = { id: string; title: string; description: string; tags: string[]; steps: string[]; duration: string; adult: boolean };
type Stage = "interests" | "activities" | "route" | "reflection" | "complete";
type Reflection = { feeling: "useful" | "unsure" | "not_useful"; difficulty: string; next: string };
const ACTIVITIES: Activity[] = [
  {id:"nature-observer",title:"Детектив природы",description:"Найди три разных листа и сравни их форму.",tags:["природа","экология","исследование","животные","растения"],steps:["Попроси взрослого пойти с тобой на прогулку.","Найди три разных листа, не срывая их с растений.","Нарисуй самый необычный и расскажи, чем он отличается."],duration:"20–30 минут",adult:true},
  {id:"paper-bridge",title:"Мост из бумаги",description:"Построй бумажный мост и проверь, что он выдержит.",tags:["техника","конструирование","строительство","инженерия"],steps:["Возьми бумагу и две книги.","Попробуй построить мост между книгами.","Проверь мост лёгкими предметами и улучши конструкцию."],duration:"15–20 минут",adult:false},
  {id:"story-maker",title:"Моя история",description:"Придумай короткую историю с неожиданным героем.",tags:["творчество","искусство","рисование","литература"],steps:["Придумай героя и место действия.","Нарисуй три картинки с началом, серединой и концом.","Расскажи историю другу или взрослому."],duration:"20 минут",adult:false},
  {id:"kindness-project",title:"Маленькая помощь",description:"Придумай доброе дело и сделай его вместе со взрослым.",tags:["помощь","люди","общение","общество"],steps:["Подумай, кому нужна помощь.","Обсуди идею со взрослым.","Сделай доброе дело и вспомни, что получилось."],duration:"15–30 минут",adult:true},
  {id:"pattern-hunt",title:"Охотник за закономерностями",description:"Найди повторяющиеся узоры вокруг себя.",tags:["логика","математика","данные","анализ","исследование"],steps:["Найди дома три повторяющихся узора.","Придумай свой узор из фигур.","Попроси друга угадать правило."],duration:"15 минут",adult:false},
  {id:"game-designer",title:"Создай свою игру",description:"Придумай настольную игру с простыми правилами.",tags:["игры","организация","команда","творчество","программирование"],steps:["Придумай цель игры.","Нарисуй игровое поле или карточки.","Сыграй со взрослым и улучши правила."],duration:"30 минут",adult:true}
];
const icons = ["🌿","⚙️","🎨","🤝","🔎","🎲"];
const initialReflection: Reflection = {feeling:"useful",difficulty:"clear",next:"try"};

export default function PrimaryExperience({result, grade, scope, notice, onRestart}:{
  result: Record<string, unknown> | null; grade: number; scope: SessionScope; notice?: string; onRestart:()=>void
}) {
  const [stage,setStage]=useState<Stage>("interests");
  const [selected,setSelected]=useState<string[]>([]);
  const [completed,setCompleted]=useState<string[]>([]);
  const [reflection,setReflection]=useState<Reflection>(initialReflection);
  const [saving,setSaving]=useState(false);
  const [saveState,setSaveState]=useState<"idle"|"saved"|"error">("idle");
  const [expanded,setExpanded]=useState<string|null>(null);
  const key = "vector:primary:journey:" + (scope.mode==="demo" ? "demo:"+scope.studentId : "own");
  const interests = useMemo(()=>interestLabels(result?.interestTags),[result]);
  const activities = useMemo(()=>{
    const generated = activityTitles(result?.activities);
    if (generated.length) return generated.map((item)=>ACTIVITIES.find(a=>a.id===item.id) ?? {
      id:item.id,title:item.title,description:"Активность из подтверждённого каталога.",tags:[],steps:[],duration:"",adult:false
    });
    const normalized = interests.join(" ").toLowerCase();
    const matches = ACTIVITIES.filter(item=>item.tags.some(tag=>normalized.includes(tag)));
    // Fallback activities are explicitly general ideas, never attributed to the AI.
    return matches.length ? matches : ACTIVITIES;
  },[result,interests]);
  const hasCatalogActivities = activityTitles(result?.activities).length>0;

  useEffect(()=>{
    try {
      const raw=localStorage.getItem(key); if(!raw)return;
      const data=JSON.parse(raw);
      if(Array.isArray(data.selected))setSelected(data.selected.filter((v:unknown)=>typeof v==="string"));
      if(Array.isArray(data.completed))setCompleted(data.completed.filter((v:unknown)=>typeof v==="string"));
      if(data.reflection && typeof data.reflection==="object")setReflection({...initialReflection,...data.reflection});
      if(["interests","activities","route","reflection","complete"].includes(data.stage))setStage(data.stage);
      if(data.saveState==="saved")setSaveState("saved");
    }catch{}
  },[key]);
  useEffect(()=>{try{localStorage.setItem(key,JSON.stringify({selected,completed,reflection,stage,saveState}))}catch{}},[key,selected,completed,reflection,stage,saveState]);

  const go=(next:Stage)=>{setStage(next);window.scrollTo({top:0,behavior:"smooth"})};
  const chosen=activities.filter(a=>selected.includes(a.id));
  const toggle=(id:string)=>setSelected(prev=>prev.includes(id)?prev.filter(v=>v!==id):[...prev,id]);
  const toggleDone=(id:string)=>setCompleted(prev=>prev.includes(id)?prev.filter(v=>v!==id):[...prev,id]);
  async function submitReflection(){
    if(saving)return;
    setSaving(true);setSaveState("idle");
    try {
      const headers=sessionHeader(scope,browserStorage(scope));
      if(!headers)throw new Error("Сессия не найдена. Рефлексия сохранена только в этом браузере.");
      const response=await fetch(API_BASE+"/api/reflection",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify({
        rating:reflection.feeling,
        comment:JSON.stringify({version:"primary-v1",grade,difficulty:reflection.difficulty,next:reflection.next,activityIds:selected,completedIds:completed})
      })});
      if(!response.ok)throw new Error("Сервер не подтвердил сохранение.");
      setSaveState("saved");go("complete");
    }catch{setSaveState("error");go("complete")}finally{setSaving(false)}
  }
  const stages:[Stage,string][]=[["interests","Мои интересы"],["activities","Что попробовать"],["route","Мой маршрут"],["reflection","Дневник открытий"]];
  return <section className="primary-world">
    <div className="primary-world-head"><span className="primary-chip">1–4 классы · {grade} класс</span><span className="primary-chip secondary">✦ Моё путешествие открытий</span></div>
    <div className="primary-world-steps" aria-label="Этапы путешествия">{stages.map(([id,title],index)=><button key={id} type="button" className={stage===id?"active":""} onClick={()=>go(id)}><span>{index+1}</span>{title}</button>)}</div>
    {stage==="interests"&&<><div className="primary-world-hero">
      <img src="/assets/mascots/snegurochka/snegurochka_celebrate.png" alt="Снегурочка радуется" />
      <div><span className="primary-kicker">✓ Результаты диагностики</span><h1>Тебе интересно многое!</h1><p>{typeof result?.summary==="string"?result.summary:"Ты исследовал свои интересы. Теперь можно попробовать разные занятия и узнать о себе ещё больше."}</p>{notice&&<p className="primary-note">{notice}</p>}</div>
      <img src="/assets/mascots/leshii/leshii_checklist.png" alt="Леший с блокнотом" />
    </div><div className="primary-panel"><h2>♡ Твои интересы</h2>{interests.length?<div className="primary-interest-grid">{interests.map((item,i)=><article key={item} className="primary-interest-card"><span aria-hidden="true">{icons[i%icons.length]}</span><h3>{item}</h3><p>Это направление можно исследовать через занятия и игры.</p></article>)}</div>:<p>AI пока не выделил подтверждённые интересы. Можно выбрать занятие для свободного исследования — это не персональная рекомендация.</p>}</div><div className="primary-actions"><button className="primary-cta" onClick={()=>go("activities")}>Что можно попробовать →</button></div></>}
    {stage==="activities"&&<><div className="primary-page-heading"><img src="/assets/mascots/leshii/leshii_map.png" alt="Леший с картой"/><div><span className="primary-kicker">Следующий шаг</span><h1>Выбери приключение!</h1><p>{hasCatalogActivities?"Здесь активности, полученные из каталога рекомендаций.":"Пока каталог не вернул персональные активности. Ниже — общие идеи для самостоятельного исследования, не AI-рекомендации."}</p></div></div>
      <div className="primary-activity-grid">{activities.map((a,i)=><article key={a.id} className="primary-activity-card"><div className="primary-activity-art" aria-hidden="true">{icons[i%icons.length]}</div><h3>{a.title}</h3><p>{a.description}</p><div className="primary-activity-meta">{a.duration&&<span>◷ {a.duration}</span>}{a.adult&&<span>С участием взрослого</span>}</div><button type="button" className={selected.includes(a.id)?"primary-outline chosen":"primary-outline"} onClick={()=>toggle(a.id)}>{selected.includes(a.id)?"✓ В моём маршруте":"+ Добавить в маршрут"}</button></article>)}</div>
      <div className="primary-actions"><button className="primary-outline" onClick={()=>go("interests")}>← Интересы</button><button className="primary-cta" disabled={!selected.length} onClick={()=>go("route")}>Мой маршрут ({selected.length}) →</button></div></>}
    {stage==="route"&&<><div className="primary-page-heading"><img src="/assets/mascots/snegurochka/snegurochka_sit_notebook.png" alt="Снегурочка с блокнотом"/><div><span className="primary-kicker">Мои открытия</span><h1>Мой маршрут</h1><p>Выбирай, что попробовать. Отмечай выполненное только после настоящего задания.</p></div></div>
      {chosen.length?<div className="primary-route-list">{chosen.map((a,i)=><article key={a.id} className="primary-route-item"><div className="primary-route-number">{i+1}</div><div><h3>{a.title}</h3><p>{a.description}</p><button className="primary-text-button" onClick={()=>setExpanded(expanded===a.id?null:a.id)}>{expanded===a.id?"Скрыть шаги":"Как выполнить задание ↓"}</button>{expanded===a.id&&(a.steps.length?<ol>{a.steps.map(step=><li key={step}>{step}</li>)}</ol>:<p>Подробные шаги не предоставлены каталогом.</p>)}</div><label className="primary-done"><input type="checkbox" checked={completed.includes(a.id)} onChange={()=>toggleDone(a.id)}/> Выполнено</label></article>)}</div>:<div className="primary-panel"><p>В маршруте ещё нет заданий.</p><button className="primary-outline" onClick={()=>go("activities")}>Выбрать задание</button></div>}
      <div className="primary-actions"><button className="primary-outline" onClick={()=>go("activities")}>← К заданиям</button><button className="primary-cta" onClick={()=>go("reflection")}>Заполнить дневник →</button></div></>}
    {stage==="reflection"&&<><div className="primary-page-heading"><img src="/assets/mascots/leshii/leshii_thinking.png" alt="Леший размышляет"/><div><span className="primary-kicker">Последний этап</span><h1>Дневник открытий</h1><p>Расскажи, как прошло путешествие. Здесь нет неправильных ответов!</p></div></div>
      <div className="primary-panel primary-reflection"><h2>Как тебе путешествие?</h2><div className="primary-choice-row">{([["useful","😍","Очень понравилось"],["unsure","🙂","Было интересно"],["not_useful","😐","Не очень понравилось"]] as const).map(([id,emoji,label])=><button key={id} className={reflection.feeling===id?"selected":""} onClick={()=>setReflection(v=>({...v,feeling:id}))}><span>{emoji}</span>{label}</button>)}</div>
      <h2>Что было сложным?</h2><div className="primary-radio-list">{[["clear","Всё было понятно"],["choose","Было трудно выбирать"],["questions","Некоторые вопросы были непонятны"]].map(([id,label])=><label key={id}><input type="radio" checked={reflection.difficulty===id} onChange={()=>setReflection(v=>({...v,difficulty:id}))}/>{label}</label>)}</div>
      <h2>Что хочешь делать дальше?</h2><div className="primary-radio-list">{[["try","Попробовать новое задание"],["share","Показать открытия взрослому"],["later","Вернуться позже"]].map(([id,label])=><label key={id}><input type="radio" checked={reflection.next===id} onChange={()=>setReflection(v=>({...v,next:id}))}/>{label}</label>)}</div></div>
      <div className="primary-actions"><button className="primary-outline" onClick={()=>go("route")}>← Мой маршрут</button><button className="primary-cta" disabled={saving} onClick={submitReflection}>{saving?"Сохраняем…":"Завершить путешествие →"}</button></div></>}
    {stage==="complete"&&<><div className="primary-world-hero primary-finale"><img src="/assets/mascots/snegurochka/snegurochka_celebrate.png" alt="Снегурочка"/><div><span className="primary-kicker">★ Путешествие завершено</span><h1>Моя карта открытий</h1><p>Ты исследовал свои интересы и выбрал, что попробовать дальше. Твои интересы могут меняться — и это здорово!</p></div><img src="/assets/mascots/leshii/leshii_jumping_left.png" alt="Леший"/></div>
      <div className="primary-panel"><h2>Мои интересы</h2>{interests.length?<div className="primary-tags">{interests.map(t=><span key={t}>{t}</span>)}</div>:<p>Пока нет подтверждённых направлений.</p>}<h2>Мои задания</h2>{chosen.length?<ul>{chosen.map(a=><li key={a.id}>{a.title} — {completed.includes(a.id)?"выполнено":"хочу попробовать"}</li>)}</ul>:<p>Пока ничего не выбрано.</p>}{saveState==="saved"?<p role="status" className="primary-success">✓ Рефлексия сохранена на сервере.</p>:<p role="alert" className="primary-warning">Не удалось подтвердить сохранение на сервере. Выборы остались в этом браузере — можно повторить отправку.</p>}</div>
      <div className="primary-actions"><button className="primary-outline" onClick={()=>go("reflection")}>← К дневнику</button>{saveState!=="saved"&&<button className="primary-cta" onClick={submitReflection}>Повторить сохранение</button>}<button className="primary-outline" onClick={onRestart}>На главную</button></div></>}
  </section>;
}
