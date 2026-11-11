import axios from "axios";
import {
  ChatMessage,
  ChatResponse,
  JsonSchemaResponseFormat,
  LLMClient,
} from "./client";
import { isCircuitOpen, recordFailure, recordSuccess } from "./circuitBreaker";
import { gatewayEndpoint, readChatGateway } from "../gateway-env";
import llmConfig from "@/config/llm.config.json";

type ChatCompletionContent =
  | string
  | { type?: string; text?: string; content?: string }[]
  | null;

function extractText(content: ChatCompletionContent): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;

  const text = content.flatMap((part) => {
    if (typeof part.text === "string") return [part.text];
    if (typeof part.content === "string") return [part.content];
    return [];
  }).join("");
  return text.trim() ? text : null;
}

function retryDelayMs(retryAfter: unknown, attempt: number): number {
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  if (typeof value === "string") {
    const retryAt = Date.parse(value);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return Math.min(500 * 2 ** (attempt - 1), 2000);
}

export class OpenAICompatibleClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const settings = readChatGateway(process.env);

    if (!settings) {
      throw new Error("Не заданы LLM_BASE_URL, LLM_API_KEY или LLM_MODEL в .env");
    }

    this.baseUrl = settings.baseUrl;
    this.apiKey = settings.apiKey;
    this.model = settings.model;
  }

  async chat(
    messages: ChatMessage[],
    opts: {
      timeoutMs: number;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      maxAttempts?: number;
      deadlineAt?: number;
      responseFormat?: JsonSchemaResponseFormat;
    }
  ): Promise<ChatResponse> {
    if (isCircuitOpen()) {
      throw new Error("CIRCUIT_OPEN: Используется резервный ответ.");
    }

    const startedAt = Date.now();
    const deadlineAt = opts.deadlineAt ?? startedAt + llmConfig.total_deadline_ms;
    const maxAttempts = opts.maxAttempts ?? 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remainingBudget = deadlineAt - Date.now();
      if (remainingBudget <= 0) break;

      const currentTimeout = opts.timeoutMs === 0
        ? 0
        : Math.min(opts.timeoutMs, llmConfig.attempt_timeout_ms, remainingBudget);

      const attemptStartedAt = Date.now();
      try {
        const requestBody: {
          model: string;
          messages: ChatMessage[];
          temperature: number;
          top_p: number;
          max_tokens?: number;
          response_format?: JsonSchemaResponseFormat;
        } = {
          model: this.model,
          messages,
          temperature: opts.temperature ?? llmConfig.temperature,
          top_p: opts.topP ?? llmConfig.top_p,
        };
        const maxTokens = opts.maxTokens;
        if (maxTokens !== null && maxTokens !== undefined) {
          requestBody.max_tokens = maxTokens;
        }
        if (opts.responseFormat) requestBody.response_format = opts.responseFormat;

        const response = await axios.post(
          gatewayEndpoint(this.baseUrl, "chat/completions"),
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: currentTimeout,
          }
        );

        const choice = response.data?.choices?.[0];
        const text = extractText(choice?.message?.content);
        if (text === null) {
          throw new Error("LLM returned an unexpected response shape");
        }

        console.info("[AI gateway] chat completion", JSON.stringify({ outcome: "success", attempt, attemptMs: Date.now() - attemptStartedAt, totalMs: Date.now() - startedAt, status: response.status }));
        recordSuccess();
        const reportedCost = Number(response.headers?.["x-litellm-response-cost"]);
        return {
          text,
          usage: response.data.usage,
          latencyMs: Date.now() - startedAt,
          ...(Number.isFinite(reportedCost) && reportedCost >= 0
            ? { providerCostUsd: reportedCost }
            : {}),
        };
      } catch (error) {
        lastError = error;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        console.warn("[AI gateway] chat completion", JSON.stringify({ outcome: "failed", attempt, attemptMs: Date.now() - attemptStartedAt, totalMs: Date.now() - startedAt, timeoutMs: currentTimeout, status: status ?? null, code: axios.isAxiosError(error) ? error.code ?? null : error instanceof Error ? error.name : "unknown" }));

        if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          recordFailure();
          throw new Error(`FATAL_LLM_ERROR: ${status}`);
        }

        if (attempt < maxAttempts) {
          const retryAfter = axios.isAxiosError(error)
            ? error.response?.headers["retry-after"]
            : undefined;
          const waitMs = retryDelayMs(retryAfter, attempt);
          if (Date.now() + waitMs >= deadlineAt) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    recordFailure();
    const cause = axios.isAxiosError(lastError)
      ? lastError.response?.status
        ? `HTTP ${lastError.response.status}`
        : lastError.code ?? "network error"
      : lastError instanceof Error
        ? lastError.message
        : "deadline exceeded";
    throw new Error(`LLM_FAILED_ALL_ATTEMPTS: ${cause}`);
  }
}
