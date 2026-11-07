import { demoProfiles } from "./demo-profiles";
import { demoQuestions } from "./demo-questions";

type Profile = (typeof demoProfiles)[number];
type Answers = Record<number, number[]>;

const domains = [
  { id: "engineering", title: "Инженерия и технологии", keys: ["техник", "конструкт", "инженер", "авто", "робот", "изобрет"], activities: ["Попробовать инженерный конструктор или робототехнику", "Найти ознакомительную инженерную мастерскую"] },
  { id: "nature", title: "Природа и биология", keys: ["животн", "природ", "растен", "биолог"], activities: ["Принять участие в экологическом проекте", "Посетить кружок естественных наук"] },
  { id: "creative", title: "Дизайн и творчество", keys: ["рисован", "дизайн", "фотограф", "график", "кино", "видео", "театр", "музык", "вокал", "чтение"], activities: ["Собрать небольшое творческое портфолио", "Попробовать студию дизайна или медиа"] },
  { id: "social", title: "Работа с людьми", keys: ["помощ", "общен", "волонтер", "поддерж", "обучен"], activities: ["Попробовать школьный волонтёрский проект", "Узнать о социальных и образовательных инициативах"] },
  { id: "analytics", title: "Аналитика и исследования", keys: ["анализ", "данн", "стратег", "наук", "цифр", "программ", "it", "игр"], activities: ["Решить исследовательскую или программную задачу", "Попробовать курс по анализу данных"] },
  { id: "business", title: "Предпринимательство и управление", keys: ["бизнес", "маркетинг", "проект", "стартап", "организ", "путешеств"], activities: ["Придумать и проверить идею школьного проекта", "Попробовать роль организатора командного события"] },
] as const;

const questionWeights: Record<number, Record<number, string[]>> = {
  0: {0:["engineering"],1:["nature"],2:["creative"],3:["social"],4:["analytics"],5:["business"]},
  1: {0:["social"],1:["analytics"],2:["business"],3:["social","business"]},
  2: {0:["engineering"],1:["analytics"],2:["creative"],3:["social","business"]},
  3: {0:["analytics"],1:["engineering"],2:["creative"],3:["social"],4:["social"]},
};

export function buildDemoRecommendation(profile: Profile, answers: Answers) {
  const score = Object.fromEntries(domains.map(d=>[d.id,0])) as Record<string,number>;
  const evidence = Object.fromEntries(domains.map(d=>[d.id,[] as string[]])) as Record<string,string[]>;
  for(const interest of profile.interests){
    const text=interest.toLowerCase();
    for(const domain of domains){
      if(domain.keys.some(k=>text.includes(k))){
        score[domain.id]+=2;
        evidence[domain.id].push(`Интерес из анкеты: «${interest}»`);
      }
    }
  }
  for(const [questionIndex,weights] of Object.entries(questionWeights)){
    const qi=Number(questionIndex);
    for(const choice of answers[qi]||[]){
      for(const id of weights[choice]||[]){
        score[id]+= qi===0||qi===2?3:1;
        evidence[id].push(`Ответ: «${demoQuestions[qi].options[choice]}»`);
      }
    }
  }
  const ranked=[...domains].sort((a,b)=>score[b.id]-score[a.id]||a.title.localeCompare(b.title,"ru"));
  const top=ranked.filter(d=>score[d.id]>0).slice(0,3);
  const chosen=top.length?top:ranked.slice(0,2);
  const constraints=(answers[5]||[]).map(i=>demoQuestions[5].options[i]);
  const format=demoQuestions[4].options[answers[4]?.[0]??2];
  const young=profile.grade<=4;
  const hypotheses=chosen.map(d=>({
    title:d.title,
    reason:evidence[d.id].slice(0,3).join(". ")||"Направление для дополнительного исследования",
    score:score[d.id],
  }));
  const nextStepOptions=chosen.map(d=>({
    title:d.activities[young?0:1],
    note:`Формат: ${format}. ${constraints.length?"Учитывай ограничения: "+constraints.join("; "):"Проверь доступность и условия участия."}`,
    available:false,
  }));
  return {
    summary:`Демонстрационные рекомендации для ${profile.name} (${profile.grade} класс) на основе интересов анкеты и шести ответов. ${young?"Это направления занятий и проб, а не выбор профессии.":"Это гипотезы для проверки, а не окончательный профессиональный выбор."}`,
    hypotheses,
    nextStepOptions,
    methodology:"Демонстрационный алгоритм сопоставления интересов и ответов. Не AI-оценка; реальные региональные мероприятия и их доступность не проверялись.",
  };
}
