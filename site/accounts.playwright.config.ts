import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test", testMatch: "accounts.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:4321", ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: { command: "bun run site:build && bun site/test/account-server.ts", cwd: fileURLToPath(new URL("..", import.meta.url)), url: "http://127.0.0.1:4321/account", reuseExistingServer: false },
});
