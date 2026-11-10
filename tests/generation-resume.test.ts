import assert from "node:assert/strict";
import test from "node:test";

import { generateDemoWithBackend, generationScreenFromResume, resumeStoredGeneration } from "../lib/demo-backend.ts";
import { presentGeneration } from "../lib/generation-result.ts";
import { openGenerationRequest, readGenerationRequest, requestStorageKey } from "../lib/session-store.ts";

const OWN = "11111111-1111-4111-8111-111111111111";
const DEMO = "22222222-2222-4222-8222-222222222222";

function storage(initial: Array<[string, string]> = []) {
  const values = new Map(initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

function install(store: ReturnType<typeof storage>) {
  const previous = globalThis.window;
  Object.defineProperty(globalThis, "window", { value: { localStorage: store }, configurable: true });
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { value: previous, configurable: true });
  };
}

const six = ["1", "2", "3", "4", "5", "6"].map((value, index) => ({ questionId: `c${index}`, answer: [value] }));

test("request ids stay separate for each demo student and the own session", () => {
  const store = storage();
  const own = openGenerationRequest({ mode: "own" }, store, () => OWN);
  const first = openGenerationRequest({ mode: "demo", studentId: 2 }, store, () => DEMO);
  const again = openGenerationRequest({ mode: "demo", studentId: 2 }, store, () => "33333333-3333-4333-8333-333333333333");
  const other = openGenerationRequest({ mode: "demo", studentId: 7 }, store, () => "44444444-4444-4444-8444-444444444444");
  assert.equal(own, OWN);
  assert.equal(again, first);
  assert.notEqual(other, first);
  assert.notEqual(requestStorageKey({ mode: "own" }), requestStorageKey({ mode: "demo", studentId: 2 }));
});

test("the idempotency key is stored before the first POST and 202 does not look like success", async () => {
  const store = storage([["X-Session-ID", OWN]]);
  const restore = install(store);
  const calls: string[] = [];
  let polls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith("/api/track/select")) {
      assert.equal(store.values.has("vector-generation-request-own"), true);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (path.endsWith("/api/recommendations/generate")) {
      const stored = JSON.parse(String(store.values.get("vector-generation-request-own")));
      return new Response(JSON.stringify({ requestId: stored.requestId, jobStatus: "running", status: "in_progress", retryAfterMs: 1 }), { status: 202 });
    }
    if (path.includes("/api/recommendations/jobs/")) {
      polls += 1;
      return new Response(JSON.stringify({ status: "generated", summary: "Готово", recommendationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", model: "retrieval_only", generation: { mode: "retrieval_only" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const saved = await generateDemoWithBackend({
      grade: 7,
      track: "explore",
      diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
      clarificationAnswers: six,
      storage: store,
    });
    assert.equal(saved.result.summary, "Готово");
    assert.match(saved.notice ?? "", /каталогу/);
    assert.equal(polls, 1);
    assert.equal(calls[0].endsWith("/api/track/select"), true);
    const generate = calls.findIndex((path) => path.endsWith("/api/recommendations/generate"));
    assert.equal(generate > 0, true);
    assert.equal(calls.some((path) => path.includes(OWN) && path.includes("/jobs/")), false);
  } finally {
    globalThis.fetch = previous;
    restore();
  }
});

test("409, JSON 502 and HTML 502 stay failures", () => {
  const conflict = presentGeneration(409, { error: "Idempotency key was already used with different input", details: { code: "idempotency_conflict", jobStatus: "conflict" } }, true);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.match(conflict.message, /другими ответами/);
  const diagnostic = presentGeneration(409, { error: "Complete the diagnostic before generating recommendations", details: { code: "diagnostic_required" } }, true);
  assert.equal(diagnostic.ok, false);
  if (!diagnostic.ok) {
    assert.match(diagnostic.message, /диагностику/);
    assert.doesNotMatch(diagnostic.message, /другими ответами/);
  }
  const grade = presentGeneration(409, { error: "School grade is required before Sofi recommendations", details: { code: "school_grade_required" } }, true);
  assert.equal(grade.ok, false);
  if (!grade.ok) assert.match(grade.message, /класс/);
  const unknown = presentGeneration(409, { error: "Complete the diagnostic before generating recommendations" }, true);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.message, /не запускалась/);
  const json = presentGeneration(502, { error: "AI service request failed" }, true);
  assert.equal(json.ok, false);
  if (!json.ok) assert.match(json.message, /Не удалось собрать рекомендации/);
  const html = presentGeneration(502, null, false);
  assert.equal(html.ok, false);
  if (!html.ok) assert.match(html.message, /временно недоступен/);
});

