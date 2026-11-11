import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { OpenAICompatibleClient } from "../lib/ai/llm/openaiCompatible.ts";
import { resetCircuitBreaker } from "../lib/ai/llm/circuitBreaker.ts";

async function mockGateway(handler: (request: any, response: any, count: number) => void) {
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    handler(req, res, ++count);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock listener missing");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function withClient(
  handler: (request: any, response: any, count: number) => void,
  run: (client: OpenAICompatibleClient, requests: () => number) => Promise<void>
) {
  const gateway = await mockGateway(handler);
  const previous = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  process.env.LLM_BASE_URL = gateway.url;
  process.env.LLM_API_KEY = "test-only-key";
  process.env.LLM_MODEL = "test-model";
  resetCircuitBreaker();
  try {
    await run(new OpenAICompatibleClient(), gateway.requests);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCircuitBreaker();
    await gateway.close();
  }
}

const messages = [{ role: "user" as const, content: "Тест" }];

test("successful gateway response returns generated text", async () => {
  await withClient((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 8 } }));
  }, async (client, requests) => {
    const result = await client.chat(messages, { timeoutMs: 1000, maxAttempts: 1 });
    assert.equal(result.text, '{"ok":true}');
    assert.equal(requests(), 1);
  });
});

test("gateway HTTP 503 retries then returns a valid response", async () => {
  await withClient((_req, res, count) => {
    res.writeHead(count === 1 ? 503 : 200, { "Content-Type": "application/json" });
    res.end(count === 1
      ? JSON.stringify({ error: "temporary" })
      : JSON.stringify({ choices: [{ message: { content: "recovered" } }] }));
  }, async (client, requests) => {
    const result = await client.chat(messages, { timeoutMs: 1000, maxAttempts: 2, deadlineAt: Date.now() + 4000 });
    assert.equal(result.text, "recovered");
    assert.equal(requests(), 2);
  });
});

test("slow gateway respects deadline even when timeoutMs is zero", async () => {
  await withClient((_req, res) => {
    // Do not send a response; Axios must abort by the remaining deadline.
    res.on("error", () => {});
  }, async (client, requests) => {
    const start = Date.now();
    await assert.rejects(
      client.chat(messages, { timeoutMs: 0, maxAttempts: 1, deadlineAt: Date.now() + 250 }),
      /LLM_FAILED_ALL_ATTEMPTS/
    );
    assert.equal(requests(), 1);
    assert.ok(Date.now() - start < 2000, "request exceeded bounded deadline");
  });
});
