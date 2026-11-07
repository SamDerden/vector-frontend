import type { PoolClient } from "pg";

import {
  getClarificationQuestions,
  type ClarificationQuestion,
} from "./catalog-data.ts";

type ClarificationAnswerInput = {
  questionId: string;
  answer: unknown;
};

function selectedValues(answer: unknown): string[] {
  if (typeof answer === "string") {
    return [answer];
  }
  if (typeof answer === "boolean" || typeof answer === "number") {
    return [String(answer)];
  }
  if (Array.isArray(answer)) {
    return answer.map(String);
  }
  if (answer && typeof answer === "object" && "values" in answer) {
    const values = (answer as { values?: unknown }).values;
    return Array.isArray(values) ? values.map(String) : [];
  }
  return [];
}

export function validateClarificationAnswers(
  answers: ClarificationAnswerInput[],
  questions: ClarificationQuestion[] = getClarificationQuestions()
) {
  const byId = new Map(questions.map((item) => [item.question_id, item]));
  const errors: string[] = [];

  for (const item of answers) {
    const question = byId.get(item.questionId);
    if (!question) {
      errors.push(`Unknown clarification questionId: ${item.questionId}`);
      continue;
    }

    const values = selectedValues(item.answer);
    if (values.length === 0) {
      errors.push(`Empty answer for ${item.questionId}`);
      continue;
    }

    if (question.type === "single_choice" && values.length !== 1) {
      errors.push(`${item.questionId} expects a single choice`);
    }

    const max = question.max_selections ?? (question.type === "multi_choice" ? 10 : 1);
    if (values.length > max) {
      errors.push(`${item.questionId} exceeds max_selections=${max}`);
    }

    const allowed = new Set(question.options.map((option) => option.value));
    const customAllowed = new Set(
      question.options
        .filter((option) => option.allow_custom_text)
        .map((option) => option.value)
    );

    for (const value of values) {
      if (!allowed.has(value)) {
        errors.push(`Invalid option "${value}" for ${item.questionId}`);
      }
    }

    if (
      item.answer &&
      typeof item.answer === "object" &&
      !Array.isArray(item.answer) &&
      "customText" in item.answer &&
      (item.answer as { customText?: string }).customText &&
      !values.some((value) => customAllowed.has(value))
    ) {
      errors.push(`customText is not allowed for ${item.questionId}`);
    }
  }

  return errors;
}

export async function saveClarificationAnswers(
  client: PoolClient,
  params: {
    sessionId: string;
    diagnosticId?: string | null;
    answers: ClarificationAnswerInput[];
  }
) {
  const inserted = await client.query(
    `INSERT INTO clarifications (session_id, diagnostic_id, submitted_at)
     VALUES ($1, $2, now())
     RETURNING id`,
    [params.sessionId, params.diagnosticId ?? null]
  );

  const clarificationId = inserted.rows[0].id as string;

  for (const item of params.answers) {
    await client.query(
      `INSERT INTO clarification_answers
       (clarification_id, question_id, answer)
       VALUES ($1, $2, $3::jsonb)`,
      [clarificationId, item.questionId, JSON.stringify(item.answer)]
    );
  }

  return clarificationId;
}