test("reloading restores a completed result and does not generate again", async () => {
  const requestId = "55555555-5555-4555-8555-555555555555";
  const store = storage([
    ["X-Session-ID", OWN],
    ["vector-generation-request-own", JSON.stringify({ requestId, state: "open" })],
  ]);
  const calls: string[] = [];
  const saved = await resumeStoredGeneration({ mode: "own" }, {
    storage: store,
    fetchImpl: async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith("/api/session")) {
        return new Response(JSON.stringify({ recommendation: null, activeJob: { requestId, jobStatus: "running", retryAfterMs: 1 } }), { status: 200 });
      }
      if (path.endsWith(`/api/recommendations/jobs/${requestId}`)) {
        return new Response(JSON.stringify({ status: "generated", summary: "Сохранено", recommendationId: requestId }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(saved && "result" in saved && saved.result.summary, "Сохранено");
  assert.equal(calls.some((path) => path.endsWith("/api/recommendations/generate")), false);
});

test("a failed job is shown without starting another generation", async () => {
  const requestId = "66666666-6666-4666-8666-666666666666";
  const store = storage([
    ["X-Session-ID", OWN],
    ["vector-generation-request-own", JSON.stringify({ requestId, state: "settled" })],
  ]);
  const calls: string[] = [];
  const restored = await resumeStoredGeneration({ mode: "own" }, {
    storage: store,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/session")) return new Response(JSON.stringify({ recommendation: null }), { status: 200 });
      return new Response(JSON.stringify({ error: "AI service request failed" }), { status: 502 });
    },
  });
  assert.equal(restored && "ok" in restored && restored.ok, false);
  if (restored && "message" in restored) assert.match(restored.message, /Не удалось собрать рекомендации/);
  assert.equal(calls.some((path) => path.endsWith("/api/recommendations/generate")), false);
});

test("polling stops when the caller aborts", async () => {
  const requestId = "77777777-7777-4777-8777-777777777777";
  const store = storage([["X-Session-ID", OWN]]);
  const controller = new AbortController();
  let polls = 0;
  const pending = resumeStoredGeneration({ mode: "own" }, {
    storage: store,
    signal: controller.signal,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/session")) {
        return new Response(JSON.stringify({ activeJob: { requestId, jobStatus: "pending", retryAfterMs: 50 } }), { status: 200 });
      }
      polls += 1;
      if (polls === 1) controller.abort();
      return new Response(JSON.stringify({ requestId, jobStatus: "pending", status: "in_progress", retryAfterMs: 50 }), { status: 202 });
    },
  });
  const restored = await pending;
  assert.equal(restored, null);
  assert.equal(polls < 5, true);
});

test("a lost generate response keeps the request id and reloads the saved result", async () => {
  const store = storage([["X-Session-ID", OWN]]);
  const restore = install(store);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("socket closed"); };
  try {
    await assert.rejects(() => generateDemoWithBackend({
      grade: 7,
      track: "explore",
      diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
      clarificationAnswers: six,
      storage: store,
    }));
  } finally {
    globalThis.fetch = previous;
    restore();
  }
  const open = readGenerationRequest({ mode: "own" }, store);
  assert.equal(open?.state, "open");
  const calls: string[] = [];
  const restored = await resumeStoredGeneration({ mode: "own" }, {
    storage: store,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/session")) return new Response(JSON.stringify({ recommendation: null }), { status: 200 });
      return new Response(JSON.stringify({ status: "generated", summary: "После обрыва", recommendationId: open?.requestId, model: "retrieval_only" }), { status: 200 });
    },
  });
  assert.equal(restored && "result" in restored && restored.result.summary, "После обрыва");
  assert.equal(calls.some((path) => path.endsWith("/api/recommendations/generate")), false);
});

test("polling timeout and an HTML 502 keep the same request id", async () => {
  const store = storage([["X-Session-ID", OWN]]);
  const restore = install(store);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/recommendations/generate")) {
      return new Response(JSON.stringify({ requestId: "ignored", jobStatus: "running", status: "in_progress", retryAfterMs: 1 }), { status: 202 });
    }
    if (String(url).includes("/api/recommendations/jobs/")) {
      return new Response(JSON.stringify({ requestId: "ignored", jobStatus: "running", status: "in_progress", retryAfterMs: 1 }), { status: 202 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await assert.rejects(
      () => generateDemoWithBackend({
        grade: 7,
        track: "explore",
        diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
        clarificationAnswers: six,
        storage: store,
      }),
      /ещё собираются/
    );
    const timedOut = readGenerationRequest({ mode: "own" }, store);
    assert.equal(timedOut?.state, "open");
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/api/recommendations/generate")) return new Response("<html>bad gateway</html>", { status: 502 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await assert.rejects(
      () => generateDemoWithBackend({
        grade: 7,
        track: "explore",
        diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
        clarificationAnswers: six,
        storage: store,
      }),
      /временно недоступен/
    );
    assert.equal(readGenerationRequest({ mode: "own" }, store)?.requestId, timedOut?.requestId);
    assert.equal(readGenerationRequest({ mode: "own" }, store)?.state, "open");
  } finally {
    globalThis.fetch = previous;
    restore();
  }
});

