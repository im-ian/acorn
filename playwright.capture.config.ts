import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.ACORN_CAPTURE_PORT ?? 1421);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/captures",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: `pnpm run dev --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
