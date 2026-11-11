export type SessionScope =
  | { mode: "own" }
  | { mode: "demo"; studentId: number };

type SessionStorage = Pick<Storage, "getItem" | "setItem">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The UUID locates a session; it is not proof of ownership.
// Demo sessions are tab-scoped; own sessions may persist for seven days.
// Keep identifiers out of URLs, logs, and analytics.
export function sessionStorageKey(scope: SessionScope): string {
  if (scope.mode === "own") return "X-Session-ID";
  if (!Number.isInteger(scope.studentId) || scope.studentId < 1) {
    throw new Error("Demo session requires a student id");
  }
  return `vector-session-demo-${scope.studentId}`;
}

export function readSessionId(scope: SessionScope, storage: Pick<Storage, "getItem">): string | null {
  const existing = storage.getItem(sessionStorageKey(scope));
  return existing && UUID_PATTERN.test(existing) ? existing : null;
}

export function readOrCreateSessionId(
  scope: SessionScope,
  storage: SessionStorage,
  createId: () => string = () => crypto.randomUUID()
): string {
  const existing = readSessionId(scope, storage);
  if (existing) return existing;
  const created = createId();
  if (!UUID_PATTERN.test(created)) throw new Error("Session id must be a UUID");
  storage.setItem(sessionStorageKey(scope), created);
  return created;
}

export function sessionHeader(
  scope: SessionScope,
  storage: Pick<Storage, "getItem">
): { "X-Session-ID": string } | null {
  const session = readSessionId(scope, storage);
  return session ? { "X-Session-ID": session } : null;
}

export function browserStorage(scope: SessionScope): Storage {
  if (typeof window === "undefined") throw new Error("Browser storage is unavailable");
  return scope.mode === "demo" ? window.sessionStorage : window.localStorage;
}

export function browserSessionId(scope: SessionScope): string {
  if (typeof window === "undefined") return "";
  return readOrCreateSessionId(scope, browserStorage(scope));
}

export function generationSessionScope(input: { dossier?: { studentId: number } }): SessionScope {
  return input.dossier
    ? { mode: "demo", studentId: input.dossier.studentId }
    : { mode: "own" };
}

export function requestStorageKey(scope: SessionScope): string {
  if (scope.mode === "own") return "vector-generation-request-own";
  if (!Number.isInteger(scope.studentId) || scope.studentId < 1) {
    throw new Error("Demo session requires a student id");
  }
  return `vector-generation-request-demo-${scope.studentId}`;
}

type StoredRequest = { requestId: string; state: "open" | "settled" };

function readStoredRequest(scope: SessionScope, storage: Pick<Storage, "getItem">): StoredRequest | null {
  const raw = storage.getItem(requestStorageKey(scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { requestId?: unknown; state?: unknown };
    if (typeof parsed.requestId !== "string" || !UUID_PATTERN.test(parsed.requestId)) return null;
    return { requestId: parsed.requestId.toLowerCase(), state: parsed.state === "open" ? "open" : "settled" };
  } catch {
    return null;
  }
}

export function openGenerationRequest(
  scope: SessionScope,
  storage: SessionStorage,
  createId: () => string = () => crypto.randomUUID()
): string {
  const existing = readStoredRequest(scope, storage);
  if (existing?.state === "open") return existing.requestId;
  const created = createId().trim().toLowerCase();
  if (!UUID_PATTERN.test(created)) throw new Error("Request id must be a UUID");
  storage.setItem(requestStorageKey(scope), JSON.stringify({ requestId: created, state: "open" }));
  return created;
}

export function readGenerationRequest(scope: SessionScope, storage: Pick<Storage, "getItem">): { requestId: string; state: "open" | "settled" } | null {
  return readStoredRequest(scope, storage);
}

export function settleGenerationRequest(scope: SessionScope, storage: SessionStorage) {
  const existing = readStoredRequest(scope, storage);
  if (!existing) return;
  storage.setItem(requestStorageKey(scope), JSON.stringify({ requestId: existing.requestId, state: "settled" }));
}
