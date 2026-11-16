import { defineConfig, devices } from "@playwright/test";

/*
 * E2E against the static export (`out/`) in browser mock mode: outside Tauri
 * the app runs on the `layerMock` services. Chromium stands in for WebView2,
 * WebKit for WKWebView. `E2E_SKIP_BUILD=1` serves an existing `out/`.
 */

const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);
const skipBuild = process.env.E2E_SKIP_BUILD === "1";

export default defineConfig({
  // The mocks simulate real work with timers (model download, brief build).
  expect: { timeout: 15_000 },
  forbidOnly: isCI,
  fullyParallel: true,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  retries: isCI ? 1 : 0,
  testDir: "e2e",
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: skipBuild
      ? "bun scripts/serve-out.ts"
      : "bun run build && bun scripts/serve-out.ts",
    env: { PORT: String(PORT) },
    reuseExistingServer: !isCI,
    timeout: 300_000,
    url: BASE_URL,
  },
});
