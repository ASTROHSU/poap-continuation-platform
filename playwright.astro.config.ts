import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser-astro",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "line",
  outputDir: "test-results/playwright-astro",
  use: {
    baseURL: "http://127.0.0.1:4322",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm --prefix frontend-astro run dev -- --host 127.0.0.1 --port 4322",
    url: "http://127.0.0.1:4322",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ASTRO_DEV_BACKGROUND: "0",
    },
  },
});
