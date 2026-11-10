import assert from "node:assert/strict";
import test from "node:test";

import { showsEducationPrograms, showsProfessions } from "../lib/age-view.ts";
import {
  ROUTE_CONFLICT_NOTICE,
  ROUTE_INVALID_ID_NOTICE,
  ROUTE_LEGACY_NOTICE,
  ROUTE_SCHEMA_NOTICE,
  ROUTE_UNSYNCED_NOTICE,
  legacyRouteStorageKey,
  adoptStoredServerRoute,
  persistEducationRoute,
  saveLocalRouteAfterConflict,
  restoreEducationRoute,
  routeStorageKey,
} from "../lib/education-route.ts";

const OWN = "11111111-1111-4111-8111-111111111111";
const DEMO_ONE = "22222222-2222-4222-8222-222222222222";
const DEMO_TWO = "33333333-3333-4333-8333-333333333333";
const PROFESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function fetchFor(handler: (url: string, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    calls.push({ url: address, init });
    assert.equal(address.includes("/api/recommendations/generate"), false);
    const result = await handler(address, init);
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  return { calls, fetchImpl };
}

test("creating and rereading a route keeps stages and catalog ids on the owning session", async () => {
  const ownKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const browser = storage({ "X-Session-ID": OWN, [ownKey]: JSON.stringify({ completed: [0], saved: ["program:prog_024", "trial_011"], pending: true, stamp: 1 }) });
  let server: { version: number; completed: number[]; saved: string[] } | null = null;
  const { calls, fetchImpl } = fetchFor(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { sessionId?: string; version: number | null; completed: number[]; saved: string[] } : null;
    assert.equal(body?.sessionId, undefined);
    assert.equal(new Headers(init?.headers).get("X-Session-ID"), OWN);
    if (init?.method === "PUT" && body) {
      if (server && body.version !== server.version) return { status: 409, body: { error: "Education route version conflict" } };
      server = { version: (server?.version ?? 0) + 1, completed: body.completed, saved: body.saved };
      return { status: body.version == null ? 201 : 200, body: { professionKey: PROFESSION, ...server, updatedAt: "2026-11-10T18:00:00.000Z" } };
    }
    return server
      ? { status: 200, body: { professionKey: PROFESSION, ...server, updatedAt: "2026-11-10T18:00:00.000Z" } }
      : { status: 404, body: { error: "Education route not found" } };
  });
  const saved = await persistEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.equal(saved.notice, "");
  assert.deepEqual(saved.route.completed, [0]);
  assert.equal(saved.route.version, 1);
  browser.setItem(ownKey, JSON.stringify({ ...JSON.parse(browser.getItem(ownKey) ?? "{}"), completed: [0, 3], pending: true }));
  const changed = await persistEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.deepEqual(changed.route.completed, [0, 3]);
  assert.equal(changed.route.version, 2);
  const restored = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.deepEqual(restored.route.completed, [0, 3]);
  assert.equal(calls.some((call) => call.url.includes("/api/recommendations/generate")), false);
});

test("a stale local version does not replace the newer server route", async () => {
  const ownKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const browser = storage({
    "X-Session-ID": OWN,
    [ownKey]: JSON.stringify({ completed: [1], saved: [], version: 1, pending: true, stamp: 2 }),
  });
  const { calls, fetchImpl } = fetchFor(() => ({
    status: 200,
    body: { professionKey: PROFESSION, completed: [4], saved: ["trial_011"], version: 3, updatedAt: "2026-11-10T19:00:00.000Z" },
  }));
  const restored = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.equal(restored.notice, ROUTE_CONFLICT_NOTICE);
  assert.deepEqual(restored.route.completed, [1]);
  assert.equal(calls.some((call) => call.init?.method === "PUT"), false);
  assert.equal(JSON.parse(browser.getItem(ownKey) ?? "{}").completed[0], 1);
  assert.equal(JSON.parse(browser.getItem(ownKey) ?? "{}").remote.version, 3);
  const retried = await saveLocalRouteAfterConflict({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.version, 3);
      assert.deepEqual(body.completed, [1]);
      return new Response(JSON.stringify({
        professionKey: PROFESSION,
        completed: body.completed,
        saved: body.saved,
        version: 4,
        updatedAt: "2026-11-10T19:10:00.000Z",
      }), { status: 200 });
    },
  });
  assert.equal(retried.notice, "");
  assert.equal(retried.route.version, 4);
  assert.deepEqual(retried.route.completed, [1]);
  assert.equal(retried.route.remote, null);
});

