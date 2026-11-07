export interface GatewayEnv {
  [key: string]: string | undefined;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_EMBEDDINGS_MODEL?: string;
  AI_API_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}

export interface ChatGatewaySettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingsGatewaySettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function configured(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function prefer(primary: string | undefined, fallback: string | undefined): string | null {
  return configured(primary) ?? configured(fallback);
}

export function normalizeGatewayBase(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  while (base.endsWith("/v1/v1")) {
    base = base.slice(0, -3);
  }
  return base;
}

export function gatewayEndpoint(
  baseUrl: string,
  route: "chat/completions" | "embeddings"
): string {
  return `${normalizeGatewayBase(baseUrl)}/${route}`;
}

export function readChatGateway(env: GatewayEnv): ChatGatewaySettings | null {
  const baseUrl = prefer(env.LLM_BASE_URL, env.AI_API_BASE_URL);
  const apiKey = prefer(env.LLM_API_KEY, env.AI_API_KEY);
  const model = prefer(env.LLM_MODEL, env.AI_MODEL);
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl: normalizeGatewayBase(baseUrl),
    apiKey,
    model,
  };
}

export function readEmbeddingsGateway(env: GatewayEnv): EmbeddingsGatewaySettings | null {
  const baseUrl = prefer(env.LLM_BASE_URL, env.AI_API_BASE_URL);
  const apiKey = prefer(env.LLM_API_KEY, env.AI_API_KEY);
  const model = configured(env.LLM_EMBEDDINGS_MODEL);
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl: normalizeGatewayBase(baseUrl),
    apiKey,
    model,
  };
}
