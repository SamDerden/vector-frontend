/** Illustration registry keyed by backend JSON identifiers. Keep answer labels and values from the API. */
export const clarificationImages: Record<string,Record<string,string>> = {
  "agent_q1_likes": {
    "tech": "/assets/questions/question_01/q01_answer_01.png",
    "nature": "/assets/questions/question_01/q01_answer_02.png",
    "creative": "/assets/questions/question_01/q01_answer_03.png",
    "people": "/assets/questions/question_01/q01_answer_04.png",
    "data": "/assets/questions/question_01/q01_answer_05.png",
    "business": "/assets/questions/question_01/q01_answer_06.png",
    "other": "/assets/questions/question_01/q01_answer_07.png",
  },
  "agent_q2_work_style": {
    "team": "/assets/questions/question_02/q02_answer_01.png",
    "solo": "/assets/questions/question_02/q02_answer_02.png",
    "lead": "/assets/questions/question_02/q02_answer_03.png",
    "hybrid": "/assets/questions/question_02/q02_answer_04.png",
  },
  "agent_q3_tasks": {
    "hands_on": "/assets/questions/question_03/q03_answer_01.png",
    "analytical": "/assets/questions/question_03/q03_answer_02.png",
    "creative": "/assets/questions/question_03/q03_answer_03.png",
    "communicative": "/assets/questions/question_03/q03_answer_04.png",
    "other": "/assets/questions/question_03/q03_answer_05.png",
  },
  "agent_q4_experience": {
    "prog": "/assets/questions/question_04/q04_answer_01.png",
    "robotics": "/assets/questions/question_04/q04_answer_02.png",
    "art": "/assets/questions/question_04/q04_answer_03.png",
    "volunteer": "/assets/questions/question_04/q04_answer_04.png",
    "sports": "/assets/questions/question_04/q04_answer_05.png",
    "none": "/assets/questions/question_04/q04_answer_06.png",
  },
  "agent_q5_format": {
    "offline": "/assets/questions/question_05/q05_answer_01.png",
    "online": "/assets/questions/question_05/q05_answer_02.png",
    "any": "/assets/questions/question_05/q05_answer_03.png",
  },
  "agent_q6_constraints": {
    "free_only": "/assets/questions/question_06/q06_answer_01.png",
    "can_pay": "/assets/questions/question_06/q06_answer_02.png",
    "time_limit": "/assets/questions/question_06/q06_answer_03.png",
    "location": "/assets/questions/question_06/q06_answer_04.png",
    "needs_helper": "/assets/questions/question_06/q06_answer_05.png",
  },
};
export function clarificationImage(questionId:string,optionValue:string):string|undefined {
  return clarificationImages[questionId]?.[optionValue];
}
