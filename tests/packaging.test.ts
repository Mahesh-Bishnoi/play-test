import { describe, expect, it } from "vitest";

import forgeConfig from "../forge.config.js";
import mainViteConfig from "../vite.main.config.js";

/**
 * Packaging regression test: every package the main bundle treats as
 * `external` must survive into the packaged app, otherwise the shipped
 * `main.cjs` crashes on boot with `Cannot find module '<pkg>'` (seen with
 * `playwright`: the Vite plugin's default ignore keeps only `/.vite`).
 */
function externals(): string[] {
  const ext = mainViteConfig.build?.rolldownOptions?.external;
  return Array.isArray(ext) ? ext.filter((e): e is string => typeof e === "string") : [];
}

function ignore(): (file: string) => boolean {
  const fn = forgeConfig.packagerConfig?.ignore;
  if (typeof fn !== "function") throw new Error("packagerConfig.ignore is not set");
  return fn as (file: string) => boolean;
}

describe("packaged app ships runtime deps for externals", () => {
  it("declares externals in the main vite config", () => {
    expect(externals()).toContain("playwright");
  });

  it("keeps the built output and package.json", () => {
    expect(ignore()("/.vite/build/main.cjs")).toBe(false);
    expect(ignore()("/package.json")).toBe(false);
  });

  it("keeps node_modules for every external", () => {
    for (const ext of externals()) {
      expect(ignore()(`/node_modules/${ext}/package.json`)).toBe(false);
    }
  });

  it("unpacks native bindings so they can be dlopened from the asar", () => {
    const asar = forgeConfig.packagerConfig?.asar;
    expect(JSON.stringify(asar ?? "")).toContain(".node");
  });
});
