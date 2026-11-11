import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

test.describe.configure({ mode: "serial" });

function guardLocal(page: Page) {
  page.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      throw new Error(`Blocked a non-local browser request to ${hostname}`);
    }
  });
}

async function answerOwnJourney(page: Page, grade: number) {
  guardLocal(page);
  await page.goto("/");
  const card = grade <= 4 ? /1–4 классы/ : grade <= 8 ? /5–8 классы/ : /9–11 классы/;
  await page.getByRole("button", { name: card }).click();
  await page.locator("#grade").selectOption(String(grade));
  if (grade > 4) await page.getByRole("button", { name: "Не знаю, с чего начать" }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  for (let step = 0; step < 40; step += 1) {
    const panel = page.locator(".diagnostic-panel");
    await expect(panel).toBeVisible();
    const option = panel.locator(".option-list button").first();
    const input = panel.getByLabel("Твой ответ");
    if (await option.count()) await option.click();
    else await input.fill("синтетический ответ стенда");
    const next = panel.getByRole("button", { name: /Перейти к 6 уточнениям|Далее/ });
    await expect(next).toBeEnabled();
    const label = await next.innerText();
    await next.click();
    if (label.includes("уточнениям")) break;
    if (step === 39) throw new Error("Diagnostic did not finish");
  }
  for (let step = 0; step < 6; step += 1) {
    const choice = page.locator(".illustrated-option").first();
    await expect(choice).toBeVisible();
    await choice.click();
    const next = page.locator(".demo-quiz-actions").getByRole("button", { name: /Завершить опрос|Далее/ });
    await expect(next).toBeEnabled();
    await next.click();
  }
}

async function expectResult(page: Page, grade: number) {
  if (grade <= 4) await expect(page.getByRole("heading", { name: "Тебе интересно многое!" })).toBeVisible({ timeout: 90_000 });
  else await expect(page.getByRole("heading", { name: "Мой профиль интересов" })).toBeVisible({ timeout: 90_000 });
}

test("grades 1–4 save a catalog result, reflection and cookie without a second generation", async ({ page }) => {
  let generations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/recommendations/generate")) generations += 1;
  });
  await answerOwnJourney(page, 2);
  await expectResult(page, 2);
  await expect(page.getByText("Рекомендации собраны по каталогу")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Мои профессиональные гипотезы" })).toHaveCount(0);
  const steps = page.locator(".primary-world-steps");
  await steps.getByRole("button", { name: "Что попробовать" }).click();
  await steps.getByRole("button", { name: "Мой маршрут" }).click();
  await steps.getByRole("button", { name: "Дневник открытий" }).click();
  await page.getByRole("button", { name: "Завершить путешествие" }).click();
  await expect(page.getByText("Рефлексия сохранена на сервере.")).toBeVisible();
  const proof = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("vector_session_proof_"));
  expect(proof.length).toBeGreaterThan(0);
  expect(proof.every((cookie) => cookie.httpOnly && cookie.sameSite === "Strict")).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Моя карта открытий" })).toBeVisible();
  await expect(page.getByText("Рефлексия сохранена на сервере.")).toBeVisible();
  expect(generations).toBe(1);

  const withoutCookie = await page.evaluate(async () => {
    const session = localStorage.getItem("X-Session-ID");
    const response = await fetch("/api/session", {
      headers: session ? { "X-Session-ID": session } : {},
      credentials: "omit",
    });
    return response.status;
  });
  expect(withoutCookie).toBe(403);
  const withCookie = await page.evaluate(async () => {
    const session = localStorage.getItem("X-Session-ID");
    const response = await fetch("/api/session", {
      headers: session ? { "X-Session-ID": session } : {},
      credentials: "include",
    });
    return response.status;
  });
  expect(withCookie).toBe(200);
});

