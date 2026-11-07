import { readFileSync } from "node:fs";
import path from "node:path";

export type ClarificationOption = {
  value: string;
  label: string;
  allow_custom_text?: boolean;
};

export type ClarificationQuestion = {
  question_id: string;
  text: string;
  type: "single_choice" | "multi_choice" | string;
  max_selections?: number;
  options: ClarificationOption[];
};

export type BiletQuestion = {
  id: string;
  text: string;
  options?: string[];
};

export type BiletQuestionnaire = {
  questionnaire_name: string;
  note?: string;
  blocks: Array<{
    block_name: string;
    instruction?: string;
    questions: BiletQuestion[];
  }>;
};

export type MockStudent = {
  student_id: number;
  grade: number;
  city: string;
  questionnaire_name: string;
  answers: Record<string, unknown>;
};

export type GraphProgram = {
  program_id: string;
  name: string;
  organization: string;
  level: string;
  fit_level?: string;
};

export type GraphProfession = {
  profession_id: string;
  name: string;
  industry?: string;
  description_for_kid?: string;
  riasec_profile?: Record<string, number>;
  education_programs?: GraphProgram[];
  trials?: Array<{
    trial_id: string;
    title: string;
    organization?: string;
    format?: string;
    description?: string;
  }>;
};

function readJson<T>(relativePath: string): T {
  const filePath = path.join(process.cwd(), relativePath);
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

let clarificationCache: ClarificationQuestion[] | null = null;
let questionnairesCache: BiletQuestionnaire[] | null = null;
let mockStudentsCache: MockStudent[] | null = null;
let graphCache: GraphProfession[] | null | undefined;
let questionTextCache: Map<string, string> | null = null;

export function getClarificationQuestions(): ClarificationQuestion[] {
  if (!clarificationCache) {
    const data = readJson<{ agent_clarification_questions: ClarificationQuestion[] }>(
      "data/agent_clarification.json"
    );
    clarificationCache = data.agent_clarification_questions ?? [];
  }
  return clarificationCache;
}

export function getBiletQuestionnaires(): BiletQuestionnaire[] {
  if (!questionnairesCache) {
    const data = readJson<{ questionnaires: BiletQuestionnaire[] }>(
      "data/bilet_questions_master.json"
    );
    questionnairesCache = data.questionnaires ?? [];
  }
  return questionnairesCache;
}

export function getMockStudents(): MockStudent[] {
  if (!mockStudentsCache) {
    mockStudentsCache = readJson<MockStudent[]>("data/mock_students_data.json");
  }
  return mockStudentsCache;
}

function asGraphProfessions(data: unknown): GraphProfession[] | null {
  if (Array.isArray(data)) {
    return data as GraphProfession[];
  }
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { professions?: unknown }).professions)
  ) {
    return (data as { professions: GraphProfession[] }).professions;
  }
  return null;
}

export function getNavigatorGraph(): GraphProfession[] | null {
  if (graphCache !== undefined) {
    return graphCache;
  }

  try {
    graphCache = asGraphProfessions(
      readJson<unknown>("data/navigator_full_graph.json")
    );
  } catch {
    graphCache = null;
  }

  return graphCache;
}

export function lookupQuestionText(questionId: string): string | null {
  if (!questionTextCache) {
    questionTextCache = new Map();

    for (const question of getClarificationQuestions()) {
      questionTextCache.set(question.question_id, question.text);
    }

    for (const questionnaire of getBiletQuestionnaires()) {
      for (const block of questionnaire.blocks) {
        for (const question of block.questions) {
          questionTextCache.set(question.id, question.text);
        }
      }
    }
  }

  return questionTextCache.get(questionId) ?? null;
}

export function questionnaireForGrade(grade: number): BiletQuestionnaire | null {
  const questionnaires = getBiletQuestionnaires();
  if (grade >= 1 && grade <= 5) {
    return (
      questionnaires.find((item) => /1-5 класс/.test(item.questionnaire_name)) ??
      null
    );
  }

  const exact = questionnaires.find((item) =>
    new RegExp(`${grade}\\s*класс`).test(item.questionnaire_name)
  );
  return exact ?? null;
}

export function graphProfessionByExternalId(externalId: string) {
  return getNavigatorGraph()?.find((item) => item.profession_id === externalId);
}
