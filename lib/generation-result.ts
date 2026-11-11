export type GenerationPresentation =
  | { ok: true; pending?: false; fallback: boolean; body: Record<string, unknown>; notice: string | null }
  | { ok: true; pending: true; fallback: false; body: Record<string, unknown>; notice: null; requestId: string; retryAfterMs: number }
  | { ok: false; message: string };

const CATALOG_NOTICE = "Рекомендации собраны по каталогу: ответ модели сейчас не использован. Результат сохранён.";
const JSON_FAILURE = "Не удалось собрать рекомендации. Попробуй ещё раз.";
const PROXY_FAILURE = "Сервис рекомендаций временно недоступен. Попробуй ещё раз.";
const IDEMPOTENCY_CONFLICT = "Этот запрос уже использован с другими ответами. Запусти генерацию ещё раз.";
const DIAGNOSTIC_REQUIRED = "Сначала заполни диагностику. Повторная генерация не запускалась.";
const GRADE_REQUIRED = "Сначала укажи класс. Повторная генерация не запускалась.";
const OTHER_CONFLICT = "Запрос отклонён. Повторная генерация не запускалась.";

export type GenerationConflictKind = "idempotency" | "diagnostic" | "grade" | "other";

export function generationConflictKind(payload: unknown): GenerationConflictKind {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "other";
  const details = (payload as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return "other";
  const record = details as { jobStatus?: unknown; code?: unknown };
  if (record.jobStatus === "conflict" || record.code === "idempotency_conflict") return "idempotency";
  if (record.code === "diagnostic_required") return "diagnostic";
  if (record.code === "school_grade_required") return "grade";
  return "other";
}

function generationMode(body: Record<string, unknown>): unknown {
  const generation = body.generation;
  if (generation && typeof generation === "object" && "mode" in generation) {
    return (generation as { mode?: unknown }).mode;
  }
  return body.model;
}

export function presentGeneration(
  status: number,
  payload: unknown,
  parsedJson: boolean
): GenerationPresentation {
  if (!parsedJson || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: PROXY_FAILURE };
  }
  const body = payload as Record<string, unknown>;
  if (status === 201) {
    const fallback = generationMode(body) === "retrieval_only";
    return { ok: true, fallback, body, notice: fallback ? CATALOG_NOTICE : null };
  }
  if (status === 202 && typeof body.requestId === "string") {
    const retryAfterMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : 2000;
    return { ok: true, pending: true, fallback: false, body, notice: null, requestId: body.requestId, retryAfterMs };
  }
  if (status === 409) {
    const kind = generationConflictKind(body);
    if (kind === "idempotency") return { ok: false, message: IDEMPOTENCY_CONFLICT };
    if (kind === "diagnostic") return { ok: false, message: DIAGNOSTIC_REQUIRED };
    if (kind === "grade") return { ok: false, message: GRADE_REQUIRED };
    return { ok: false, message: OTHER_CONFLICT };
  }
  if (status === 429) return { ok: false, message: (body.details && typeof body.details === "object" && (body.details as {code?: unknown}).code === "queue_full") ? "Сейчас «Вектор» помогает сразу многим ребятам. Твои ответы сохранены! Подожди немного — проходить тест заново не нужно." : "Сейчас слишком много запросов. Подожди минуту и повтори." };
  if (status === 502) return { ok: false, message: JSON_FAILURE };
  return { ok: false, message: status ? `Не удалось получить рекомендации (${status}).` : JSON_FAILURE };
}
