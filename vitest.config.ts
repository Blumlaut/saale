import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
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
    },
    include: ["__tests__/**/*.test.{ts,tsx}"],
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