test("the same route progress adopts the server version and the server copy can be kept", async () => {
  const ownKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const browser = storage({
    "X-Session-ID": OWN,
    [ownKey]: JSON.stringify({ completed: [1], saved: ["trial_011"], version: 1, pending: true, stamp: 1 }),
  });
  const adopted = await persistEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: async () => new Response(JSON.stringify({
      error: "Education route version conflict",
      details: {
        route: {
          professionKey: PROFESSION,
          completed: [1],
          saved: ["trial_011"],
          version: 5,
          updatedAt: "2026-11-10T21:00:00.000Z",
        },
      },
    }), { status: 409 }),
  });
  assert.equal(adopted.notice, "");
  assert.equal(adopted.route.version, 5);
  assert.equal(adopted.route.remote, null);
  browser.setItem(ownKey, JSON.stringify({
    completed: [2],
    saved: [],
    version: 5,
    pending: true,
    stamp: adopted.route.stamp,
    remote: { completed: [1], saved: ["trial_011"], version: 5, updatedAt: "2026-11-10T21:00:00.000Z" },
  }));
  const kept = adoptStoredServerRoute({ storage: browser, storageKey: ownKey, professionKey: PROFESSION });
  assert.deepEqual(kept.completed, [1]);
  assert.equal(kept.remote, null);
  assert.equal(JSON.parse(browser.getItem(ownKey.replace("vector-route-v2-", "vector-route-v2-legacy-")) ?? "{}").completed[0], 2);
});

test("demo students and the own session keep separate routes", async () => {
  const firstKey = routeStorageKey({ mode: "demo", studentId: 1 }, null);
  const secondKey = routeStorageKey({ mode: "demo", studentId: 2 }, null);
  const ownKey = routeStorageKey({ mode: "own" }, null);
  const browser = storage({
    "vector-session-demo-1": DEMO_ONE,
    "vector-session-demo-2": DEMO_TWO,
    "X-Session-ID": OWN,
    [firstKey]: JSON.stringify({ completed: [0], saved: ["program:prog_001"], pending: true, stamp: 1 }),
    [secondKey]: JSON.stringify({ completed: [2], saved: ["program:prog_010"], pending: true, stamp: 1 }),
    [ownKey]: JSON.stringify({ completed: [4], saved: [], pending: true, stamp: 1 }),
  });
  const { calls, fetchImpl } = fetchFor((url, init) => {
    assert.equal(init?.body ? JSON.parse(String(init.body)).sessionId : undefined, undefined);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return {
        status: 201,
        body: { professionKey: "none", completed: body.completed, saved: body.saved, version: 1, updatedAt: "2026-11-10T18:00:00.000Z" },
      };
    }
    return { status: 404, body: { error: "Education route not found" } };
  });
  await persistEducationRoute({ scope: { mode: "demo", studentId: 1 }, storage: browser, storageKey: firstKey, professionKey: "none", fetchImpl });
  assert.equal(new Headers(calls[0].init?.headers).get("X-Session-ID"), DEMO_ONE);
  assert.equal(JSON.parse(browser.getItem(secondKey) ?? "{}").completed[0], 2);
  assert.equal(JSON.parse(browser.getItem(ownKey) ?? "{}").completed[0], 4);
  const own = await restoreEducationRoute({ scope: { mode: "own" }, storage: browser, storageKey: ownKey, professionKey: "none", fetchImpl });
  assert.equal(new Headers(calls.at(-1)?.init?.headers).get("X-Session-ID"), OWN);
  assert.deepEqual(own.route.completed, [4]);
});

