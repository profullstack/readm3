import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  fullyParallel: true,
  workers: 3,
  timeout: 30_000,
  use: {
    baseURL: process.env.READM3_TEST_URL || "http://127.0.0.1:4318",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: process.env.READM3_TEST_URL ? undefined : {
    command: "bun run site:build && PORT=4318 bun site/server.ts",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: "http://127.0.0.1:4318/viewer",
    reuseExistingServer: false,
  },
});
