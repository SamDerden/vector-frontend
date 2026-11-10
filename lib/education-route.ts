import { API_BASE } from "./api";
import {
  readSessionId,
  sessionHeader,
  type SessionScope,
} from "./session-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAVED_ID = /^(?:program:prog_\d{3,4}|program:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|prog_\d{3,4}|trial_\d{3,4}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export const ROUTE_UNSYNCED_NOTICE = "Маршрут сохранён на этом устройстве и ещё не синхронизирован.";
export const ROUTE_CONFLICT_NOTICE = "На сервере более новая версия маршрута. Изменения на этом устройстве сохранены и не заменили её. Нажми «Сохранить мою версию», чтобы записать их поверх сервера, или «Оставить серверную версию».";
export const ROUTE_LEGACY_NOTICE = "На сервере уже есть маршрут этой сессии. Прежняя копия на устройстве сохранена отдельно.";
export const ROUTE_INVALID_ID_NOTICE = "Маршрут содержит идентификатор вне каталога и остаётся только на этом устройстве.";
export const ROUTE_SCHEMA_NOTICE = "Сервер ещё не хранит маршруты. Копия на этом устройстве сохранена.";

export type ServerRouteSnapshot = {
  completed: number[];
  saved: string[];
  version: number;
  updatedAt: string;
};

export type LocalEducationRoute = {
  professionKey: string;
  completed: number[];
  saved: string[];
  version: number | null;
  updatedAt: string | null;
  pending: boolean;
  stamp: number;
  remote: ServerRouteSnapshot | null;
};

export type RouteSyncResult = {
  route: LocalEducationRoute;
  notice: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function routeStorageKey(scope: SessionScope, professionId: string | null): string {
  const owner = scope.mode === "demo" ? `demo-${scope.studentId}` : "own";
  return `vector-route-v2-${owner}-${professionId || "none"}`;
}

export function legacyRouteStorageKey(storageKey: string): string {
  return storageKey.replace("vector-route-v2-", "vector-route-v2-legacy-");
}

export function professionKeyFor(professionId: string | null): string {
  return professionId && UUID.test(professionId) ? professionId.toLowerCase() : "none";
}

export function acceptsSavedId(value: string): boolean {
  return SAVED_ID.test(value);
}

function completedFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const stages: number[] = [];
  for (const item of value) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 0 && item < 5 && !stages.includes(item)) {
      stages.push(item);
    }
  }
  return stages;
}

function savedFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const saved: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && !saved.includes(item)) saved.push(item);
  }
  return saved;
}

export function readLocalRoute(storage: Pick<Storage, "getItem">, storageKey: string, professionKey: string): LocalEducationRoute {
  const empty: LocalEducationRoute = {
    professionKey,
    completed: [],
    saved: [],
    version: null,
    updatedAt: null,
    pending: false,
    stamp: 0,
    remote: null,
  };
  const raw = storage.getItem(storageKey);
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return empty;
    const completed = completedFrom(parsed.completed);
    const saved = savedFrom(parsed.saved);
    const version = typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version >= 1
      ? parsed.version
      : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    const stamp = typeof parsed.stamp === "number" && Number.isInteger(parsed.stamp) && parsed.stamp >= 0 ? parsed.stamp : 0;
    const hasProgress = completed.length > 0 || saved.length > 0;
    const pending = typeof parsed.pending === "boolean" ? parsed.pending : version == null && hasProgress;
    return { professionKey, completed, saved, version, updatedAt, pending, stamp, remote: remoteFrom(parsed.remote) };
  } catch {
    return empty;
  }
}

function sameProgress(left: { completed: number[]; saved: string[] }, right: { completed: number[]; saved: string[] }): boolean {
  const stages = (values: number[]) => [...values].sort((a, b) => a - b).join(",");
  return stages(left.completed) === stages(right.completed) && left.saved.join("\n") === right.saved.join("\n");
}

export function writeLocalRoute(storage: StorageLike, storageKey: string, route: LocalEducationRoute): LocalEducationRoute {
  const previous = readLocalRoute(storage, storageKey, route.professionKey);
  const next = { ...route, stamp: previous.stamp + 1 };
  storage.setItem(storageKey, JSON.stringify({
    completed: next.completed,
    saved: next.saved,
    version: next.version,
    updatedAt: next.updatedAt,
    pending: next.pending,
    stamp: next.stamp,
    remote: next.remote,
  }));
  return next;
}

function preserveLegacy(storage: StorageLike, storageKey: string) {
  const legacyKey = legacyRouteStorageKey(storageKey);
  if (storage.getItem(legacyKey) != null) return;
  const current = storage.getItem(storageKey);
  if (current) storage.setItem(legacyKey, current);
}

type ServerRoute = ServerRouteSnapshot & {
  professionKey: string;
};