test("a missing diagnostic does not settle the request or start another generation", async () => {
  const store = storage([["X-Session-ID", OWN]]);
  const restore = install(store);
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith("/api/recommendations/generate")) {
      return new Response(JSON.stringify({
        error: "Complete the diagnostic before generating recommendations",
        details: { code: "diagnostic_required" },
      }), { status: 409 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await assert.rejects(() => generateDemoWithBackend({
      grade: 7,
      track: "explore",
      diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
      clarificationAnswers: six,
      storage: store,
    }), /диагностику/);
    const open = readGenerationRequest({ mode: "own" }, store);
    assert.equal(open?.state, "open");
    assert.equal(calls.filter((path) => path.endsWith("/api/recommendations/generate")).length, 1);
  } finally {
    globalThis.fetch = previous;
    restore();
  }
});

test("a confirmed failed job can be retried with a new request id", async () => {
  const store = storage([["X-Session-ID", OWN]]);
  const restore = install(store);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/recommendations/generate")) {
      return new Response(JSON.stringify({ error: "AI service request failed", details: { jobStatus: "failed", errorCode: "pipeline_failed" } }), { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await assert.rejects(() => generateDemoWithBackend({
      grade: 7,
      track: "explore",
      diagnosticAnswers: [{ questionId: "q1", answer: "техника" }],
      clarificationAnswers: six,
      storage: store,
    }), /Не удалось собрать рекомендации/);
    const failed = readGenerationRequest({ mode: "own" }, store);
    assert.equal(failed?.state, "settled");
    const next = openGenerationRequest({ mode: "own" }, store, () => "88888888-8888-4888-8888-888888888888");
    assert.notEqual(next, failed?.requestId);
  } finally {
    globalThis.fetch = previous;
    restore();
  }
});

test("restoring one student does not reveal another student's result", async () => {
  const demoRequest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownRequest = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const store = storage([
    ["X-Session-ID", OWN],
    ["vector-session-demo-2", DEMO],
    ["vector-generation-request-own", JSON.stringify({ requestId: ownRequest, state: "open" })],
    ["vector-generation-request-demo-2", JSON.stringify({ requestId: demoRequest, state: "open" })],
  ]);
  const seen: string[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const path = String(url);
    seen.push(path);
    const session = new Headers(init?.headers).get("X-Session-ID");
    if (path.endsWith("/api/session")) {
      return new Response(JSON.stringify({ recommendation: null }), { status: 200 });
    }
    if (session === OWN) {
      return new Response(JSON.stringify({ status: "generated", summary: "Свой", recommendationId: ownRequest }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "generated", summary: "Демо 2", recommendationId: demoRequest }), { status: 200 });
  };
  const own = await resumeStoredGeneration({ mode: "own" }, { storage: store, fetchImpl });
  const demo = await resumeStoredGeneration({ mode: "demo", studentId: 2 }, { storage: store, fetchImpl });
  assert.equal(own && "result" in own && own.result.summary, "Свой");
  assert.equal(demo && "result" in demo && demo.result.summary, "Демо 2");
  assert.equal(seen.some((path) => path.includes(OWN) || path.includes(DEMO)), false);
  const cleared = generationScreenFromResume(null, false);
  assert.equal(cleared.result, null);
  assert.equal(cleared.view, null);
  assert.equal(generationScreenFromResume({ result: { hypotheses: [] }, notice: null }, false).view, "results");
  assert.equal(generationScreenFromResume({ result: { hypotheses: [{ title: "Инженер" }] }, notice: null }, true).view, "profile");
});

test("a missing generation schema does not look like a finished recommendation", async () => {
  const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const store = storage([
    ["X-Session-ID", OWN],
    ["vector-generation-request-own", JSON.stringify({ requestId, state: "open" })],
  ]);
  const calls: string[] = [];
  const restored = await resumeStoredGeneration({ mode: "own" }, {
    storage: store,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: "Database schema is outdated. Run npm run db:migrate" }), { status: 503 });
    },
  });
  assert.equal(restored, null);
  assert.equal(calls.some((path) => path.endsWith("/api/recommendations/generate")), false);
});