test("reload, an unavailable API, and an old local route keep the local copy", async () => {
  const ownKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const legacy = JSON.stringify({ completed: [1], saved: ["program:prog_035"] });
  const browser = storage({ "X-Session-ID": OWN, [ownKey]: legacy });
  const down = fetchFor(() => { throw new Error("offline"); });
  const offline = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: down.fetchImpl,
  });
  assert.equal(offline.notice, ROUTE_UNSYNCED_NOTICE);
  assert.equal(browser.getItem(ownKey), legacy);

  const outdated = fetchFor(() => ({ status: 503, body: { error: "Database schema is outdated. Run npm run db:migrate" } }));
  const schema = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: outdated.fetchImpl,
  });
  assert.equal(schema.notice, ROUTE_SCHEMA_NOTICE);
  assert.equal(browser.getItem(ownKey), legacy);

  const uploaded = fetchFor((url, init) => init?.method === "PUT"
    ? { status: 201, body: { professionKey: PROFESSION, completed: [1], saved: ["program:prog_035"], version: 1, updatedAt: "2026-11-10T18:10:00.000Z" } }
    : { status: 404, body: { error: "Education route not found" } });
  const firstSync = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: uploaded.fetchImpl,
  });
  assert.equal(firstSync.route.version, 1);
  assert.equal(browser.getItem(legacyRouteStorageKey(ownKey)), legacy);

  const reload = fetchFor(() => ({ status: 200, body: { professionKey: PROFESSION, completed: [1], saved: ["program:prog_035"], version: 1, updatedAt: "2026-11-10T18:10:00.000Z" } }));
  const again = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl: reload.fetchImpl,
  });
  assert.equal(again.notice, "");
  assert.equal(reload.calls.some((call) => call.url.includes("generate")), false);
});

test("a different old route stays beside the newer server copy", async () => {
  const ownKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const legacy = JSON.stringify({ completed: [2], saved: ["program:prog_006"] });
  const browser = storage({ "X-Session-ID": OWN, [ownKey]: legacy });
  const { fetchImpl } = fetchFor(() => ({
    status: 200,
    body: { professionKey: PROFESSION, completed: [0], saved: ["program:prog_001"], version: 4, updatedAt: "2026-11-10T20:00:00.000Z" },
  }));
  const restored = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: ownKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.equal(restored.notice, ROUTE_LEGACY_NOTICE);
  assert.deepEqual(restored.route.completed, [0]);
  assert.equal(browser.getItem(legacyRouteStorageKey(ownKey)), legacy);
});

test("catalog ids sync for every age band and an unknown id stays local", async () => {
  assert.equal(showsProfessions(3), false);
  assert.equal(showsProfessions(7), true);
  assert.equal(showsProfessions(10), true);
  assert.equal(showsEducationPrograms(3), false);
  assert.equal(showsEducationPrograms(7), false);
  assert.equal(showsEducationPrograms(10), true);
  const cases = [
    { grade: 3, profession: null, saved: [] as string[] },
    { grade: 7, profession: PROFESSION, saved: ["trial_011"] },
    { grade: 10, profession: PROFESSION, saved: ["program:prog_024"] },
  ];
  for (const item of cases) {
    const key = routeStorageKey({ mode: "own" }, item.profession);
    const browser = storage({
      "X-Session-ID": OWN,
      [key]: JSON.stringify({ completed: [0], saved: item.saved, pending: true, version: null, stamp: 1 }),
    });
    const remote = fetchFor((url, init) => {
      if (init?.method !== "PUT") {
        assert.equal(url.includes("professionKey=" + encodeURIComponent(item.profession ?? "none")), true);
        return { status: 404, body: { error: "Education route not found" } };
      }
      const body = JSON.parse(String(init.body));
      assert.equal(body.professionKey, item.profession ?? "none");
      return { status: 201, body: { professionKey: body.professionKey, completed: body.completed, saved: body.saved, version: 1, updatedAt: "2026-11-10T18:00:00.000Z" } };
    });
    const restored = await restoreEducationRoute({
      scope: { mode: "own" },
      storage: browser,
      storageKey: key,
      professionKey: item.profession ?? "none",
      fetchImpl: remote.fetchImpl,
    });
    assert.equal(restored.route.version, 1);
    assert.equal(remote.calls.some((call) => call.url.includes("generate")), false);
  }
  const invalidKey = routeStorageKey({ mode: "own" }, PROFESSION);
  const browser = storage({
    "X-Session-ID": OWN,
    [invalidKey]: JSON.stringify({ completed: [1], saved: ["Свободный текст маршрута"], pending: true, stamp: 1 }),
  });
  const { calls, fetchImpl } = fetchFor(() => ({ status: 404, body: { error: "Education route not found" } }));
  const invalid = await restoreEducationRoute({
    scope: { mode: "own" },
    storage: browser,
    storageKey: invalidKey,
    professionKey: PROFESSION,
    fetchImpl,
  });
  assert.equal(invalid.notice, ROUTE_INVALID_ID_NOTICE);
  assert.equal(calls.some((call) => call.init?.method === "PUT"), false);
  assert.equal(JSON.parse(browser.getItem(invalidKey) ?? "{}").saved[0], "Свободный текст маршрута");
});