function remoteFrom(value: unknown): ServerRouteSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) return null;
  if (typeof value.updatedAt !== "string") return null;
  return {
    completed: completedFrom(value.completed),
    saved: savedFrom(value.saved),
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

function snapshotFrom(route: ServerRoute): ServerRouteSnapshot {
  return {
    completed: route.completed,
    saved: route.saved,
    version: route.version,
    updatedAt: route.updatedAt,
  };
}

function conflictServerRoute(payload: unknown): ServerRoute | null {
  if (!isRecord(payload)) return null;
  const details = payload.details;
  if (isRecord(details)) return serverRoute(details.route);
  return null;
}

function keepConflict(
  storage: StorageLike,
  storageKey: string,
  local: LocalEducationRoute,
  remote: ServerRoute | null
): RouteSyncResult {
  if (!remote || sameProgress(local, remote)) {
    if (!remote) return { route: local, notice: ROUTE_CONFLICT_NOTICE };
    const route = writeLocalRoute(storage, storageKey, {
      professionKey: remote.professionKey,
      completed: remote.completed,
      saved: remote.saved,
      version: remote.version,
      updatedAt: remote.updatedAt,
      pending: false,
      stamp: local.stamp,
      remote: null,
    });
    return { route, notice: "" };
  }
  const route = writeLocalRoute(storage, storageKey, {
    professionKey: local.professionKey,
    completed: local.completed,
    saved: local.saved,
    version: local.version,
    updatedAt: local.updatedAt,
    pending: true,
    stamp: local.stamp,
    remote: snapshotFrom(remote),
  });
  return { route, notice: ROUTE_CONFLICT_NOTICE };
}

function serverRoute(payload: unknown): ServerRoute | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.professionKey !== "string") return null;
  if (typeof payload.version !== "number" || !Number.isInteger(payload.version)) return null;
  if (typeof payload.updatedAt !== "string") return null;
  return {
    professionKey: payload.professionKey,
    completed: completedFrom(payload.completed),
    saved: savedFrom(payload.saved),
    version: payload.version,
    updatedAt: payload.updatedAt,
  };
}

