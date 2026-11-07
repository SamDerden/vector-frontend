import llmConfig from "@/config/llm.config.json";
import { ChatMessage, LLMClient } from "./llm/client";
import { ValidationContext, ValidationResult, validateResponse } from "./validate";
import { getRecommendationResponseFormat } from "./output-json-schema";
import { softSanitizeResponse } from "./soft-sanitize";

export interface GenerationCall {
  responseText: string;
  latencyMs: number;
  usage?: unknown;
  providerCostUsd?: number;
}

export async function generateValidatedResponse(
  client: LLMClient,
  messages: ChatMessage[],
  context: ValidationContext,
  deadlineAt: number
): Promise<{
  validation: Extract<ValidationResult, { success: true }>;
  attempts: number;
  calls: GenerationCall[];
  sanitized: boolean;
}> {
  let correctionMessages = messages;
  let lastErrors: string[] = [];
  const calls: GenerationCall[] = [];
  const responseFormat = getRecommendationResponseFormat(context.tier);
  let sanitized = false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;

    let response: Awaited<ReturnType<LLMClient["chat"]>>;
    try {
      response = await client.chat(correctionMessages, {
        timeoutMs: Math.min(llmConfig.attempt_timeout_ms, remaining),
        deadlineAt,
        maxAttempts: 1,
        temperature: attempt === 1 ? llmConfig.temperature : 0,
        topP: llmConfig.top_p,
        maxTokens: llmConfig.max_tokens_by_tier[context.tier],
        responseFormat,
      });
    } catch (error) {
      if (lastErrors.length > 0) {
        const cause = error instanceof Error ? error.message : "unknown LLM error";
        throw new Error(
          `LLM_CORRECTION_FAILED: ${cause}; предыдущие ошибки валидации: ${lastErrors.join("; ")}`
        );
      }
      throw error;
    }
    calls.push({
      responseText: response.text,
      latencyMs: response.latencyMs,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      ...(response.providerCostUsd === undefined
        ? {}
        : { providerCostUsd: response.providerCostUsd }),
    });
    const validation = validateResponse(response.text, context);
    if (validation.success) return { validation, attempts: attempt, calls, sanitized };

    let responseTextForCorrection = response.text;
    let errorsForCorrection = validation.errors;
    if (validation.errors.some((error) => error.includes("содержит цифры"))) {
      try {
        const sanitizedText = softSanitizeResponse(response.text, context);
        const sanitizedValidation = validateResponse(sanitizedText, context);
        if (sanitizedValidation.success) {
          sanitized = true;
          return {
            validation: sanitizedValidation,
            attempts: attempt,
            calls,
            sanitized,
          };
        }
        responseTextForCorrection = sanitizedText;
        errorsForCorrection = sanitizedValidation.errors;
        sanitized = true;
      } catch (error) {
        const cause = error instanceof Error ? error.message : "неизвестная ошибка";
        errorsForCorrection = [...errorsForCorrection, `softSanitize: ${cause}`];
      }
    }

    lastErrors = errorsForCorrection;
    if (attempt === 1) {
      correctionMessages = [
        ...messages,
        { role: "assistant", content: responseTextForCorrection },
        {
          role: "user",
          content: JSON.stringify({
            validation_errors: lastErrors,
            allowed_ids: {
              industries: [...context.industryIds],
              professions: [...context.candidateProfessionIds],
              profession_industries: Object.entries(
                context.professionIndustryById ?? {}
              ).filter(([professionId]) =>
                context.candidateProfessionIds.has(professionId)
              ).map(([profession_id, industry_id]) => ({
                profession_id,
                industry_id,
              })),
              evidence_refs: [...context.answerRefs],
              activity_types: [...(context.activityTypes ?? [])],
            },
            instruction:
              "Исправь ответ. Верни ТОЛЬКО валидный JSON-объект, без markdown, без текста до или после JSON; если исправить невозможно — {}. Ошибки: " +
              lastErrors.slice(0, 8).join("; ") +
              ". Удали цифры и любые числовые значения из всех текстовых полей, сократи каждое предложение до возрастного лимита, добавь warning related_trial_warning при смежном пути. Используй только allowed_ids; industry_id должен соответствовать профессии. Сохрани обязательные поля.",
          }),
        },
      ];
    }
  }

  throw new Error(
    lastErrors.length
      ? `LLM_VALIDATION_FAILED: ${lastErrors.join("; ")}`
      : "LLM_DEADLINE_EXCEEDED"
  );
}
