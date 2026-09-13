import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const testPort = Number(process.env.READM3_TEST_PORT || 4318);

export default defineConfig({
  testDir: "./test",
  testIgnore: "accounts.spec.ts",
  fullyParallel: true,
  workers: 3,
  timeout: 30_000,
  use: {
    baseURL: process.env.READM3_TEST_URL || `http://127.0.0.1:${testPort}`,
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: process.env.READM3_TEST_URL ? undefined : {
    command: `bun run site:build && PORT=${testPort} READM3_DB=:memory: READM3_ADMIN_BOOTSTRAP_SECRET=browser-test-admin-secret bun site/test/account-server.ts`,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: `http://127.0.0.1:${testPort}/viewer`,
    reuseExistingServer: false,
  },
});
