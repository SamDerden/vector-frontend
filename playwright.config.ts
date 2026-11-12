import { defineConfig } from "@playwright/test";

const standUrl = "postgresql://generation_stand:generation_stand_local_only@127.0.0.1:55432/vector_prof_generation_stand";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "e2e/logs/test-results",
  use: {
    baseURL: "http://127.0.0.1:3101",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: [
    {
      command: "node e2e/start-backend.mjs",
      url: "http://127.0.0.1:3100/api/health",
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        GENERATION_STAND: "isolated",
        GENERATION_STAND_DATABASE_URL: standUrl,
      },
    },
    {
      command: "node e2e/start-frontend.mjs",
      url: "http://127.0.0.1:3101",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
