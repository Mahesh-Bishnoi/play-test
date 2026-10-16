import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // Floor per clean-code §7: a suite ships with an enforced gate.
      // WSs raise these as real logic lands; 0 today keeps the gate honest
      // until src/ exists (no silently-absent coverage).
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
  },
});
