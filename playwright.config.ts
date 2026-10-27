import { defineConfig, devices } from "@playwright/test";

import { BASE_URL, PORT, SESSION_FILE } from "./e2e/env";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Every worker drives the same Next server, and a dev server compiles a route
  // on its first hit. Past two workers the compiles queue and the run gets
  // slower, not faster.
  workers: isCI ? 2 : 4,
  reporter: isCI ? [["github"], ["line"]] : "line",
  // One budget for every suite: a wait that hangs fails its own test instead of
  // eating the run. Generous enough for a dev server compiling a route on its
  // first hit; the suites with a slower step (a live chat turn) raise it.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // Signs in once and seeds the shared fixtures (see `e2e/global-setup.ts`).
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    // Signed-in state for every context and page, so a spec starts at the page
    // it measures. `pwa.spec.ts` opts out where it needs a signed-out browser.
    storageState: SESSION_FILE,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Reuses whatever already answers on the port (the checkout's dev server),
  // so iterating on one spec costs nothing. `E2E_SERVER=dev` keeps it a dev
  // server; the default builds a production one, which is what makes a full
  // run fast.
  webServer: {
    command: "sh scripts/e2e-server.sh",
    url: BASE_URL,
    env: { PORT: String(PORT), E2E_SERVER: process.env.E2E_SERVER ?? "prod" },
    reuseExistingServer: !isCI,
    timeout: 300_000,
  },
});
