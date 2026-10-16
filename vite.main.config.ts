import { defineConfig } from "vite";

// Playwright ships native drivers + dynamic requires (chromium-bidi) that a
// bundler cannot inline — keep it as a runtime dependency resolved from
// node_modules in dev and in the packaged app (forge ships `dependencies`).
export default defineConfig({
  build: {
    rolldownOptions: {
      external: ["playwright", "playwright-core"],
    },
  },
});
