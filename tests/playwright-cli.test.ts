import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPlaywrightCliSpawn, resolvePlaywrightCli } from "../src/main/playwright-cli.js";

describe("Playwright CLI resolution (review F1)", () => {
  it("resolves the installed package's cli.js despite the exports map", () => {
    const cliPath = resolvePlaywrightCli();
    expect(cliPath).not.toBeNull();
    expect(basename(cliPath ?? "")).toBe("cli.js");
    expect(existsSync(cliPath ?? "")).toBe(true);
    // The package root sits next to the CLI; `package.json` is the exported
    // path used to find it (Playwright does not export `./cli.js`).
    expect(existsSync(`${dirname(cliPath ?? "")}/package.json`)).toBe(true);
  });

  it("keeps the Electron-as-Node launch line for install and codegen", () => {
    const built = buildPlaywrightCliSpawn("/app/node_modules/playwright/cli.js", [
      "install",
      "chromium",
    ]);
    expect(built.command).toBe(process.execPath);
    expect(built.args).toEqual(["/app/node_modules/playwright/cli.js", "install", "chromium"]);
    expect(built.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });
});
