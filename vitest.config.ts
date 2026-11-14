import { defineConfig } from "vitest/config";
import path from "path";

/** The test files that need a real process of their own. */
const PROCESS_POOL_FILES = ["__tests__/lib/sandbox/workspace.test.ts"];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // A worker thread starts in a fraction of the time a forked process does,
    // and every test file pays that startup: the suite runs about a quarter
    // faster on the threads pool. A thread shares its process with its siblings,
    // so the few files that call a process-wide API (`process.umask`) get a
    // process of their own instead.
    pool: "threads",
    // Measured on an 8-core machine: one worker per core (the default) takes
    // ~257s for the full suite while two workers take ~141s. Beyond ~4 workers
    // the suite slows down instead of speeding up (contention between worker
    // processes and the main-process Vite server) and even starts to flake
    // (timing-sensitive tests time out under the load). Two workers is the
    // fastest and most stable; raise it if this ever runs on dedicated cores.
    maxWorkers: 2,
    // Tests must always run in test mode — a shell-level NODE_ENV=production
    // (or similar) would load React's production build, which strips `act`
    // and breaks @testing-library/react rendering.
    env: {
      NODE_ENV: "test",
      // better-auth's per-address limit allows three sign-in requests per ten
      // seconds. Auth tests make more than that from one address, and none of
      // them are about the limit.
      AUTH_RATE_LIMIT: "off",
    },
    projects: [
      {
        test: {
          name: "process",
          pool: "forks",
          include: PROCESS_POOL_FILES,
        },
      },
      {
        test: {
          name: "tests",
          include: ["__tests__/**/*.test.{ts,tsx}"],
          exclude: PROCESS_POOL_FILES,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/app/**", "src/components/**", "src/**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
