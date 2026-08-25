import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 1420);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // WebKit approximates the WKWebView the shipped app runs in. Scoped to
    // the scroll perf probe and opt-in (CI installs chromium only):
    //   PERF_WEBKIT=1 playwright test terminal-scroll-perf
    ...(process.env.PERF_WEBKIT
      ? [
          {
            name: "webkit-perf",
            use: { ...devices["Desktop Safari"] },
            testMatch: /terminal-scroll-perf/,
          },
        ]
      : []),
  ],
  webServer: {
    command: `pnpm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