async function readPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export async function persistEducationRoute(input: {
  scope: SessionScope;
  storage: StorageLike;
  storageKey: string;
  professionKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RouteSyncResult> {
  const local = readLocalRoute(input.storage, input.storageKey, input.professionKey);
  const unsynced = { route: local, notice: ROUTE_UNSYNCED_NOTICE };
  const session = sessionHeader(input.scope, input.storage);
  if (!session) return unsynced;
  if (local.version == null && (local.completed.length > 0 || local.saved.length > 0)) {
    preserveLegacy(input.storage, input.storageKey);
  }
  if (local.saved.some((item) => !acceptsSavedId(item))) {
    return { route: local, notice: ROUTE_INVALID_ID_NOTICE };
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(`${API_BASE}/api/education-route`, {
      method: "PUT",
      cache: "no-store",
      signal: input.signal,
      headers: { "Content-Type": "application/json", ...session },
      body: JSON.stringify({
        professionKey: input.professionKey,
        completed: local.completed,
        saved: local.saved,
        version: local.version,
      }),
    });
    const payload = await readPayload(response);
    if (input.signal?.aborted) return unsynced;
    const latest = readLocalRoute(input.storage, input.storageKey, input.professionKey);
    if (latest.stamp !== local.stamp) return { route: latest, notice: latest.pending ? ROUTE_UNSYNCED_NOTICE : "" };
    if (response.status === 503) return { route: local, notice: ROUTE_SCHEMA_NOTICE };
    if (response.status === 409) return keepConflict(input.storage, input.storageKey, local, conflictServerRoute(payload));
    const saved = serverRoute(payload);
    if (!response.ok || !saved) return unsynced;
    const route = writeLocalRoute(input.storage, input.storageKey, {
      professionKey: saved.professionKey,
      completed: saved.completed,
      saved: saved.saved,
      version: saved.version,
      updatedAt: saved.updatedAt,
      pending: false,
      stamp: local.stamp,
      remote: null,
    });
    return { route, notice: "" };
  } catch {
    return unsynced;
  }
}

export async function restoreEducationRoute(input: {
  scope: SessionScope;
  storage: StorageLike;
  storageKey: string;
  professionKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RouteSyncResult> {
  const local = readLocalRoute(input.storage, input.storageKey, input.professionKey);
  const session = readSessionId(input.scope, input.storage);
  if (!session) {
    return { route: local, notice: local.pending ? ROUTE_UNSYNCED_NOTICE : "" };
  }
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${API_BASE}/api/education-route?professionKey=${encodeURIComponent(input.professionKey)}`,
      {
        cache: "no-store",
        signal: input.signal,
        headers: { "X-Session-ID": session },
      }
    );
    const payload = await readPayload(response);
    if (input.signal?.aborted) return { route: local, notice: local.pending ? ROUTE_UNSYNCED_NOTICE : "" };
    const latest = readLocalRoute(input.storage, input.storageKey, input.professionKey);
    if (latest.stamp !== local.stamp) {
      return persistEducationRoute({ ...input, signal: undefined });
    }
    if (response.status === 503) return { route: local, notice: local.pending || local.completed.length || local.saved.length ? ROUTE_SCHEMA_NOTICE : "" };
    if (!response.ok && response.status !== 404) {
      return { route: local, notice: local.pending || local.completed.length || local.saved.length ? ROUTE_UNSYNCED_NOTICE : "" };
    }
    const remote = response.ok ? serverRoute(payload) : null;
    if (!remote) {
      if (!local.pending && local.completed.length === 0 && local.saved.length === 0) return { route: local, notice: "" };
      return persistEducationRoute(input);
    }
    if (local.version == null && (local.completed.length > 0 || local.saved.length > 0)) {
      preserveLegacy(input.storage, input.storageKey);
      if (!sameProgress(local, remote)) {
        const route = writeLocalRoute(input.storage, input.storageKey, {
          professionKey: remote.professionKey,
          completed: remote.completed,
          saved: remote.saved,
          version: remote.version,
          updatedAt: remote.updatedAt,
          pending: false,
          stamp: local.stamp,
          remote: null,
        });
        return { route, notice: ROUTE_LEGACY_NOTICE };
      }
    }
    if (local.pending && local.version != null && local.version < remote.version) {
      if (sameProgress(local, remote)) {
        const route = writeLocalRoute(input.storage, input.storageKey, {
          professionKey: remote.professionKey,
          completed: remote.completed,
          saved: remote.saved,
          version: remote.version,
          updatedAt: remote.updatedAt,
          pending: false,
          stamp: local.stamp,
          remote: null,
        });
        return { route, notice: "" };
      }
      return keepConflict(input.storage, input.storageKey, local, remote);
    }
    if (local.pending && local.version === remote.version) return persistEducationRoute(input);
    const route = writeLocalRoute(input.storage, input.storageKey, {
      professionKey: remote.professionKey,
      completed: remote.completed,
      saved: remote.saved,
      version: remote.version,
      updatedAt: remote.updatedAt,
      pending: false,
      stamp: local.stamp,
      remote: null,
    });
    return { route, notice: "" };
  } catch {
    return { route: local, notice: local.pending || local.completed.length || local.saved.length ? ROUTE_UNSYNCED_NOTICE : "" };
  }
}

export async function saveLocalRouteAfterConflict(input: {
  scope: SessionScope;
  storage: StorageLike;
  storageKey: string;
  professionKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RouteSyncResult> {
  const local = readLocalRoute(input.storage, input.storageKey, input.professionKey);
  if (!local.remote) return persistEducationRoute(input);
  const session = sessionHeader(input.scope, input.storage);
  if (!session) return { route: local, notice: ROUTE_UNSYNCED_NOTICE };
  try {
    const response = await (input.fetchImpl ?? fetch)(`${API_BASE}/api/education-route`, {
      method: "PUT",
      cache: "no-store",
      signal: input.signal,
      headers: { "Content-Type": "application/json", ...session },
      body: JSON.stringify({
        professionKey: input.professionKey,
        completed: local.completed,
        saved: local.saved,
        version: local.remote.version,
      }),
    });
    const payload = await readPayload(response);
    if (input.signal?.aborted) return { route: local, notice: ROUTE_UNSYNCED_NOTICE };
    const latest = readLocalRoute(input.storage, input.storageKey, input.professionKey);
    if (latest.stamp !== local.stamp) return { route: latest, notice: latest.pending ? ROUTE_UNSYNCED_NOTICE : "" };
    if (response.status === 409) return keepConflict(input.storage, input.storageKey, local, conflictServerRoute(payload));
    const saved = serverRoute(payload);
    if (!response.ok || !saved) return { route: local, notice: ROUTE_UNSYNCED_NOTICE };
    const route = writeLocalRoute(input.storage, input.storageKey, {
      professionKey: saved.professionKey,
      completed: saved.completed,
      saved: saved.saved,
      version: saved.version,
      updatedAt: saved.updatedAt,
      pending: false,
      stamp: local.stamp,
      remote: null,
    });
    return { route, notice: "" };
  } catch {
    return { route: local, notice: ROUTE_UNSYNCED_NOTICE };
  }
}

export function adoptStoredServerRoute(input: {
  storage: StorageLike;
  storageKey: string;
  professionKey: string;
}): LocalEducationRoute {
  const local = readLocalRoute(input.storage, input.storageKey, input.professionKey);
  if (!local.remote) return local;
  preserveLegacy(input.storage, input.storageKey);
  return writeLocalRoute(input.storage, input.storageKey, {
    professionKey: input.professionKey,
    completed: local.remote.completed,
    saved: local.remote.saved,
    version: local.remote.version,
    updatedAt: local.remote.updatedAt,
    pending: false,
    stamp: local.stamp,
    remote: null,
  });
}
