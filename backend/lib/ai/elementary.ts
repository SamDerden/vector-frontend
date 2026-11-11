import childQuestions from "@/data/agent_clarification_1-4.json";
import type { Dossier } from "./dossier";
import type { NormalizedCatalog } from "./catalog";
import { isTrialEligibleForGrade } from "./age";

/**
 * Compatibility adapter for the elementary mapping from the 2026-11-10 ZIP.
 * The ZIP's elementary.ts uses selectedOptions/role/estimated_age, whereas
 * this branch's Dossier stores selected labels in answers[].selected.
 * Keep the source mapping IDs and evidence threshold, never invent trials.
 * The source mapping's agent-category associations need analyst verification.
 */
const directions = [
  ["tech","ind_001","Техника и машины","007 026 027 040 042 099 110"],
  ["digital","ind_003","Компьютеры и программы","010 012 013 015 025 041 047 057 098 100 101 103 104"],
  ["creative","ind_013","Творчество","022 023"],
  ["help","ind_004","Забота о людях","033"],
  ["education","ind_005","Обучение других","003 048"],
  ["nature","ind_015","Природа и животные","001 002 005 006 008 031 044 093 094 095 102"],
  ["finance","ind_010","Финансы и анализ","062"],
  ["services","ind_011","Торговля и услуги","046 049 052 066 067 080"],
  ["design","ind_012","Дизайн","004 019 050 063 105 106"]
] as const;
const sourceMappings: Array<[string,string,string]> = [
["elementary_q1_subjects","Математика","tech"],["elementary_q1_subjects","Окружающий мир","nature"],["elementary_q1_subjects","Изобразительное искусство","creative"],["elementary_q1_subjects","Музыка","creative"],["elementary_q1_subjects","Труд (технология)","tech"],
["elementary_q2_free_time","Рисовать и мастерить","creative"],["elementary_q2_free_time","Играть в компьютерные игры","digital"],["elementary_q2_free_time","Собирать конструктор","tech"],["elementary_q2_free_time","Ухаживать за животными","nature"],
["elementary_q3_dream_profession","Врачом","help"],["elementary_q3_dream_profession","Учителем","education"],["elementary_q3_dream_profession","Программистом","digital"],["elementary_q3_dream_profession","Художником","creative"],["elementary_q3_dream_profession","Ветеринаром","nature"],["elementary_q3_dream_profession","Космонавтом","tech"],
["elementary_q4_curious","О животных и природе","nature"],["elementary_q4_curious","О космосе и звёздах","tech"],["elementary_q4_curious","О том, как устроены машины и техника","tech"],["elementary_q4_curious","О здоровье и теле человека","help"],
["elementary_q5_books_cartoons","Про животных","nature"],["elementary_q5_books_cartoons","Про роботов и технику","tech"],["elementary_q5_books_cartoons","Про добрые дела и дружбу","help"],
["elementary_q6_friends","Строить и мастерить что-то","tech"],["elementary_q6_friends","Рисовать и делать поделки","creative"],["elementary_q6_friends","Решать задачки и головоломки","tech"],["elementary_q6_friends","Устраивать представления","creative"],
["elementary_q7_interesting_profession","Врач","help"],["elementary_q7_interesting_profession","Артист","creative"],["elementary_q7_interesting_profession","Ветеринар","nature"],["elementary_q7_interesting_profession","Программист","digital"],
["elementary_q8_want_to_learn","Хорошо рисовать","creative"],["elementary_q8_want_to_learn","Играть на музыкальном инструменте","creative"],["elementary_q8_want_to_learn","Программировать и делать игры","digital"],["elementary_q8_want_to_learn","Разбираться в технике","tech"],["elementary_q8_want_to_learn","Ухаживать за животными","nature"],["elementary_q8_want_to_learn","Строить и мастерить","tech"],
["elementary_q9_excursion","В зоопарк","nature"],["elementary_q9_excursion","В музей техники","tech"],["elementary_q9_excursion","В планетарий","tech"],["elementary_q9_excursion","На фабрику или завод","tech"],["elementary_q9_excursion","В театр","creative"],["elementary_q9_excursion","В оранжерею","nature"],
["elementary_q10_hands_on","Лепить из пластилина","creative"],["elementary_q10_hands_on","Собирать конструктор","tech"],["elementary_q10_hands_on","Рисовать и раскрашивать","creative"],["elementary_q10_hands_on","Мастерить поделки из бумаги","creative"],["elementary_q10_hands_on","Разбирать и чинить вещи","tech"],
["elementary_q11_dream","Изобрести что-то важное","tech"],["elementary_q11_dream","Помогать людям","help"],["elementary_q11_dream","Защищать природу","nature"],["elementary_q11_dream","Сделать что-то красивое","creative"],
["elementary_q12_nature_interest","Дикие животные и хищники","nature"],["elementary_q12_nature_interest","Домашние животные","nature"],["elementary_q12_nature_interest","Морские обитатели","nature"],["elementary_q12_nature_interest","Динозавры и древние существа","nature"],["elementary_q12_nature_interest","Деревья и цветы","nature"],["elementary_q12_nature_interest","Насекомые","nature"],["elementary_q12_nature_interest","Птицы","nature"],
["elementary_q13_future_direction","Творческое (рисование, музыка, театр)","creative"],["elementary_q13_future_direction","Техническое (техника, машины, роботы)","tech"],["elementary_q13_future_direction","Медицинское (врач, помощь людям)","help"],["elementary_q13_future_direction","Природное (животные, растения, экология)","nature"],["elementary_q13_future_direction","Образовательное (учить других)","education"],["elementary_q13_future_direction","Компьютерное (программы, игры)","digital"],
["agent_q1_likes","Разбираться в технике, собирать, чинить, мастерить","tech"],["agent_q1_likes","Ухаживать за животными и растениями, быть на природе","nature"],["agent_q1_likes","Рисовать, писать, придумывать идеи, снимать видео","creative"],["agent_q1_likes","Общаться, помогать другим, учить, поддерживать","help"],["agent_q1_likes","Работать с цифрами, таблицами, анализировать информацию","finance"],["agent_q1_likes","Организовывать процессы, руководить, убеждать","services"],
["agent_q3_tasks","Практические: что-то сделать руками, починить, собрать","tech"],["agent_q3_tasks","Аналитические: найти ошибку, изучить данные, построить логику","finance"],["agent_q3_tasks","Творческие: придумать дизайн, написать текст, создать новое","design"],["agent_q3_tasks","Коммуникативные: договориться, убедить, помочь клиенту","services"]
];
const childValuesByLabel = new Map(childQuestions.agent_clarification_questions.flatMap(q=>q.options.map(o=>[q.question_id+"\u0000"+o.label,o.value] as const)));
const lookup = new Map(sourceMappings.map(([question,label,direction])=>[question+"\u0000"+label,direction]));
const clarificationValues:Record<string,Record<string,string>>={
 agent_q1_likes:{tech:"tech",nature:"nature",creative:"creative",people:"help",data:"finance",business:"services"},
 agent_q3_tasks:{hands_on:"tech",analytical:"finance",creative:"design",communicative:"services"}
};
export type ElementaryDirection = { industry_id:string; tag:string; evidence_refs:string[]; activity_ids:string[] };
export function buildElementaryTargets(dossier:Dossier,catalog:NormalizedCatalog):{targets:ElementaryDirection[];warnings:string[]} {
 const warnings=new Set<string>();
 const evidence=new Map<string,string[]>();
 const validDirections=new Set<string>(directions.map(d=>d[0]));
 for(const answer of dossier.answers){
   // Only answers about interests contribute evidence; logistical constraints do not.
   if(answer.questionnaire==="agent_clarification" && !["agent_q1_likes","agent_q3_tasks"].includes(answer.questionId))continue;
   for(const selected of answer.selected){
     const direction=lookup.get(answer.questionId+"\u0000"+selected)??clarificationValues[answer.questionId]?.[childValuesByLabel.get(answer.questionId+"\u0000"+selected)??selected];
     if(!direction || !validDirections.has(direction)){warnings.add("unmapped_answer");continue}
     const refs=evidence.get(direction)??[];
     if(!refs.includes(answer.ref))refs.push(answer.ref);
     evidence.set(direction,refs);
   }
 }
 const byId=new Map(catalog.trials.map(t=>[t.trial_id,t]));
 const targets=directions.flatMap(([directionId,industryId,tag,trialNumbers]):ElementaryDirection[]=>{
   const refs=evidence.get(directionId)??[];
   if(refs.length<2 && !refs.some(ref=>dossier.answers.some(a=>a.ref===ref && a.questionnaire==="agent_clarification")))return [];
   const activity_ids=trialNumbers.split(" ").map(num=>"trial_"+num).filter(id=>{
     const trial=byId.get(id);
     if(!trial || !isTrialEligibleForGrade({...trial,trial_type:trial.trial_type??null},dossier.student.grade))return false;
     const format=(trial.format??"").toLowerCase();
     const online=/онлайн|online|дистанц/.test(format);
     const offline=/очно|офлайн|offline|смешан/.test(format);
     const preferredFormat=dossier.constraints.format;
     if(preferredFormat==="online" && !online)return false;
     if(preferredFormat==="offline" && !offline)return false;
     if(dossier.constraints.free_only===true && !/бесплат|free|^0(?:[,.]0+)?$/i.test(trial.cost??""))return false;
     if(dossier.constraints.time_limit===true && (typeof trial.duration_minutes!=="number" || trial.duration_minutes>180))return false;
     const sameCity=dossier.student.in_region && (trial.municipality??"").trim().toLowerCase()==="екатеринбург";
     if(dossier.constraints.place==="near_home" && !sameCity)return false;
     return online || sameCity;
   }).slice(0,3);
   if(!activity_ids.length)warnings.add("activity_mapping_missing");
   return [{industry_id:industryId,tag,evidence_refs:refs.slice(0,3),activity_ids}];
 }).sort((a,b)=>b.evidence_refs.length-a.evidence_refs.length).slice(0,5);
 return {targets,warnings:[...warnings]};
}
