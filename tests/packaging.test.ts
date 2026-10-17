import { describe, expect, it } from "vitest";

import forgeConfig from "../forge.config.js";
import mainViteConfig from "../vite.main.config.js";

/**
 * Packaging regression test: every package the main bundle treats as
 * `external` must survive into the packaged app, otherwise the shipped
 * `main.cjs` crashes on boot with `Cannot find module '<pkg>'` (seen with
 * `playwright`: the Vite plugin's default ignore keeps only `/.vite`).
 */
function externals(): Array<string | RegExp> {
  const ext = mainViteConfig.build?.rolldownOptions?.external;
  return Array.isArray(ext) ? ext : [];
}

/** Runtime deps the packaged app must resolve from node_modules. */
const RUNTIME_PACKAGES = ["playwright", "playwright-core", "better-sqlite3"];

function isExternal(specifier: string): boolean {
  return externals().some((entry) =>
    typeof entry === "string" ? entry === specifier : entry.test(specifier),
  );
}

function ignore(): (file: string) => boolean {
  const fn = forgeConfig.packagerConfig?.ignore;
  if (typeof fn !== "function") throw new Error("packagerConfig.ignore is not set");
  return fn as (file: string) => boolean;
}

describe("packaged app ships runtime deps for externals", () => {
  it("declares externals in the main vite config", () => {
    for (const pkg of RUNTIME_PACKAGES) {
      expect(isExternal(pkg)).toBe(true);
    }
    // M13: assertions import `expect` from the `playwright/test` subpath —
    // an exact-match entry would inline it instead of resolving at runtime.
    expect(isExternal("playwright/test")).toBe(true);
  });

  it("keeps the built output and package.json", () => {
    expect(ignore()("/.vite/build/main.cjs")).toBe(false);
    expect(ignore()("/package.json")).toBe(false);
  });

  it("keeps node_modules for every external", () => {
    for (const pkg of RUNTIME_PACKAGES) {
      expect(ignore()(`/node_modules/${pkg}/package.json`)).toBe(false);
    }
  });

  it("unpacks native bindings so they can be dlopened from the asar", () => {
    const asar = forgeConfig.packagerConfig?.asar;
    expect(JSON.stringify(asar ?? "")).toContain(".node");
  });
});