test("grades 5–8 recover a 202 result after reload without another generation", async ({ page }) => {
  let generations = 0;
  const jobGate: { release: () => void } = { release() {} };
  const jobHeld = new Promise<void>((resolve) => {
    jobGate.release = resolve;
  });
  let heldJob = false;
  let serverAccepted = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/recommendations/generate")) generations += 1;
  });
  await page.route("**/api/recommendations/generate", async (route) => {
    const real = await route.fetch();
    const body = await real.json();
    serverAccepted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: body.requestId,
        jobStatus: "running",
        status: "in_progress",
        retryAfterMs: 300,
      }),
    });
  });
  await page.route("**/api/recommendations/jobs/**", async (route) => {
    if (!heldJob) {
      heldJob = true;
      await jobHeld;
    }
    await route.continue();
  });
  await answerOwnJourney(page, 7);
  await expect.poll(() => serverAccepted, { timeout: 90_000 }).toBe(true);
  await expect(page.getByText("Формируем персональные рекомендации")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  jobGate.release();
  await expectResult(page, 7);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Мой профиль интересов" })).toBeVisible();
  expect(generations).toBe(1);
});

test("grades 9–11 keep an education route and show a 409 conflict", async ({ page }) => {
  let expiredOnce = false;
  await page.route("**/api/recommendations/generate", async (route) => {
    if (!expiredOnce) {
      expiredOnce = true;
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session expired. Start a new session." }),
      });
      return;
    }
    await route.continue();
  });
  await answerOwnJourney(page, 10);
  await expectResult(page, 10);
  await page.getByRole("button", { name: "Посмотреть профессиональные гипотезы" }).click();
  await page.getByRole("button", { name: "Изучить профессию" }).first().click();
  await page.getByRole("button", { name: "Образовательные программы" }).click();
  await page.getByRole("button", { name: "Мой профессиональный маршрут" }).click();
  await page.getByRole("button", { name: "Открыть этап" }).first().click();
  await page.getByRole("button", { name: "Отметить как пройденный" }).click();
  await expect(page.getByText("1 / 5")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Посмотреть профессиональные гипотезы" }).click();
  await page.getByRole("button", { name: "Изучить профессию" }).first().click();
  await page.getByRole("button", { name: "Образовательные программы" }).click();
  await page.getByRole("button", { name: "Мой профессиональный маршрут" }).click();
  await expect(page.getByText("1 / 5")).toBeVisible();

  await page.route("**/api/education-route", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Version conflict",
          details: {
            route: {
              professionKey: "none",
              completed: [4],
              saved: [],
              version: 3,
              updatedAt: "2026-11-11T12:00:00.000Z",
            },
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Открыть этап" }).nth(1).click();
  await page.getByRole("button", { name: "Отметить как пройденный" }).click();
  await expect(page.getByText("На сервере более новая версия маршрута")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить мою версию" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Оставить серверную версию" })).toBeVisible();
});

test("the browser explains 429, 502 and a session that stays expired", async ({ page }) => {
  let mode: "429" | "502" | "410" = "429";
  await page.route("**/api/recommendations/generate", async (route) => {
    const status = mode === "429" ? 429 : mode === "502" ? 502 : 410;
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: status === 429 ? { "Retry-After": "60" } : {},
      body: JSON.stringify({ error: "synthetic", details: { errorCode: "pipeline_failed" } }),
    });
  });
  await answerOwnJourney(page, 6);
  await expect(page.getByText("Сейчас слишком много запросов. Подожди минуту и повтори.")).toBeVisible();
  mode = "502";
  await page.getByRole("button", { name: "Повторить анализ" }).click();
  await expect(page.getByText("Не удалось собрать рекомендации. Попробуй ещё раз.")).toBeVisible();
  mode = "410";
  await page.getByRole("button", { name: "Повторить анализ" }).click();
  await expect(page.getByText("Session expired")).toBeVisible();
});

test("a foreign session is rejected and the stub log has no gateway call", async ({ request }) => {
  const response = await request.post("http://127.0.0.1:3100/api/recommendations/generate", {
    headers: {
      "X-Session-ID": "00000000-0000-4000-8000-000000000099",
      "Idempotency-Key": "00000000-0000-4000-8000-000000000098",
    },
    data: {},
  });
  expect(response.status()).toBe(403);
  const health = await request.get("http://127.0.0.1:3100/api/health");
  expect(health.status()).toBe(200);
  const body = await health.json();
  expect(body.database).toBe("connected");
  expect(body.generationWorker).toBe(false);
  const log = fs.readFileSync("e2e/logs/backend.log", "utf8");
  expect(log).not.toMatch(/chat\/completions|\/embeddings|Bearer /);
  expect(log).toContain("Не заданы LLM_BASE_URL");
});
