import { defineConfig } from "vite";

// Playwright ships native drivers + dynamic requires (chromium-bidi) that a
// bundler cannot inline; better-sqlite3's loader resolves its .node binary
// relative to its own package dir, which breaks once bundled (it would look
// next to the bundle). Keep both as runtime dependencies resolved from
// node_modules in dev and in the packaged app (forge ships `dependencies`).
// The regex also covers the `playwright/test` subpath (web-first `expect`
// matchers) that an exact-match entry would inline.
export default defineConfig({
  build: {
    rolldownOptions: {
      external: [/^playwright($|\/)/, "playwright-core", "better-sqlite3"],
    },
  },
});
