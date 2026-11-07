// lib/ai/llm/client.ts

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface ChatResponse {
  text: string;
  usage?: unknown;
  latencyMs: number;
  providerCostUsd?: number;
}

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface LLMClient {
  chat(
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
  ): Promise<ChatResponse>;
}