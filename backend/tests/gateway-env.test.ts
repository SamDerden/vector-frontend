import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gatewayEndpoint,
  readChatGateway,
  readEmbeddingsGateway,
} from "../lib/ai/gateway-env.ts";

const LLM_BASE = "https://llm.example/v1";
const AI_BASE = "https://ai.example/v1";

test("LLM settings take priority over AI_API settings", () => {
  const settings = readChatGateway({
    LLM_BASE_URL: LLM_BASE,
    LLM_API_KEY: "llm-key",
    LLM_MODEL: "llm-model",
    AI_API_BASE_URL: AI_BASE,
    AI_API_KEY: "ai-key",
    AI_MODEL: "ai-model",
  });

  assert.ok(settings);
  assert.equal(settings.baseUrl, LLM_BASE);
  assert.equal(settings.apiKey, "llm-key");
  assert.equal(settings.model, "llm-model");
});

test("chat gateway falls back to AI_API settings", () => {
  const settings = readChatGateway({
    AI_API_BASE_URL: `${AI_BASE}/`,
    AI_API_KEY: "ai-key",
    AI_MODEL: "ai-model",
  });

  assert.ok(settings);
  assert.equal(settings.baseUrl, AI_BASE);
  assert.equal(settings.apiKey, "ai-key");
  assert.equal(settings.model, "ai-model");
});

test("blank LLM settings fall back field by field", () => {
  const settings = readChatGateway({
    LLM_BASE_URL: "  ",
    LLM_API_KEY: "",
    LLM_MODEL: "llm-model",
    AI_API_BASE_URL: AI_BASE,
    AI_API_KEY: "ai-key",
    AI_MODEL: "ai-model",
  });

  assert.ok(settings);
  assert.equal(settings.baseUrl, AI_BASE);
  assert.equal(settings.apiKey, "ai-key");
  assert.equal(settings.model, "llm-model");
});

test("missing chat settings stay unset", () => {
  assert.equal(readChatGateway({}), null);
  assert.equal(readChatGateway({
    AI_API_BASE_URL: AI_BASE,
    AI_API_KEY: "ai-key",
  }), null);
});

test("gateway routes keep a single /v1", () => {
  assert.equal(
    gatewayEndpoint(`${AI_BASE}/`, "chat/completions"),
    "https://ai.example/v1/chat/completions"
  );
  assert.equal(
    gatewayEndpoint("https://ai.example/v1/v1/", "embeddings"),
    "https://ai.example/v1/embeddings"
  );
  assert.equal(
    gatewayEndpoint("https://ai.example", "chat/completions"),
    "https://ai.example/chat/completions"
  );
});

test("embeddings require LLM_EMBEDDINGS_MODEL and ignore chat models", () => {
  const ready = readEmbeddingsGateway({
    AI_API_BASE_URL: AI_BASE,
    AI_API_KEY: "ai-key",
    AI_MODEL: "ai-model",
    LLM_MODEL: "llm-model",
    LLM_EMBEDDINGS_MODEL: "embeddings-model",
  });

  assert.ok(ready);
  assert.equal(ready.baseUrl, AI_BASE);
  assert.equal(ready.apiKey, "ai-key");
  assert.equal(ready.model, "embeddings-model");
  assert.equal(
    gatewayEndpoint(ready.baseUrl, "embeddings"),
    "https://ai.example/v1/embeddings"
  );

  assert.equal(readEmbeddingsGateway({
    LLM_BASE_URL: LLM_BASE,
    LLM_API_KEY: "llm-key",
    LLM_MODEL: "llm-model",
    AI_API_BASE_URL: AI_BASE,
    AI_API_KEY: "ai-key",
    AI_MODEL: "ai-model",
  }), null);
});
