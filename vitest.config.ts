import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      // Floor per clean-code §7: set just under measured coverage (2026-10:
      // ~42% lines / ~42% statements / ~36% branches / ~30% functions with
      // tsx included) so the gate fails on real regression, not decoration.
      // Raise these as tested surface grows — never lower.
      thresholds: { lines: 41, functions: 29, branches: 35, statements: 40 },
    },
  },
});
