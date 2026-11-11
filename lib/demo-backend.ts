import { API_BASE } from "./api";
import { generationConflictKind, presentGeneration } from "./generation-result";
import {
  browserSessionId,
  browserStorage,
  generationSessionScope,
  openGenerationRequest,
  readGenerationRequest,
  sessionHeader,
  settleGenerationRequest,
  type SessionScope,
} from "./session-store";

export type StudentDossier = {
  studentId: number;
  grade: number;
  city: string;
  questionnaireName: string;
  answers: Array<{ questionId: string; answer: unknown; question: string }>;
};
export type ClarificationQuestion = {
  question_id: string;
  text: string;
  type: string;
  max_selections?: number;
  options: Array<{ value: string; label: string; allow_custom_text?: boolean; exclusive_with?: string[] }>;
};
export type GeneratedRecommendation = {
  result: Record<string, unknown>;
  notice: string | null;
};

export function generationScreenFromResume(
  restored: GeneratedRecommendation | { ok: false; message: string } | null,
  gradeShowsProfessions: boolean
): { result: Record<string, unknown> | null; error: string; notice: string; view: "results" | "profile" | null } {
  if (!restored || "ok" in restored) {
    return {
      result: null,
      error: restored && "message" in restored ? restored.message : "",
      notice: "",
      view: null,
    };
  }
  return {
    result: restored.result,
    error: "",
    notice: restored.notice ?? "",
    view: gradeShowsProfessions ? "profile" : "results",
  };
}

function terminalJobFailure(status: number, payload: unknown): boolean {
  if (status === 409) return generationConflictKind(payload) === "idempotency";
  if (status !== 502 || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const details = (payload as { details?: { jobStatus?: unknown } }).details;
  return Boolean(details) && typeof details === "object" && (details as { jobStatus?: unknown }).jobStatus === "failed";
}

function requestFailure(message: string, terminal: boolean): Error {
  const error = new Error(message) as Error & { terminalJob?: boolean };
  error.terminalJob = terminal;
  return error;
}

function isTerminalJobError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { terminalJob?: boolean }).terminalJob === true;
}

export async function backendGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера ${response.status}`);
  return payload as T;
}

async function request<T>(path: string, session: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Session-ID": session },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка сервера ${response.status}`);
  return payload as T;
}

export async function fetchDemoStudents() {
  const response = await backendGet<{ data: StudentDossier[] }>("/api/demo/students");
  if (response.data.length !== 15) throw new Error("Не удалось загрузить все 15 анкет");
  return response.data;
}

export async function fetchClarificationQuestions() {
  const response = await backendGet<{ data: ClarificationQuestion[] }>("/api/clarification/questions");
  if (response.data.length !== 6) throw new Error("Ожидалось шесть уточняющих вопросов Sofi");
  return response.data;
}

