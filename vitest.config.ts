import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Tests must always run in test mode — a shell-level NODE_ENV=production
    // (or similar) would load React's production build, which strips `act`
    // and breaks @testing-library/react rendering.
    env: {
      NODE_ENV: "test",
    },
    include: ["__tests__/**/*.test.{ts,tsx}"],
    isolate: false,
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