export async function fetchStoredSession(
  scope: SessionScope,
  storage?: Pick<Storage, "getItem">,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: unknown }> {
  const headers = sessionHeader(scope, storage ?? browserStorage(scope));
  if (!headers) return { status: 404, body: null };
  const response = await fetchImpl(`${API_BASE}/api/session`, {
    cache: "no-store",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function readPayload(raw: string): { payload: unknown; parsedJson: boolean } {
  if (!raw.trim()) return { payload: null, parsedJson: false };
  try {
    const payload = JSON.parse(raw);
    return { payload, parsedJson: payload !== null && typeof payload === "object" };
  } catch {
    return { payload: null, parsedJson: false };
  }
}

async function pollGenerationJob(
  session: string,
  requestId: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<GeneratedRecommendation> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetchImpl(`${API_BASE}/api/recommendations/jobs/${requestId}`, {
      cache: "no-store",
      headers: { "X-Session-ID": session },
      signal,
    });
    const raw = await response.text();
    const { payload, parsedJson } = readPayload(raw);
    if (
      response.status === 200 &&
      parsedJson &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as { status?: unknown }).status === "generated"
    ) {
      const completed = presentGeneration(201, payload, true);
      if (!completed.ok || completed.pending) throw new Error("Не удалось собрать рекомендации. Попробуй ещё раз.");
      return { result: completed.body, notice: completed.notice };
    }
    const presented = presentGeneration(response.status, parsedJson ? payload : null, parsedJson);
    if (!presented.ok) throw requestFailure(presented.message, terminalJobFailure(response.status, payload));
    if (!presented.pending) return { result: presented.body, notice: presented.notice };
    await new Promise((resolve) => setTimeout(resolve, presented.retryAfterMs));
  }
  throw requestFailure("Рекомендации ещё собираются. Обнови страницу через минуту.", false);
}

export async function resumeStoredGeneration(
  scope: SessionScope,
  options: { signal?: AbortSignal; storage?: Pick<Storage, "getItem" | "setItem">; fetchImpl?: typeof fetch } = {}
): Promise<GeneratedRecommendation | { ok: false; message: string } | null> {
  const storage = options.storage ?? browserStorage(scope);
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = sessionHeader(scope, storage);
  if (!headers) return null;
  const response = await fetchImpl(`${API_BASE}/api/session`, { cache: "no-store", headers, signal: options.signal });
  const raw = await response.text();
  const { payload, parsedJson } = readPayload(raw);
  if (!parsedJson || !payload || typeof payload !== "object") return null;
  const body = payload as { activeJob?: { requestId?: string; jobStatus?: string }; recommendation?: Record<string, unknown> | null };
  const active = body.activeJob;
  if (active && (active.jobStatus === "pending" || active.jobStatus === "running") && typeof active.requestId === "string") {
    try {
      return await pollGenerationJob(headers["X-Session-ID"], active.requestId, options.signal, fetchImpl);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      return { ok: false, message: error instanceof Error ? error.message : "Не удалось получить рекомендации." };
    }
  }
  const stored = readGenerationRequest(scope, storage);
  if (stored) {
    const jobResponse = await fetchImpl(`${API_BASE}/api/recommendations/jobs/${stored.requestId}`, {
      cache: "no-store",
      headers,
      signal: options.signal,
    });
    const jobRaw = await jobResponse.text();
    const job = readPayload(jobRaw);
    if (jobResponse.status === 502) {
      const presented = presentGeneration(502, job.parsedJson ? job.payload : null, job.parsedJson);
      return { ok: false, message: presented.ok ? "Не удалось собрать рекомендации. Попробуй ещё раз." : presented.message };
    }
    if (
      jobResponse.status === 200 &&
      job.parsedJson &&
      job.payload &&
      typeof job.payload === "object" &&
      !Array.isArray(job.payload) &&
      (job.payload as { status?: unknown }).status === "generated"
    ) {
      const presented = presentGeneration(201, job.payload, true);
      if (presented.ok && !presented.pending) return { result: presented.body, notice: presented.notice };
    }
  }
  if (body.recommendation && typeof body.recommendation === "object") {
    return { result: body.recommendation, notice: null };
  }
  return null;
}

export async function generateDemoWithBackend(input: {
  dossier?: StudentDossier;
  grade: number;
  track: string;
  diagnosticAnswers?: Array<{ questionId: string; answer: unknown }>;
  clarificationAnswers: Array<{ questionId: string; answer: string[] }>;
  signal?: AbortSignal;
  storage?: Pick<Storage, "getItem" | "setItem">;
  fetchImpl?: typeof fetch;
}): Promise<GeneratedRecommendation> {
  const scope = generationSessionScope(input);
  const session = browserSessionId(generationSessionScope(input));
  if (!session) throw new Error("Сессия доступна только в браузере");
  const storage = input.storage ?? browserStorage(scope);
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestId = openGenerationRequest(scope, storage);
  await request("/api/track/select", session, {trackType:input.dossier?"explore":input.track,schoolGrade:input.dossier?.grade??input.grade,...(input.dossier ? { demoStudentId: input.dossier.studentId } : {})});
  const answers = input.dossier?.answers.map(({ questionId, answer }) => ({ questionId, answer }))
    ?? input.diagnosticAnswers
    ?? [];
  if (!answers.length) throw new Error("Не заполнена исходная диагностика");
  await request("/api/diagnostic/submit", session, { answers });
  await request("/api/clarification/submit", session, { answers: input.clarificationAnswers });
  const response = await fetchImpl(`${API_BASE}/api/recommendations/generate`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Session-ID": session, "Idempotency-Key": requestId },
    body: JSON.stringify({}),
    signal: input.signal,
  });
  const raw = await response.text();
  const { payload, parsedJson } = readPayload(raw);
  const presented = presentGeneration(response.status, parsedJson ? payload : null, parsedJson);
  if (!presented.ok) {
    if (terminalJobFailure(response.status, payload)) settleGenerationRequest(scope, storage);
    throw new Error(presented.message);
  }
  if (presented.pending) {
    try {
      const finished = await pollGenerationJob(session, presented.requestId, input.signal, fetchImpl);
      settleGenerationRequest(scope, storage);
      return finished;
    } catch (error) {
      if (isTerminalJobError(error)) settleGenerationRequest(scope, storage);
      throw error;
    }
  }
  settleGenerationRequest(scope, storage);
  return { result: presented.body, notice: presented.notice };
}
